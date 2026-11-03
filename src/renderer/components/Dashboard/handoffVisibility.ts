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
 * | ② 时间范围 | `handoffsVisibleByDefault(range)` | 1H / 6H |
 * | ③ 用户手动 | `handoffsOverrides[range]` | 用户点过图例 |
 *
 * ## 为什么 1H / 6H 默认关闭
 *
 * 时间窗越长, 卫星切换事件**越密集** —— 1 小时的窗口里可能有几十个 ★,
 * 6 小时更是上百个。图会被星星糊满, 折线本身看不见了,
 * 「延迟与丢包走势」这个卡片的用途就废了。
 *
 * 15 分钟窗口里只有几个 ★, 稀疏且醒目, 能起到"这里发生了一次切换"
 * 的标注作用 ⇒ 默认显示。
 *
 * ⇒ **默认状态跟全局时间范围联动**: 15m 开, 1H/6H 关。
 *
 * ## 手动选择按范围分别记忆
 *
 * 用户点图例是**显式操作**, 必须立刻见效 —— 点了没反应是坏的。
 * 但同时, 每个时间范围要保留自己那套**默认值**(15m 开 / 1H·6H 关),
 * 否则用户在 15m 里点一下, 切到 1H 就会看到一堆密集的 ★ 糊住折线。
 *
 * ⇒ 用 `Record<TimeRangeKey, boolean>` **按范围**记手动选择:
 *   - 没点过的范围 ⇒ 用该范围的默认值
 *   - 点过的范围   ⇒ 用用户的选择(切回来也还记得)
 *
 * 这样:
 *   - 15m 首次进入 → 开(默认)          ✓
 *   - 1H / 6H 首次进入 → 关(默认)      ✓
 *   - 在任何范围点图例 → 立刻切换         ✓
 *   - 切到没碰过的范围 → 回到该范围默认  ✓
 *   - 切回碰过的范围 → 记住用户的选择    ✓
 */

/** 全局时间范围。跟 Dashboard 的 `TimeRange` 对齐。 */
export type TimeRangeKey = '15m' | '1h' | '6h';

/** 所有时间范围(用于建默认值表)。 */
export const TIME_RANGE_KEYS: TimeRangeKey[] = ['15m', '1h', '6h'];

/**
 * 各时间范围内, 卫星切换标记的**默认**可见性。
 *
 * - `15m` → 开启(事件稀疏, ★ 能起到标注作用)
 * - `1H` / `6H` → 关闭(事件密集, 会把折线糊住)
 */
export function handoffsVisibleByDefault(range: TimeRangeKey): boolean {
  return range === '15m';
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
