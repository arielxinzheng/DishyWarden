/**
 * 遥测历史库的表结构定义（DDL 的唯一来源）
 *
 * 分层设计:
 *   telemetry_samples  —— 原始采样(默认 30s 一条), 只保留短期(7 天)
 *   telemetry_hourly   —— 按小时预聚合, 保留长期(400 天)
 *   latest_snapshot    —— 最新一条完整遥测(重启后立刻有数据, 不用等第一次采样)
 *   latest_obstruction_map —— 最新一份遮挡图
 *
 * 为什么遮挡图单独放:
 *   123x123 = 15129 个数值, 每 30s 存一份一周就是 3 亿个数字。
 *   只有"当前画面"有意义, 所以只保留最新一份。
 *
 * 时间统一用 INTEGER(epoch 毫秒) 而不是 ISO 字符串:
 *   索引扫描 / 范围查询 / 分桶聚合都直接走整数比较, 没有时区解析成本。
 */

/**
 * 库结构版本, 后续迁移时用于判断是否需要 ALTER
 *
 * v1: 初始表结构
 * v2: latest_obstruction_map 增加 source 列(标记遮挡图是实测还是模拟)
 * v3: telemetry_hourly 增加 state 分布列(online_sec/offline_sec/searching_sec/booting_sec)
 * v4: 性能索引 - (state, ts) 和 (currently_obstructed, ts)
 * v5: telemetry_samples 增加 public_ping_ms 和 local_gateway_ms 列
 */
export const SCHEMA_VERSION = 5;

/** 原始采样保留天数 */
export const SAMPLE_RETENTION_DAYS = 7;

/** 小时聚合保留天数 */
export const HOURLY_RETENTION_DAYS = 400;

/** 采样间隔假设(毫秒), 用于估算流量与判断是否需要分桶 */
export const SAMPLE_INTERVAL_MS = 30_000;

export const DDL = `
  CREATE TABLE IF NOT EXISTS telemetry_samples (
    ts                  INTEGER PRIMARY KEY,  -- epoch ms, 同刻重复采集时覆盖
    state               TEXT    NOT NULL,
    latency_ms          REAL    NOT NULL,
    drop_rate           REAL    NOT NULL,
    down_bps            REAL    NOT NULL,
    up_bps              REAL    NOT NULL,
    snr                 REAL    NOT NULL,
    fraction_obstructed REAL    NOT NULL,
    currently_obstructed INTEGER NOT NULL,
    satellite_id        INTEGER,
    uptime_s            INTEGER,
    dish_temp_c         REAL,
    psu_temp_c          REAL,
    public_ping_ms      REAL,     -- 公网 Ping 延迟（探针节点 ICMP）
    local_gateway_ms    REAL      -- 本地网关延迟（默认网关 ICMP）
  );

  -- 索引: 状态过滤 + 时间范围查询（中断统计、在线率计算）
  CREATE INDEX IF NOT EXISTS idx_samples_state_ts ON telemetry_samples(state, ts);
  
  -- 索引: 遮挡过滤 + 时间范围查询（遮挡事件历史）
  CREATE INDEX IF NOT EXISTS idx_samples_obstructed_ts ON telemetry_samples(currently_obstructed, ts);

  CREATE TABLE IF NOT EXISTS telemetry_hourly (
    bucket_ts      INTEGER PRIMARY KEY,  -- 所在小时的起点 epoch ms
    sample_count   INTEGER NOT NULL,
    latency_avg    REAL NOT NULL,
    latency_max    REAL NOT NULL,
    latency_min    REAL NOT NULL,
    drop_avg       REAL NOT NULL,
    drop_max       REAL NOT NULL,
    down_avg       REAL NOT NULL,
    down_max       REAL NOT NULL,
    up_avg         REAL NOT NULL,
    up_max         REAL NOT NULL,
    obstructed_avg REAL NOT NULL,
    snr_avg        REAL NOT NULL,
    -- v3: state 分布(秒数), 用于计算时长加权在线率
    online_sec     INTEGER NOT NULL DEFAULT 0,
    offline_sec    INTEGER NOT NULL DEFAULT 0,
    searching_sec  INTEGER NOT NULL DEFAULT 0,
    booting_sec    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS latest_snapshot (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    ts      INTEGER NOT NULL,
    payload TEXT    NOT NULL   -- TelemetryData 的 JSON(剔除 obstructionMap)
  );

  CREATE TABLE IF NOT EXISTS latest_obstruction_map (
    id   INTEGER PRIMARY KEY CHECK (id = 1),
    ts   INTEGER NOT NULL,
    size INTEGER NOT NULL,
    data TEXT    NOT NULL,     -- number[][] 的 JSON
    -- 数据来源: 'real'=设备实测, 'mock'=本地模拟
    -- 存在的理由: 模拟图和实测图视觉几乎一样, 不存来源就无法在界面上
    -- 区分, 用户会把演示数据当成设备实测结果。
    source TEXT NOT NULL DEFAULT 'real'
  );
`;