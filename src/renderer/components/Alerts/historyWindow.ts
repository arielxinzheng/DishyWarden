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
  /** 语义标签（今日 / 昨日 / 具体日期），文案由视图层按当前语言渲染 */
  label: DayLabel;
  items: T[];
}

/**
 * 日期分割线标题的语义形态。
 *
 * 这里不返回成句文案（`今日 (11月5日)` / `Yesterday (Nov 4)` 是两种语序），
 * 只给出「属于哪一类日期 + 哪个日期」，翻译与日期格式化都交给视图层。
 */
export interface DayLabel {
  kind: 'today' | 'yesterday' | 'date' | 'unknown';
  /** 本地 `YYYY-MM-DD`；`unknown` 时为空串 */
  dayKey: string;
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

/**
 * 日期格式化用的 locale。
 *
 * 只有 zh-CN / en 有完整字典：浏览器语言可能是 ja / ko / vi，那种情况下
 * 界面文案会 fallback 到英文，日期也应跟着用英文格式，而不是格式化成
 * 日文/韩文的日期 —— 否则半中半英的界面更不可读。
 */
export function formatLocaleOf(language: string): string {
  return language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/**
 * `2026-11-05` → 当前语言的「月日」，例如 zh-CN `11月5日`、en `Nov 5`。
 *
 * 只做**格式化**不做拼句：月份写法由 `Intl.DateTimeFormat` 按 locale 给出，
 * 不再是写死的「月 / 日」汉字，切到英文时不会残留中文。
 */
export function formatMonthDay(dayKey: string, locale: string): string {
  const parts = dayKey.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return '';
  // 用本地年月日构造，避免 `new Date('2026-11-05')` 被当成 UTC 日期而偏一天
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
}

/**
 * 分组键 → 分割线标签语义。
 * 跨年的日期只写 `2026-11-03` 而不写「11月3日」，否则今年和去年的同一天
 * 看起来一模一样。
 */
export function dayLabelOf(dayKey: string, now: number): DayLabel {
  if (!dayKey) return { kind: 'unknown', dayKey: '' };
  if (dayKey === ymdOf(now)) return { kind: 'today', dayKey };
  if (dayKey === ymdOf(shiftDays(now, -1))) return { kind: 'yesterday', dayKey };
  return { kind: 'date', dayKey };
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