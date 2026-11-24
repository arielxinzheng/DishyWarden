/**
 * 存储层对外暴露的纯数据类型
 *
 * 这里刻意不 import better-sqlite3 —— 渲染进程也会 import 这些类型,
 * 一旦把原生模块带进 renderer bundle 就炸了。
 */

import type { TelemetryData } from '../core/dishClient';

/** 遮挡事件 —— 连续 currently_obstructed = 1 的时段 */
export interface ObstructionEvent {
  /** 事件开始时刻 epoch ms */
  startTs: number;
  /** 事件结束时刻 epoch ms */
  endTs: number;
  /** 持续时长(秒) */
  durationSec: number;
  /** 该时段的平均遮挡率 (0.0-1.0) */
  avgFractionObstructed: number;
  /** 该时段的峰值遮挡率 */
  maxFractionObstructed: number;
}

/** 带采集时刻的遥测数据(采集器内部与写入磁盘时使用) */
export type TimestampedTelemetry = TelemetryData & { timestamp?: Date | number | string };

/**
 * 查询历史时序时返回的归一化数据点。
 * 原始采样、按分钟分桶、按小时聚合三种来源都映射成同一形态,
 * 图表侧不需要关心数据到底来自哪张表。
 */
export interface HistorySample {
  /** epoch ms */
  timestamp: number;
  /**
   * 该采样的连接状态(ONLINE/OFFLINE/SEARCHING/BOOTING)。
   * 只有原始明细(telemetry_samples)有真实状态值;
   * 分桶查询给出的是桶内占比语义(见 onlineRatio), 此时 state 为 undefined。
   */
  state?: string;
  /**
   * 桶内 ONLINE 采样占比 0..1。
   * 语义: 该时间桶里 state='ONLINE' 的采样数 / 桶内总采样数。
   * 仅分桶粒度(selectBucketed)产出; 明细粒度为 1 或 0, 小时聚合无此字段。
   */
  onlineRatio?: number;
  /**
   * 桶内各状态的采样占比 0..1。
   *
   * 语义: 该时间桶里 state='XXX' 的采样数 / 桶内总采样数。
   * 仅分桶粒度(selectBucketed)产出; 明细粒度为 1 或 0, 小时聚合无此字段。
   *
   * 为什么要单独给: onlineRatio 只区分「在线/不在线」,
   * 分不出 SEARCHING(搜星中) / BOOTING(启动中) / OFFLINE(断网) ——
   * 而这三种在「状态色块条」上必须显示成不同颜色。
   */
  searchingRatio?: number;
  bootingRatio?: number;
  offlineRatio?: number;
  popPingLatencyMs: number;
  popPingDropRate: number;
  downlinkThroughputBps: number;
  uplinkThroughputBps: number;
  snr: number;
  fractionObstructed: number;
  /**
   * 额外延迟指标（由采集器补充）
   */
  publicPingLatencyMs?: number;      // 公网 Ping 延迟（探针节点 ICMP）
  localGatewayLatencyMs?: number;    // 本地网关延迟（默认网关 ICMP）
  /**
   * 该采样所连卫星。只有原始明细(telemetry_samples)带这个字段,
   * 分桶/小时聚合会丢掉它 —— 因为一个桶里可能跨了多次切换,
   * 给出任何单值都是编造。图表据此只在明细粒度上标切换点。
   */
  satelliteId?: number;
}

/** 时间范围查询参数 */
export interface HistoryQuery {
  /** 起始时间 epoch ms(含) */
  fromMs: number;
  /** 结束时间 epoch ms(不含) */
  toMs: number;
  /** 期望的最大返回点数, 超出会自动分桶降采样 */
  maxPoints?: number;
}

/** 区间统计摘要 —— 用于仪表盘概览带替换硬编码 */
export interface HistorySummary {
  sampleCount: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  minLatencyMs: number;
  avgDropRate: number;
  avgDownBps: number;
  avgUpBps: number;
  /** ONLINE 采样占比 0..1 */
  availability: number;
  /** ONLINE -> 非 ONLINE 的切换次数 */
  outageCount: number;
  /** 按采样间隔估算的下行/上行流量(字节) */
  estimatedDownBytes: number;
  estimatedUpBytes: number;
  firstTs: number | null;
  lastTs: number | null;
}

/** 库物理状态 —— 设置页展示与自检用 */
export interface StorageStats {
  dbPath: string;
  fileSizeBytes: number;
  sampleCount: number;
  oldestSampleTs: number | null;
  newestSampleTs: number | null;
  hourlyCount: number;
  retention: { sampleDays: number; hourlyDays: number };
}

/** 清理结果 */
export interface PruneResult {
  samples: number;
  hourly: number;
  handoffs?: number;  // 卫星切换事件清理数量
}

/** 遮挡事件 —— 连续 currently_obstructed = 1 的时段 */
export interface ObstructionEvent {
  /** 事件开始时刻 epoch ms */
  startTs: number;
  /** 事件结束时刻 epoch ms */
  endTs: number;
  /** 持续时长(秒) */
  durationSec: number;
  /** 该时段的平均遮挡率 (0.0-1.0) */
  avgFractionObstructed: number;
  /** 该时段的峰值遮挡率 */
  maxFractionObstructed: number;
}