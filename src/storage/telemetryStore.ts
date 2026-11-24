/**
 * TelemetryStore —— 遥测历史持久化仓储
 *
 * 职责(且只有这些):
 *   1. 建库/迁移
 *   2. 追加一条采样(原始明细 + 小时聚合 + 最新快照, 单事务)
 *   3. 按时间范围查历史(自动在 明细/分桶/小时聚合 之间选源)
 *   4. 区间统计摘要 / 库容量统计 / 过期清理
 *
 * 不负责: 采集、调度、告警判定、单位转换 —— 那些属于各自的模块。
 *
 * 写入策略选择「同步直写」而不是内存队列:
 *   采样间隔 30s, 一周也才 2 万行, 单次写入 <1ms。
 *   队列带来的复杂度(丢失窗口、崩溃回放)远大于收益。
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';
import type { TelemetryData } from '../core/dishClient';
import type { HandoffEvent } from '../core/outageAnalyzer';
import type { OutageCause } from '../core/outageTypes';
import {
  DDL,
  SATELLITE_HANDOFFS_DDL,
  SAMPLE_INTERVAL_MS,
  SAMPLE_RETENTION_DAYS,
  HOURLY_RETENTION_DAYS,
  HANDOFF_RETENTION_DAYS,
} from './schema';
import { ESTIMATED_BYTES_SQL } from './summarySql';
import type {
  HistoryQuery,
  HistorySample,
  HistorySummary,
  PruneResult,
  StorageStats,
  TimestampedTelemetry,
  ObstructionEvent,
} from './types';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * 采样字段映射表: 数据库列名 ⇄ TelemetryData 字段名。
 * 新增一个指标只改这一处, INSERT / SELECT / 建表列名都从这里派生。
 */
const SAMPLE_FIELDS = [
  { column: 'state', key: 'state' },
  { column: 'latency_ms', key: 'popPingLatencyMs' },
  { column: 'drop_rate', key: 'popPingDropRate' },
  { column: 'down_bps', key: 'downlinkThroughputBps' },
  { column: 'up_bps', key: 'uplinkThroughputBps' },
  { column: 'snr', key: 'snr' },
  { column: 'fraction_obstructed', key: 'fractionObstructed' },
  { column: 'currently_obstructed', key: 'currentlyObstructed' },
  { column: 'satellite_id', key: 'satelliteId' },
  { column: 'uptime_s', key: 'uptime' },
  { column: 'dish_temp_c', key: 'dishTemperature' },
  { column: 'psu_temp_c', key: 'powerSupplyTemperature' },
  { column: 'public_ping_ms', key: 'publicPingLatencyMs' },
  { column: 'local_gateway_ms', key: 'localGatewayLatencyMs' },
  { column: 'class_of_service', key: 'classOfService' },
  { column: 'disablement_code', key: 'disablementCode' },
  { column: 'alerts_json', key: 'alerts', transform: (v: unknown) => v ? JSON.stringify(v) : null },
] as const;

