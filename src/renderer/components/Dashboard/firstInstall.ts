/**
 * 场景 A 判定 —— 首次安装时的采集失败 (Day 0 / Zero Data State)
 *
 * ## 触发条件（两个信号都来自已有 IPC, 不需要新增通道）
 *
 *   1. gRPC 采集失败: `error && !telemetry`（useDish 的连接失败态）
 *   2. 本地库为空:   `storageStats.sampleCount === 0`（get-storage-stats）
 *
 * ## 为什么必须同时满足
 *
 * 只看 ①: 运行中设备拔电 30 分钟后也满足, 但库里有历史数据 ——
 *         那是「场景 B: 运行中断连」, 应该显示陈旧横幅 + 历史图表, 不该进引导页。
 * 只看 ②: 应用刚启动第一个采样周期内库还是空的, 但 gRPC 是通的 ——
 *         那是正常首帧, 用户等 30s 就有数据了。
 *
 * 两个都满足 ⇒ 从未成功采集过 ⇒ 用户还在「搭环境」, 该看到的是引导而不是仪表盘。
 *
 * ## 降级规则（数据拿不到时的安全侧）
 *
 * - `storageStats === null`（IPC 失败/非 Electron）: 无法证明「有历史」,
 *   但也无法证明「首次安装」。按**不是首次安装**处理 ——
 *   走原有的小 Alert 框, 行为与改动前完全一致, 绝不因为本模块故障而吞掉原 UI。
 *   拿不到证据时不抢占路由。
 */

/** storage-stats IPC 的最小形状（对齐 src/storage/types.ts StorageStats） */
export interface ZeroDataStorageStats {
  sampleCount: number;
}

/**
 * 判定「首次安装采集失败」。
 *
 * 纯函数, 不读时间不读环境 —— 同一组输入永远同一个结论, 便于单测。
 *
 * @param hasConnectionError gRPC 采集是否失败（useDish 的 error && !telemetry）
 * @param storageStats       历史库统计; null 表示拿不到, 按非首次安装降级
 */
export function isFirstInstallFailure(
  hasConnectionError: boolean,
  storageStats: ZeroDataStorageStats | null
): boolean {
  if (!hasConnectionError) return false;
  // 拿不到库统计 ⇒ 无法证明零数据 ⇒ 降级走原有错误 UI, 不抢占
  if (!storageStats) return false;
  return storageStats.sampleCount === 0;
}
