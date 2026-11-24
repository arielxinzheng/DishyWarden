/**
 * 延迟维度与「卫星切换标记可见性」的判定
 *
 * ## 为什么要按模式区分
 *
 * 三个延迟维度走的是**不同的物理路径**：
 *
 * | 模式 | 路径 | 卫星切换有影响吗 |
 * |---|---|---|
 * | PoP | 终端 → 卫星 → PoP | ✅ 有（切换发生在卫星链路） |
 * | Public | 终端 → 卫星 → 公网 | ✅ 有（同上） |
 * | Local | 终端 → 本地网关/路由器 | ❌ **没有**（不经卫星） |
 *
 * Local 测的是本地网关的 ICMP 延迟 —— 卫星切换时网关本身毫无变化。
 * 在 Local 折线上标 ★ 卫星切换是**语义错误**：
 * 用户会以为「网关延迟尖刺是卫星切换造成的」，从而把故障定位方向带偏
 * （真凶是本地链路问题，却被指向卫星）。
 *
 * ⇒ Local 模式下必须**清空该 series 的数据**并**隐藏该图层**。
 *
 * 但"消失"必须被解释：★ 图例和图上标记一起不见，用户的第一反应是
 * 功能失效，而不是"这个维度本来就没有卫星链路"。所以 LatencyChart 在
 * 图例位置渲染一句 `chart.handoff_not_applicable`（判据用的仍是本函数，
 * 两处必须同源）。文案见 locales 五语言。
 */

/** 延迟维度：Public / PoP / Local(网关) */
export type LatencyMode = 'public' | 'pop' | 'gateway';

/**
 * 延迟维度的展示配置。
 *
 * ⚠️ 本文件不产出用户可见文案: `labelKey` 是 `dashboard:` 命名空间下的
 * 字典键, 由渲染层（LatencyChart）用 `t()` 翻译。否则同一个按钮在
 * 中文界面会永远显示 "Local"。
 */
export const LATENCY_DIMENSIONS: Array<{ id: LatencyMode; labelKey: string; available: boolean }> = [
  { id: 'public', labelKey: 'chart.mode_public', available: true },
  { id: 'pop', labelKey: 'chart.mode_pop', available: true },
  { id: 'gateway', labelKey: 'chart.mode_gateway', available: true },
];

export const DEFAULT_MODE: LatencyMode = LATENCY_DIMENSIONS.find((d) => d.available)?.id ?? 'pop';

/**
 * 当前模式是否显示卫星切换标记。
 *
 * Local(网关)走本地链路、不经卫星 ⇒ 不显示。
 */
export function showsSatelliteHandoffs(mode: LatencyMode): boolean {
  return mode !== 'gateway';
}
