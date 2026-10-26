/**
 * 存储层公共出口 —— 只导出类型与常量。
 *
 * ⚠️ 刻意不从这里导出 TelemetryStore:
 *    它依赖 better-sqlite3 原生模块, 一旦被渲染进程 import 就会打包失败。
 *    主进程请直接从 './telemetryStore' 引入。
 */

export type {
  HistoryQuery,
  HistorySample,
  HistorySummary,
  PruneResult,
  StorageStats,
  TimestampedTelemetry,
} from './types';

export {
  SCHEMA_VERSION,
  SAMPLE_INTERVAL_MS,
  SAMPLE_RETENTION_DAYS,
  HOURLY_RETENTION_DAYS,
} from './schema';