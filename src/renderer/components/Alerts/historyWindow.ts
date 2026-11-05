/**
 * 历史页时间语义 —— 纯逻辑，无 React、无 IPC、无 AlertRecord
 *
 * 「7 天窗口怎么算」「分割线该写今日还是日期」这类判断全部收在这里，
 * 组件只负责把结果摆上去。时间边界只有一个实现，才不会出现
 * 列表按 A 口径查询、分割线按 B 口径分组的错位。
 *
 * 泛型约束 `{ last_seen: string }` 而不是 import AlertRecord：
 * 这一层不该知道告警长什么样，只关心它有个时间戳。
 */

/** 默认窗口：含今天在内的最近 7 个自然日 */
export const DEFAULT_WINDOW_DAYS = 7;

/** 日期范围，两端都是本地 `YYYY-MM-DD`（date input 的原生取值形态） */
export interface YmdRange {
  from: string;
  to: string;
}

/** ISO 区间，用于查询条件 */
export interface IsoRange {
  from: string;
  to: string;
}

export interface HistoryGroup<T> {
  /** 本地 `YYYY-MM-DD`，同一段内唯一 */
  dayKey: string;
  /** `今日 (11月5日)` / `昨日 (11月4日)` / `2026-11-03` */
  label: string;
  items: T[];
}

/** ms → 本地 `YYYY-MM-DD` */
export function ymdOf(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 按日历日平移，不是 ±24h。
 * 夏令时切换那天只有 23 或 25 小时，用毫秒加减会把日期算偏一天。
 */
function shiftDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** ISO → 本地 `YYYY-MM-DD`。解析失败返回空串（脏数据不该让整页炸掉） */
export function dayKeyOf(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ymdOf(ms) : '';
}

/** `2026-11-05` → `11月5日`（去掉前导零，符合中文习惯） */
export function monthDayOf(dayKey: string): string {
  const parts = dayKey.split('-');
  return `${Number(parts[1])}月${Number(parts[2])}日`;
}

/**
 * 分组键 → 分割线标题。
 * 跨年的日期只写 `2026-11-03` 而不写「11月3日」，否则今年和去年的同一天
 * 看起来一模一样。
 */
export function dayLabelOf(dayKey: string, now: number): string {
  if (!dayKey) return '日期未知';
  if (dayKey === ymdOf(now)) return `今日 (${monthDayOf(dayKey)})`;
  if (dayKey === ymdOf(shiftDays(now, -1))) return `昨日 (${monthDayOf(dayKey)})`;
  return dayKey;
}

/**
 * 默认窗口：今天 00:00 往前推 6 个自然日 → 现在。
 *
 * 为什么不用「now 往前推 7×24h」：列表是按日期分组的，起点一旦落在某个
 * 半天，第一段就只剩几小时的数据，看起来像丢了一截。
 */
export function defaultRange(now: number): IsoRange {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  startOfToday.setDate(startOfToday.getDate() - (DEFAULT_WINDOW_DAYS - 1));
  return { from: startOfToday.toISOString(), to: new Date(now).toISOString() };
}

/**
 * `YYYY-MM-DD` → 本地当天 00:00:00.000 的 ISO。
 *
 * 必须用 new Date(y, m-1, d) 而不是 new Date('2026-11-05')：后者按 UTC
 * 解释纯日期串，在东八区会落到前一天 08:00，整个区间偏移一天。
 */
export function startOfDayIso(ymd: string): string {
  const parts = ymd.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0).toISOString();
}

/** `YYYY-MM-DD` → 本地当天 23:59:59.999 的 ISO（含尾整天） */
export function endOfDayIso(ymd: string): string {
  const parts = ymd.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59, 999).toISOString();
}

/** 用户选的日期范围 → 查询用的 ISO 区间 */
export function ymdRangeToIso(range: YmdRange): IsoRange {
  return { from: startOfDayIso(range.from), to: endOfDayIso(range.to) };
}

/**
 * 按 last_seen 的本地日期切段。
 *
 * 只做相邻聚合，不排序 —— 排序是后端契约（ORDER BY last_seen DESC），
 * 这里再排一次就成了第二份判据，两处漂移时会出现「分割线顺序和卡片顺序
 * 对不上」这种最难查的错。
 */
export function groupByDay<T extends { last_seen: string }>(
  items: readonly T[],
  now: number
): HistoryGroup<T>[] {
  const groups: HistoryGroup<T>[] = [];
  let current: HistoryGroup<T> | null = null;

  for (const item of items) {
    const dayKey = dayKeyOf(item.last_seen);
    if (!current || current.dayKey !== dayKey) {
      current = { dayKey, label: dayLabelOf(dayKey, now), items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }

  return groups;
}