/** better-sqlite3 不接受 boolean/undefined, 统一归一化 */
function toSqlValue(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** 任意时间表示 -> epoch ms */
function toEpochMs(value: Date | number | string | undefined): number {
  if (value === undefined) return Date.now();
  if (typeof value === 'number') return value;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/**
 * 决定分桶粒度。返回 0 表示不分桶(直接返回原始点)。
 * 对齐到整秒, 让图表 X 轴刻度干净。
 */
function pickBucketMs(spanMs: number, maxPoints: number, minBucketMs: number): number {
  const ideal = Math.ceil(spanMs / Math.max(1, maxPoints));
  if (ideal <= minBucketMs) return 0;
  return Math.ceil(ideal / 1000) * 1000;
}

/**
 * 解析数据库路径。
 *
 * `app` 用动态 require 拿 —— 顶层 import 'electron' 会让这个模块在
 * Node 环境(测试脚本、CLI)里直接炸掉, 而 electron 只是个可选项:
 * 只有在没给显式路径时才需要它。
 */
function resolveDbPath(explicit?: string): string {
  if (explicit) {
    if (explicit !== ':memory:') {
      fs.mkdirSync(path.dirname(explicit), { recursive: true });
    }
    return explicit;
  }

  // 延迟加载: 只有走到默认路径才需要 electron
  const nodeRequire = createRequire(import.meta.url);
  const { app } = nodeRequire('electron') as typeof import('electron');
  const dir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'telemetry.db');
}

export class TelemetryStore {
  private db: Database.Database;
  private readonly dbPath: string;

  private readonly insertSample: Database.Statement;
  private readonly upsertHourly: Database.Statement;
  private readonly upsertSnapshot: Database.Statement;
  private readonly upsertObstruction: Database.Statement;
  private readonly selectSnapshot: Database.Statement;
  private readonly selectObstruction: Database.Statement;

  private readonly selectRaw: Database.Statement;
  private readonly selectBucketed: Database.Statement;
  private readonly selectHourly: Database.Statement;
  private readonly selectSummary: Database.Statement;
  private readonly selectEstimatedBytes: Database.Statement;
  private readonly selectOutages: Database.Statement;

  private readonly appendTx: (point: TimestampedTelemetry) => void;

  constructor(dbPath?: string) {
    this.dbPath = resolveDbPath(dbPath);
    this.db = new Database(this.dbPath);

    // WAL: 读写不互相阻塞; NORMAL: 断电最多丢最后一个事务, 对监控数据足够
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(DDL);
    this.migrate();

    const columns = SAMPLE_FIELDS.map((f) => f.column).join(', ');
    const placeholders = SAMPLE_FIELDS.map(() => '?').join(', ');

    this.insertSample = this.db.prepare(`
      INSERT OR REPLACE INTO telemetry_samples (ts, ${columns})
      VALUES (?, ${placeholders})
    `);

    // 增量维护小时聚合: 用旧 sample_count 做滑动平均, MAX/MIN 直接比较。
    // SQLite 的 SET 表达式全部基于赋值前的旧行值求值, 所以这里安全。
    // state 分布用累加秒数(假设采样间隔 30s)。
    this.upsertHourly = this.db.prepare(`
      INSERT INTO telemetry_hourly (
        bucket_ts, sample_count,
        latency_avg, latency_max, latency_min,
        drop_avg, drop_max,
        down_avg, down_max,
        up_avg, up_max,
        obstructed_avg, snr_avg,
        online_sec, offline_sec, searching_sec, booting_sec,
        public_ping_avg, public_ping_max,
        local_gateway_avg, local_gateway_max
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bucket_ts) DO UPDATE SET
        latency_avg    = (latency_avg * sample_count + excluded.latency_avg) / (sample_count + 1),
        latency_max    = MAX(latency_max, excluded.latency_max),
        latency_min    = MIN(latency_min, excluded.latency_min),
        drop_avg       = (drop_avg * sample_count + excluded.drop_avg) / (sample_count + 1),
        drop_max       = MAX(drop_max, excluded.drop_max),
        down_avg       = (down_avg * sample_count + excluded.down_avg) / (sample_count + 1),
        down_max       = MAX(down_max, excluded.down_max),
        up_avg         = (up_avg * sample_count + excluded.up_avg) / (sample_count + 1),
        up_max         = MAX(up_max, excluded.up_max),
        obstructed_avg = (obstructed_avg * sample_count + excluded.obstructed_avg) / (sample_count + 1),
        snr_avg        = (snr_avg * sample_count + excluded.snr_avg) / (sample_count + 1),
        online_sec     = online_sec + excluded.online_sec,
        offline_sec    = offline_sec + excluded.offline_sec,
        searching_sec  = searching_sec + excluded.searching_sec,
        booting_sec    = booting_sec + excluded.booting_sec,
        public_ping_avg = CASE 
          WHEN excluded.public_ping_avg IS NOT NULL AND public_ping_avg IS NOT NULL 
          THEN (public_ping_avg * sample_count + excluded.public_ping_avg) / (sample_count + 1)
          WHEN excluded.public_ping_avg IS NOT NULL 
          THEN excluded.public_ping_avg
          ELSE public_ping_avg
        END,
        public_ping_max = CASE
          WHEN excluded.public_ping_max IS NOT NULL AND public_ping_max IS NOT NULL
          THEN MAX(public_ping_max, excluded.public_ping_max)
          WHEN excluded.public_ping_max IS NOT NULL
          THEN excluded.public_ping_max
          ELSE public_ping_max
        END,
        local_gateway_avg = CASE 
          WHEN excluded.local_gateway_avg IS NOT NULL AND local_gateway_avg IS NOT NULL 
          THEN (local_gateway_avg * sample_count + excluded.local_gateway_avg) / (sample_count + 1)
          WHEN excluded.local_gateway_avg IS NOT NULL 
          THEN excluded.local_gateway_avg
          ELSE local_gateway_avg
        END,
        local_gateway_max = CASE
          WHEN excluded.local_gateway_max IS NOT NULL AND local_gateway_max IS NOT NULL
          THEN MAX(local_gateway_max, excluded.local_gateway_max)
          WHEN excluded.local_gateway_max IS NOT NULL
          THEN excluded.local_gateway_max
          ELSE local_gateway_max
        END,
        sample_count   = sample_count + 1
    `);

    this.upsertSnapshot = this.db.prepare(`
      INSERT INTO latest_snapshot (id, ts, payload) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, payload = excluded.payload
    `);

    this.upsertObstruction = this.db.prepare(`
      INSERT INTO latest_obstruction_map (id, ts, size, data, source)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        ts = excluded.ts,
        size = excluded.size,
        data = excluded.data,
        source = excluded.source
    `);

    this.selectSnapshot = this.db.prepare('SELECT ts, payload FROM latest_snapshot WHERE id = 1');
    this.selectObstruction = this.db.prepare('SELECT ts, data, source FROM latest_obstruction_map WHERE id = 1');

    // 三个查询都返回同名列(ts/latency_ms/...), 共用同一个 mapper。
    // 注意 satellite_id 只有明细表有, 分桶/小时聚合不 select, 因此保持 null。
    //
    // state 的三种粒度语义:
    //   明细: 真实状态字符串(ONLINE/OFFLINE/...)
    //   分桶: state 不 select, 改用 online_ratio(桶内 ONLINE 采样占比)
    //   小时聚合: 无此数据(表里没存 state), 两者都是 undefined
    this.selectRaw = this.db.prepare(`
      SELECT ts, state, latency_ms, drop_rate, down_bps, up_bps, snr, fraction_obstructed, satellite_id,
             public_ping_ms, local_gateway_ms
      FROM telemetry_samples
      WHERE ts >= ? AND ts < ?
      ORDER BY ts
    `);

    this.selectBucketed = this.db.prepare(`
      SELECT (ts / ?) * ? AS bucket,
             AVG(latency_ms)          AS latency_ms,
             AVG(drop_rate)           AS drop_rate,
             AVG(down_bps)            AS down_bps,
             AVG(up_bps)              AS up_bps,
             AVG(snr)                 AS snr,
             AVG(fraction_obstructed) AS fraction_obstructed,
             AVG(public_ping_ms)      AS public_ping_ms,
             AVG(local_gateway_ms)    AS local_gateway_ms,
             AVG(CASE WHEN state = 'ONLINE' THEN 1.0 ELSE 0.0 END) AS online_ratio,
             -- 各状态在桶内的采样占比 —— 用来画「状态色块条」。
             -- 光有 online_ratio 分不出 SEARCHING / BOOTING / OFFLINE。
             AVG(CASE WHEN state = 'SEARCHING' THEN 1.0 ELSE 0.0 END) AS searching_ratio,
             AVG(CASE WHEN state = 'BOOTING'   THEN 1.0 ELSE 0.0 END) AS booting_ratio,
             AVG(CASE WHEN state = 'OFFLINE'   THEN 1.0 ELSE 0.0 END) AS offline_ratio
      FROM telemetry_samples
      WHERE ts >= ? AND ts < ?
      GROUP BY bucket
      ORDER BY bucket
    `);

    this.selectHourly = this.db.prepare(`
      SELECT (bucket_ts / ?) * ? AS bucket,
             AVG(latency_avg)    AS latency_ms,
             AVG(drop_avg)       AS drop_rate,
             AVG(down_avg)       AS down_bps,
             AVG(up_avg)         AS up_bps,
             AVG(snr_avg)        AS snr,
             AVG(obstructed_avg) AS fraction_obstructed,
             AVG(public_ping_avg) AS public_ping_ms,
             AVG(local_gateway_avg) AS local_gateway_ms,
             SUM(online_sec)     AS online_sec,
             SUM(offline_sec)    AS offline_sec,
             SUM(searching_sec)  AS searching_sec,
             SUM(booting_sec)    AS booting_sec
      FROM telemetry_hourly
      WHERE bucket_ts >= ? AND bucket_ts < ?
      GROUP BY bucket
      ORDER BY bucket
    `);

    this.selectSummary = this.db.prepare(`
      SELECT
        COUNT(*)                                        AS n,
        COALESCE(AVG(latency_ms), 0)                    AS latency_avg,
        COALESCE(MAX(latency_ms), 0)                    AS latency_max,
        COALESCE(MIN(latency_ms), 0)                    AS latency_min,
        COALESCE(AVG(drop_rate), 0)                     AS drop_avg,
        COALESCE(AVG(down_bps), 0)                      AS down_avg,
        COALESCE(AVG(up_bps), 0)                        AS up_avg,
        COALESCE(SUM(CASE WHEN state = 'ONLINE' THEN 1 ELSE 0 END), 0) AS online_n,
        COALESCE(SUM(down_bps), 0)                      AS down_sum,
        COALESCE(SUM(up_bps), 0)                        AS up_sum,
        MIN(ts)                                         AS first_ts,
        MAX(ts)                                         AS last_ts
      FROM telemetry_samples
      WHERE ts >= ? AND ts <= ?
    `);

    this.selectEstimatedBytes = this.db.prepare(ESTIMATED_BYTES_SQL);

    this.selectOutages = this.db.prepare(`
      SELECT COUNT(*) AS outages FROM (
        SELECT state, LAG(state) OVER (ORDER BY ts) AS prev_state
        FROM telemetry_samples
        WHERE ts >= ? AND ts <= ?
      )
      WHERE prev_state = 'ONLINE' AND state <> 'ONLINE'
    `);

    this.appendTx = this.db.transaction((point: TimestampedTelemetry) => {
      this.writeSample(point);
      this.writeHourly(point, toEpochMs(point.timestamp));
      this.writeSnapshot(point);
    });
  }

  // ---------------------------------------------------------------- 写入

  /**
   * 轻量迁移: 给已存在的库补上新增的列和索引。
   *
   * CREATE TABLE IF NOT EXISTS 对已存在的表不会改结构, 所以新增列
   * 必须靠 ALTER TABLE 补。这里只做"缺什么补什么"式的幂等迁移 ——
   * 每次启动都跑一遍, 已有列就跳过。
   *
   * 迁移历史:
   *   v2: latest_obstruction_map.source —— 标记遮挡图是实测还是模拟
   *   v3: telemetry_hourly state 分布列 —— 时长加权在线率
   *   v4: telemetry_samples 性能索引 —— (state, ts) 和 (currently_obstructed, ts)
   *   v5: telemetry_hourly public/local 延迟聚合列
   *   v7: telemetry_samples 告警相关列 —— class_of_service / disablement_code / alerts_json
   *   v8: satellite_handoffs 主键 ts → rtc_ms —— 整表重建
   */
  private migrate(): void {
    try {
      // v2: latest_obstruction_map 增加 source 列
      const obsCols = this.db
        .prepare("PRAGMA table_info(latest_obstruction_map)")
        .all() as { name: string }[];
      const obsNames = obsCols.map((c) => c.name);

      if (!obsNames.includes('source')) {
        // 存量行的来源未知 —— 保守标成 'mock'。
        // 理由: 宁可提示"这是模拟数据"让用户去查, 也不能把未知数据显示成
        // 设备实测。真实数据写入时会带上自己的 source 覆盖它。
        this.db.exec(
          "ALTER TABLE latest_obstruction_map ADD COLUMN source TEXT NOT NULL DEFAULT 'mock'"
        );
        console.log('[TelemetryStore] 迁移 v2: latest_obstruction_map 增加 source 列(存量行标为 mock)');
      }

      // v3: telemetry_hourly 增加 state 分布列
      const hourlyCols = this.db
        .prepare("PRAGMA table_info(telemetry_hourly)")
        .all() as { name: string }[];
      const hourlyNames = hourlyCols.map((c) => c.name);

      if (!hourlyNames.includes('online_sec')) {
        this.db.exec(`
          ALTER TABLE telemetry_hourly ADD COLUMN online_sec INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE telemetry_hourly ADD COLUMN offline_sec INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE telemetry_hourly ADD COLUMN searching_sec INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE telemetry_hourly ADD COLUMN booting_sec INTEGER NOT NULL DEFAULT 0;
        `);
        console.log('[TelemetryStore] 迁移 v3: telemetry_hourly 增加 state 分布列(online/offline/searching/booting)');
      }

      // v5: telemetry_hourly 增加 public/local 延迟聚合字段
      if (!hourlyNames.includes('public_ping_avg')) {
        this.db.exec(`
          ALTER TABLE telemetry_hourly ADD COLUMN public_ping_avg REAL;
          ALTER TABLE telemetry_hourly ADD COLUMN public_ping_max REAL;
          ALTER TABLE telemetry_hourly ADD COLUMN local_gateway_avg REAL;
          ALTER TABLE telemetry_hourly ADD COLUMN local_gateway_max REAL;
        `);
        console.log('[TelemetryStore] 迁移 v5: telemetry_hourly 增加 public/local 延迟聚合字段');
      }

      // v4: telemetry_samples 性能索引
      // 使用 PRAGMA index_list 检查索引是否已存在
      const indexes = this.db
        .prepare("PRAGMA index_list(telemetry_samples)")
        .all() as { name: string }[];
      const indexNames = indexes.map((idx) => idx.name);

      if (!indexNames.includes('idx_samples_state_ts')) {
        this.db.exec('CREATE INDEX idx_samples_state_ts ON telemetry_samples(state, ts)');
        console.log('[TelemetryStore] 迁移 v4: 创建索引 idx_samples_state_ts (状态 + 时间)');
      }

      if (!indexNames.includes('idx_samples_obstructed_ts')) {
        this.db.exec('CREATE INDEX idx_samples_obstructed_ts ON telemetry_samples(currently_obstructed, ts)');
        console.log('[TelemetryStore] 迁移 v4: 创建索引 idx_samples_obstructed_ts (遮挡 + 时间)');
      }

      // v7: telemetry_samples 增加告警相关字段
      const sampleCols = this.db
        .prepare("PRAGMA table_info(telemetry_samples)")
        .all() as { name: string }[];
      const sampleNames = sampleCols.map((c) => c.name);

      if (!sampleNames.includes('class_of_service')) {
        this.db.exec(`
          ALTER TABLE telemetry_samples ADD COLUMN class_of_service TEXT;
          ALTER TABLE telemetry_samples ADD COLUMN disablement_code TEXT;
          ALTER TABLE telemetry_samples ADD COLUMN alerts_json TEXT;
        `);
        console.log('[TelemetryStore] 迁移 v7: telemetry_samples 增加 class_of_service, disablement_code, alerts_json 列');
      }

      // v8: satellite_handoffs 主键 ts → rtc_ms
      //
      // 旧表拿「换算后的 ts」当主键，而 ts 依赖「设备时钟 → host 时钟」的锚点。
      // 锚点一变，同一条事件就算出新的 ts，于是同一件事在库里留下第二行 ——
      // 错位的历史永远修不回来。改用设备时钟读数当主键后，重写只会覆盖原行。
      //
      // SQLite 不支持改主键，只能整表重建：改名 → 建新表 → 搬数据 → 删旧表。
      // 建表语句复用 SATELLITE_HANDOFFS_DDL，保证和全新安装的结构完全一致。
      const handoffCols = this.db
        .prepare('PRAGMA table_info(satellite_handoffs)')
        .all() as { name: string }[];
      const handoffNames = handoffCols.map((c) => c.name);

      if (!handoffNames.includes('rtc_ms')) {
        const now = Date.now();
        // 存量行没有设备时钟读数可还原，只能拿当时的 ts 顶替成身份。
        // 但那个 ts 是拿旧算法算出来的 —— 真机上落在 2016 年或 2073 年。
        // 未来时间戳永远等不到 prune 的 cutoff，会永久污染图表；
        // 所以只搬落在保留窗口内的行，其余当垃圾数据丢弃。
        // 丢弃是无损的：设备 history 窗口里的近期事件下一轮就会重新写入。
        const minTs = now - HANDOFF_RETENTION_DAYS * DAY_MS;
        const maxTs = now + DAY_MS;

        const rebuild = this.db.transaction(() => {
          // 上次迁移中断可能留下半成品，先清掉（正常情况下是 no-op）
          this.db.exec('DROP TABLE IF EXISTS satellite_handoffs_legacy');
          this.db.exec('ALTER TABLE satellite_handoffs RENAME TO satellite_handoffs_legacy');
          // 索引跟着旧表一起改名了，等旧表删掉才能在新表上重建
          this.db.exec(SATELLITE_HANDOFFS_DDL);
          this.db
            .prepare(`
              INSERT INTO satellite_handoffs (rtc_ms, ts, duration_ms, cause, parsed_cause, is_explicit)
              SELECT ts, ts, duration_ms, cause, parsed_cause, is_explicit
              FROM satellite_handoffs_legacy
              WHERE ts >= ? AND ts <= ?
            `)
            .run(minTs, maxTs);
          this.db.exec('DROP TABLE satellite_handoffs_legacy');
          this.db.exec('CREATE INDEX IF NOT EXISTS idx_handoffs_ts ON satellite_handoffs(ts)');
        });

        rebuild();
        console.log('[TelemetryStore] 迁移 v8: satellite_handoffs 主键改为 rtc_ms(整表重建, 丢弃时钟错乱的存量行)');
      }
    } catch (error) {
      console.warn('[TelemetryStore] 迁移失败(不影响使用):', error);
    }
  }

  /** 追加一条采样。同一时刻重复写入会覆盖。 */
  append(point: TimestampedTelemetry): void {
    this.appendTx(point);
  }

  private writeSample(point: TimestampedTelemetry): void {
    const ts = toEpochMs(point.timestamp);
    const values = SAMPLE_FIELDS.map((f) => {
      const rawValue = (point as unknown as Record<string, unknown>)[f.key];
      const transformed = 'transform' in f && f.transform ? f.transform(rawValue) : rawValue;
      return toSqlValue(transformed);
    });
    this.insertSample.run(ts, ...values);
  }

  private writeHourly(point: TimestampedTelemetry, ts: number): void {
    const bucketTs = Math.floor(ts / HOUR_MS) * HOUR_MS;
    
    // 计算本次采样代表的时长(秒)，假设采样间隔 30s
    const durationSec = SAMPLE_INTERVAL_MS / 1000;
    
    // 根据 state 分配持续时长
    const stateDuration = {
      online: point.state === 'ONLINE' ? durationSec : 0,
      offline: point.state === 'OFFLINE' ? durationSec : 0,
      searching: point.state === 'SEARCHING' ? durationSec : 0,
      booting: point.state === 'BOOTING' ? durationSec : 0,
    };
    
    this.upsertHourly.run(
      bucketTs,
      point.popPingLatencyMs,
      point.popPingLatencyMs,
      point.popPingLatencyMs,
      point.popPingDropRate,
      point.popPingDropRate,
      point.downlinkThroughputBps,
      point.downlinkThroughputBps,
      point.uplinkThroughputBps,
      point.uplinkThroughputBps,
      point.fractionObstructed,
      point.snr,
      stateDuration.online,
      stateDuration.offline,
      stateDuration.searching,
      stateDuration.booting,
      point.publicPingLatencyMs ?? null,
      point.publicPingLatencyMs ?? null,
      point.localGatewayLatencyMs ?? null,
      point.localGatewayLatencyMs ?? null,
    );
  }

  private writeSnapshot(point: TimestampedTelemetry): void {
    const ts = toEpochMs(point.timestamp);
    const { obstructionMap, obstructionMapSource, ...rest } = point;

    this.upsertSnapshot.run(ts, JSON.stringify(rest));

    // 遮挡图单行覆盖: 只有"当前视野"有意义
    if (Array.isArray(obstructionMap) && obstructionMap.length > 0) {
      // 来源标记必须一起存: 模拟图和实测图视觉几乎一样, 界面上要能区分
      this.upsertObstruction.run(
        ts,
        obstructionMap.length,
        JSON.stringify(obstructionMap),
        obstructionMapSource === 'real' ? 'real' : 'mock'
      );
    }
  }
  // ---------------------------------------------------------------- 读取

  /**
   * 读取最新一条完整遥测(含遮挡图)。
   * 应用重启后用它做首屏, 不必等第一次采集。
   */
  readLatest(): TelemetryData | null {
    const snapshot = this.selectSnapshot.get() as { ts: number; payload: string } | undefined;
    if (!snapshot) return null;

    try {
      const payload = JSON.parse(snapshot.payload) as TelemetryData;
      const map = this.selectObstruction.get() as { ts: number; data: string } | undefined;

      // 遮挡图只在比快照更新或同刻时才附带, 避免把旧视野贴到新状态上
      if (map && map.ts >= snapshot.ts) {
        payload.obstructionMap = JSON.parse(map.data) as number[][];
      }

      return payload;
    } catch (error) {
      console.warn('[TelemetryStore] 解析最新快照失败:', error);
      return null;
    }
  }

  /**
   * 读取最新一份遮挡图及其采集时刻。
   *
   * 与 readLatest() 分开的原因: 遮挡图是"独立刷新"的视角数据
   * (dishGetObstructionMap 单独拉取, 频率与遥测不同), 单独取才能
   * 准确告诉用户"这张图是什么时候的" —— 监控软件里数据新鲜度
   * 和数据本身同等重要。
   */
  readLatestObstruction(): { data: number[][]; ts: number; source: 'real' | 'mock' } | null {
    const row = this.selectObstruction.get() as { ts: number; data: string; source?: string } | undefined;
    if (!row) return null;

    try {
      const parsed = JSON.parse(row.data) as number[][];
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      return {
        data: parsed,
        ts: row.ts,
        source: row.source === 'real' ? 'real' : 'mock',
      };
    } catch (error) {
      console.warn('[TelemetryStore] 解析遮挡图失败:', error);
      return null;
    }
  }

  /**
   * 按时间范围查历史。
   *
   * 数据源选择:
   *   范围 <= 原始保留期(7天)  -> telemetry_samples(必要时按需分桶)
   *   范围 >  原始保留期       -> telemetry_hourly(按小时聚合)
   */
  queryHistory(query: HistoryQuery): HistorySample[] {
    const { fromMs, toMs } = query;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];

    const maxPoints = query.maxPoints ?? 600;
    const span = toMs - fromMs;

    if (span > SAMPLE_RETENTION_DAYS * DAY_MS) {
      const bucketMs = pickBucketMs(span, maxPoints, HOUR_MS) || HOUR_MS;
      const rows = this.selectHourly.all(bucketMs, bucketMs, fromMs, toMs);
      return rows.map(mapRow);
    }

    const bucketMs = pickBucketMs(span, maxPoints, SAMPLE_INTERVAL_MS);
    if (bucketMs === 0) {
      return this.selectRaw.all(fromMs, toMs).map(mapRow);
    }

    const rows = this.selectBucketed.all(bucketMs, bucketMs, fromMs, toMs);
    return rows.map(mapRow);
  }

  /**
   * 区间统计摘要。
   * 流量按**每拍的实际采样间隔**计入（间隔封顶 2 × 标称间隔），
   * 跨停机/重启的大间隙不会被外推成持续流量。详见 summarySql.ts。
   */
  summarize(fromMs: number, toMs: number = Date.now(), nominalIntervalSec: number = SAMPLE_INTERVAL_MS / 1000): HistorySummary {
    const row = this.selectSummary.get(fromMs, toMs) as {
      n: number;
      latency_avg: number;
      latency_max: number;
      latency_min: number;
      drop_avg: number;
      down_avg: number;
      up_avg: number;
      online_n: number;
      down_sum: number;
      up_sum: number;
      first_ts: number | null;
      last_ts: number | null;
    };

    const empty: HistorySummary = {
      sampleCount: 0,
      avgLatencyMs: 0,
      maxLatencyMs: 0,
      minLatencyMs: 0,
      avgDropRate: 0,
      avgDownBps: 0,
      avgUpBps: 0,
      availability: 0,
      outageCount: 0,
      estimatedDownBytes: 0,
      estimatedUpBytes: 0,
      firstTs: null,
      lastTs: null,
    };

    if (!row || row.n === 0) return empty;

    const capSec = nominalIntervalSec * 2;
    const bytes = this.selectEstimatedBytes.get(nominalIntervalSec, capSec, fromMs, toMs) as {
      down_bytes: number;
      up_bytes: number;
    };
    const outages = this.selectOutages.get(fromMs, toMs) as { outages: number } | undefined;

    return {
      sampleCount: row.n,
      avgLatencyMs: row.latency_avg,
      maxLatencyMs: row.latency_max,
      minLatencyMs: row.latency_min,
      avgDropRate: row.drop_avg,
      avgDownBps: row.down_avg,
      avgUpBps: row.up_avg,
      availability: row.online_n / row.n,
      outageCount: outages?.outages ?? 0,
      estimatedDownBytes: bytes.down_bytes,
      estimatedUpBytes: bytes.up_bytes,
      firstTs: row.first_ts,
      lastTs: row.last_ts,
    };
  }

  // ---------------------------------------------------------------- 运维

  stats(): StorageStats {
    const samples = this.db
      .prepare('SELECT COUNT(*) AS n, MIN(ts) AS oldest, MAX(ts) AS newest FROM telemetry_samples')
      .get() as { n: number; oldest: number | null; newest: number | null };

    const hourly = this.db.prepare('SELECT COUNT(*) AS n FROM telemetry_hourly').get() as { n: number };

    let fileSizeBytes = 0;
    try {
      fileSizeBytes = fs.statSync(this.dbPath).size;
    } catch {
      /* 文件可能尚未落盘, 忽略 */
    }

    return {
      dbPath: this.dbPath,
      fileSizeBytes,
      sampleCount: samples.n,
      oldestSampleTs: samples.oldest,
      newestSampleTs: samples.newest,
      hourlyCount: hourly.n,
      retention: { sampleDays: SAMPLE_RETENTION_DAYS, hourlyDays: HOURLY_RETENTION_DAYS },
    };
  }

  /** 按保留策略删除过期数据, 并回收 WAL。 */
  prune(now: number = Date.now()): PruneResult {
    const sampleCutoff = now - SAMPLE_RETENTION_DAYS * DAY_MS;
    const hourlyCutoff = now - HOURLY_RETENTION_DAYS * DAY_MS;
    const handoffCutoff = now - HANDOFF_RETENTION_DAYS * DAY_MS;

    const samples = this.db.prepare('DELETE FROM telemetry_samples WHERE ts < ?').run(sampleCutoff);
    const hourly = this.db.prepare('DELETE FROM telemetry_hourly WHERE bucket_ts < ?').run(hourlyCutoff);
    const handoffs = this.db.prepare('DELETE FROM satellite_handoffs WHERE ts < ?').run(handoffCutoff);

    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.pragma('optimize');

    return { 
      samples: samples.changes, 
      hourly: hourly.changes,
      handoffs: handoffs.changes,
    };
  }

  /**
   * 写入一批卫星切换事件。
   *
   * 语义是**镜像**而不是追加：以 `rtcMs` 为身份做 `INSERT OR REPLACE`，
   * 同一事件重复写、或锚点变准后用新 `ts` 重写，都只覆盖原来那一行。
   * 因此调用方可以每轮把设备 history 窗口里的全部事件整体灌进来，
   * 不必维护「哪些写过了」的水位线 —— 那套水位线在锚点会平移的前提下
   * 无法正确工作（详见 `dishClock.ts` 开篇）。
   *
   * @param handoffs 卫星切换事件（含未校准的 rtcMs 与换算后的 timestamp）
   */
  upsertHandoffs(handoffs: HandoffEvent[]): void {
    if (handoffs.length === 0) return;

    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO satellite_handoffs
      (rtc_ms, ts, duration_ms, cause, parsed_cause, is_explicit)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((events: HandoffEvent[]) => {
      for (const event of events) {
        insert.run(
          event.rtcMs,
          event.timestamp,
          event.durationMs,
          event.cause,
          event.parsedCause,
          event.isExplicit ? 1 : 0,
        );
      }
    });

    transaction(handoffs);
  }

  /**
   * 查询卫星切换事件历史
   *
   * @param fromMs 起始时间 epoch ms
   * @param toMs 结束时间 epoch ms
   * @param limit 最多返回多少条事件（默认 100）
   * @returns 切换事件列表，按时间倒序（最新的在前）
   */
  queryHandoffs(fromMs: number, toMs: number, limit: number = 100): HandoffEvent[] {
    const rows = this.db
      .prepare(`
        SELECT rtc_ms, ts, duration_ms, cause, parsed_cause, is_explicit
        FROM satellite_handoffs
        WHERE ts >= ? AND ts < ?
        ORDER BY ts DESC
        LIMIT ?
      `)
      .all(fromMs, toMs, limit);

    return rows.map((r: any) => ({
      rtcMs: r.rtc_ms as number,
      timestamp: r.ts as number,
      durationMs: r.duration_ms as number,
      cause: r.cause as string,
      parsedCause: r.parsed_cause as OutageCause,
      isExplicit: (r.is_explicit as number) === 1,
    }));
  }

  /**
   * 统计卫星切换频率
   * 
   * @param fromMs 起始时间 epoch ms
   * @param toMs 结束时间 epoch ms
   * @returns 切换次数和平均持续时长
   */
  summarizeHandoffs(fromMs: number, toMs: number): {
    count: number;
    avgDurationMs: number | null;
    explicitCount: number;
  } {
    const row = this.db
      .prepare(`
        SELECT 
          COUNT(*) as count,
          AVG(duration_ms) as avg_duration,
          SUM(CASE WHEN is_explicit = 1 THEN 1 ELSE 0 END) as explicit_count
        FROM satellite_handoffs
        WHERE ts >= ? AND ts < ?
      `)
      .get(fromMs, toMs) as any;

    return {
      count: (row?.count as number) ?? 0,
      avgDurationMs: typeof row?.avg_duration === 'number' ? row.avg_duration : null,
      explicitCount: (row?.explicit_count as number) ?? 0,
    };
  }

  close(): void {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.close();
    } catch (error) {
      console.warn('[TelemetryStore] 关闭数据库时出错:', error);
    }
  }

  /**
   * 查询遮挡事件历史
   * 
   * 遮挡事件 = 连续的 currently_obstructed = 1 时段
   * 
   * @param fromMs 起始时间 epoch ms
   * @param toMs 结束时间 epoch ms
   * @param limit 最多返回多少条事件（默认 20）
   * @returns 遮挡事件列表，按时间倒序（最新的在前）
   */
  queryObstructionEvents(fromMs: number, toMs: number, limit: number = 20): ObstructionEvent[] {
    // 查询指定时间范围内 currently_obstructed = 1 的采样点
    const rows = this.db
      .prepare(`
        SELECT ts, fraction_obstructed
        FROM telemetry_samples
        WHERE ts >= ? AND ts < ? AND currently_obstructed = 1
        ORDER BY ts ASC
      `)
      .all(fromMs, toMs) as Array<{ ts: number; fraction_obstructed: number }>;

    if (rows.length === 0) {
      return [];
    }

    // 将连续的遮挡采样合并为事件
    const events: ObstructionEvent[] = [];
    let currentEvent: {
      startTs: number;
      endTs: number;
      fractions: number[];
    } | null = null;

    // 采样间隔阈值：超过 2 分钟（4 个采样周期）视为新事件
    const gapThreshold = SAMPLE_INTERVAL_MS * 4;

    for (const row of rows) {
      if (!currentEvent) {
        // 开始新事件
        currentEvent = {
          startTs: row.ts,
          endTs: row.ts,
          fractions: [row.fraction_obstructed],
        };
      } else if (row.ts - currentEvent.endTs <= gapThreshold) {
        // 继续当前事件
        currentEvent.endTs = row.ts;
        currentEvent.fractions.push(row.fraction_obstructed);
      } else {
        // 间隔过大，结束当前事件并开始新事件
        events.push(finalizeEvent(currentEvent));
        currentEvent = {
          startTs: row.ts,
          endTs: row.ts,
          fractions: [row.fraction_obstructed],
        };
      }
    }

    // 处理最后一个事件
    if (currentEvent) {
      events.push(finalizeEvent(currentEvent));
    }

    // 按时间倒序排列，取前 limit 条
    return events.reverse().slice(0, limit);
  }
}

