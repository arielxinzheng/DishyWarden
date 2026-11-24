/**
 * 卫星切换标记的可见性规则
 *
 * ## 三个独立的开关
 *
 * 卫星切换标记能不能显示, 由**三层**共同决定 ——
 * 每一层都能单独把它关掉:
 *
 * | 层 | 判据 | 关掉的条件 |
 * |---|---|---|
 * | ① 延迟维度 | `showsSatelliteHandoffs(mode)` | Local(网关)模式 |
 * | ② 时间范围 | `handoffsVisibleByDefault(range)` | 目前恒为开 |
 * | ③ 用户手动 | `handoffsOverrides[range]` | 用户点过图例 |
 *
 * ## 为什么所有范围都默认开启（2026-11 修正）
 *
 * 旧规则是「15m 开, 1H/6H 关」, 理由是「时间窗越长切换越密, 6 小时能有
 * 上百个 ★ 把折线糊住」。**这个前提在真机上是错的**, 差了两个数量级。
 *
 * 数据源是 `dishGetHistory().outages[]` —— 它记录的是**中断**, 不是切换。
 * 常规换星(约每 15 秒一次)根本不产生 outage; 只有换星瞬间丢包/失锁才会
 * 进这个数组。现场实测(固件 2026.10.27, 20 条 outage / 约 12 小时窗口)
 * 约 **每小时 1~2 条**。
 *
 * 于是:
 *   - 15m 窗口的期望值只有 0.25 条 ⇒ 绝大多数时候本来就是空的
 *   - 6H 窗口也只有 ~10 条 ⇒ 根本糊不住折线
 *
 * 旧默认值在真机上的唯一效果是「把仅有的一颗星藏起来」。
 * ⇒ 改成恒开, 由用户自己点图例关。
 *
 * ## 手动选择按范围分别记忆
 *
 * 用户点图例是**显式操作**, 必须立刻见效 —— 点了没反应是坏的。
 * 但同时, 用户对不同时间窗的意图可能不同: 15m 里想看清折线细节就关掉,
 * 6H 里想复盘切换频率就打开。如果只存一个全局布尔值, 在一处点一下
 * 会把所有窗口一起改掉。
 *
 * ⇒ 用 `Record<TimeRangeKey, boolean>` **按范围**记手动选择:
 *   - 没点过的范围 ⇒ 用该范围的默认值(目前恒开)
 *   - 点过的范围   ⇒ 用用户的选择(切回来也还记得)
 *
 * 这样:
 *   - 首次进入任何范围 → 开(默认)         ✓
 *   - 在任何范围点图例 → 立刻切换           ✓
 *   - 切到没碰过的范围 → 回到该范围默认     ✓
 *   - 切回碰过的范围   → 记住用户的选择     ✓
 *
 * 默认值一旦将来再改(例如某个范围确实需要默认关), 这套按范围记忆的
 * 结构不需要动 —— 它只关心"用户有没有表过态"。
 */

/** 全局时间范围。跟 Dashboard 的 `TimeRange` 对齐。 */
export type TimeRangeKey = '15m' | '1h' | '6h';

/** 所有时间范围(用于建默认值表)。 */
export const TIME_RANGE_KEYS: TimeRangeKey[] = ['15m', '1h', '6h'];

/**
 * 各时间范围内, 卫星切换标记的**默认**可见性。
 *
 * 恒为 `true`。参数保留是为了调用方签名稳定 —— 判据为什么不再依赖
 * 时间范围, 见文件头注释。
 */
export function handoffsVisibleByDefault(_range: TimeRangeKey): boolean {
  return true;
}

/**
 * 各范围的手动选择记录。
 *
 * `Partial<Record<TimeRangeKey, boolean>>` —— 某个键**不存在**表示
 * 用户还没在这个范围点过图例 ⇒ 用该范围的默认值。
 */
export type HandoffOverrides = Partial<Record<TimeRangeKey, boolean>>;

/**
 * 合并「默认值」与「用户在该范围的手动选择」。
 *
 * @param range     当前全局时间范围
 * @param overrides 各范围的手动选择记录
 */
export function resolveHandoffsVisible(
  range: TimeRangeKey,
  overrides: HandoffOverrides,
): boolean {
  const manual = overrides[range];
  return manual !== undefined ? manual : handoffsVisibleByDefault(range);
}

/**
 * 用户点图例后的新状态。
 *
 * 点击是**切换**语义: 开着 → 关, 关着 → 开。
 */
export function toggleHandoffsVisible(current: boolean): boolean {
  return !current;
}

/**
 * 把一次点击写进「按范围记忆」表。
 *
 * 返回**新对象**(不原地改), 便于 React 的 state 比较。
 *
 * @param overrides 现有的记录
 * @param range     被点击的范围
 * @param current   该范围当前的可见性(用来算新值)
 */
export function withToggledOverride(
  overrides: HandoffOverrides,
  range: TimeRangeKey,
  current: boolean,
): HandoffOverrides {
  return { ...overrides, [range]: toggleHandoffsVisible(current) };
}