/**
 * 三个查询共用: 列名一致, 映射成 CamelCase 的 HistorySample
 *
 * state / onlineRatio 的产出规则:
 *   明细(selectRaw)      -> state='ONLINE', onlineRatio=1; 其他状态 onlineRatio=0
 *   分桶(selectBucketed) -> state=undefined, onlineRatio=桶内 ONLINE 占比
 *   小时聚合(selectHourly) -> 两者都 undefined(表里没存 state)
 */
function mapRow(row: unknown): HistorySample {
  const r = row as Record<string, number | string | null | undefined>;
  const state = typeof r.state === 'string' ? r.state : undefined;

  // onlineRatio 计算优先级:
  //   1. 分桶查询直接给出的 online_ratio
  //   2. hourly 表的 state 秒数(时长加权)
  //   3. 明细表的 state 字段(0 或 1)
  let onlineRatio: number | undefined;
  if (typeof r.online_ratio === 'number' && Number.isFinite(r.online_ratio)) {
    onlineRatio = r.online_ratio;
  } else if (typeof r.online_sec === 'number' || typeof r.offline_sec === 'number' || 
             typeof r.searching_sec === 'number' || typeof r.booting_sec === 'number') {
    // hourly 表: 根据 state 秒数计算时长加权在线率
    const onlineSec = (r.online_sec as number) ?? 0;
    const offlineSec = (r.offline_sec as number) ?? 0;
    const searchingSec = (r.searching_sec as number) ?? 0;
    const bootingSec = (r.booting_sec as number) ?? 0;
    const totalSec = onlineSec + offlineSec + searchingSec + bootingSec;
    onlineRatio = totalSec > 0 ? onlineSec / totalSec : undefined;
  } else if (state !== undefined) {
    onlineRatio = state === 'ONLINE' ? 1 : 0;
  }

  return {
    timestamp: (r.bucket ?? r.ts) as number,
    state,
    onlineRatio,
    // 各状态占比 —— 只有分桶粒度(selectBucketed)才有这三个列。
    // 明细粒度下 state 已能表达全部信息, 用 state 推出 0/1 即可。
    searchingRatio: ratioOf(r.searching_ratio, state, 'SEARCHING'),
    bootingRatio: ratioOf(r.booting_ratio, state, 'BOOTING'),
    offlineRatio: ratioOf(r.offline_ratio, state, 'OFFLINE'),
    popPingLatencyMs: r.latency_ms as number,
    popPingDropRate: r.drop_rate as number,
    downlinkThroughputBps: r.down_bps as number,
    uplinkThroughputBps: r.up_bps as number,
    snr: r.snr as number,
    fractionObstructed: r.fraction_obstructed as number,
    satelliteId: typeof r.satellite_id === 'number' ? r.satellite_id : undefined,
    publicPingLatencyMs: typeof r.public_ping_ms === 'number' ? r.public_ping_ms : undefined,
    localGatewayLatencyMs: typeof r.local_gateway_ms === 'number' ? r.local_gateway_ms : undefined,
  };
}

/**
 * 取某状态的占比。
 *
 * 分桶粒度: 直接用 SQL 给的占比列。
 * 明细粒度: 行里只有一个 state, 该状态占比为 1, 其余为 0。
 * 小时聚合: 表里没存逐状态占比 -> undefined(而不是编造 0)。
 */
function ratioOf(
  column: unknown,
  state: string | undefined,
  wanted: string
): number | undefined {
  if (typeof column === 'number' && Number.isFinite(column)) return column;
  if (state === undefined) return undefined;
  return state === wanted ? 1 : 0;
}

/**
 * 将临时事件对象转换为最终的 ObstructionEvent
 */
function finalizeEvent(event: {
  startTs: number;
  endTs: number;
  fractions: number[];
}): ObstructionEvent {
  const durationSec = (event.endTs - event.startTs) / 1000;
  const avgFractionObstructed =
    event.fractions.reduce((sum, f) => sum + f, 0) / event.fractions.length;
  const maxFractionObstructed = Math.max(...event.fractions);

  return {
    startTs: event.startTs,
    endTs: event.endTs,
    durationSec,
    avgFractionObstructed,
    maxFractionObstructed,
  };
}