/**
 * 历史视图的查询条件 —— 纯逻辑，无 React
 *
 * 页面持有 `HistoryFilters`（用户意图），这里把它翻译成 IPC 契约
 * `AlertHistoryQuery`（后端可执行）。两件事分开是为了让"默认 7 天"
 * 这种规则只有一个落点：改窗口只改这里，页面不用知道 from/to 怎么算。
 *
 * 分页参数也在这里合并，避免页面到处拼 limit/offset。
 */

import { defaultRange, ymdRangeToIso, type YmdRange } from './historyWindow';
import type { Severity, Status } from '../../../alerting/database';

export type SeverityFilter = 'all' | Severity;

/**
 * 历史视图可能出现的状态 —— 只有终态。
 *
 * 用 `Extract` 从 `Status` 推导，而不是手写 `'resolved' | 'false_positive'`：
 * 终态集合在 `database.ts` 的 `TERMINAL_STATUSES` 里已有唯一定义，
 * 这里靠类型约束，写错状态名会立刻报错。
 *
 * `new` / `ongoing` 不在此列 —— 它们属于活跃视图。
 * 历史查询恒带 `terminalOnly`，后端把这两类排除在外，
 * 于是「告警」与「历史记录」两个列表按状态严格二分。
 */
export type HistoryStatus = Extract<Status, 'resolved' | 'false_positive'>;
export type StatusFilter = 'all' | HistoryStatus;

export interface HistoryFilters {
  severity: SeverityFilter;
  status: StatusFilter;
  /** null → 走默认「最近 7 天」窗口 */
  range: YmdRange | null;
  keyword: string;
}

export const DEFAULT_HISTORY_FILTERS: HistoryFilters = {
  severity: 'all',
  status: 'all',
  range: null,
  keyword: '',
};

/** 发往 IPC 的参数。from/to 一定存在：默认窗口也是区间查询 */
export interface HistoryQueryParams {
  limit: number;
  offset: number;
  from: string;
  to: string;
  severity?: Severity;
  status?: HistoryStatus;
  keyword?: string;
  /**
   * 字面量 `true` 而不是 `boolean`：这个翻译层只服务历史视图，
   * 永远不该产出「包含活跃告警」的查询。写成 boolean 就等于留了个
   * 可以让历史页查出 ongoing 的口子。
   */
  terminalOnly: true;
}

/**
 * filters + 分页 → IPC 参数。
 *
 * `now` 由调用方传入而不是内部取：同一个渲染帧里列表查询和分割线分组
 * 必须用同一个"现在"，否则跨过午夜那一秒会出现查询窗口和分组边界错位。
 */
export function toHistoryQuery(
  filters: HistoryFilters,
  page: number,
  pageSize: number,
  now: number
): HistoryQueryParams {
  const range = filters.range ? ymdRangeToIso(filters.range) : defaultRange(now);
  const keyword = filters.keyword.trim();

  return {
    limit: pageSize,
    offset: page * pageSize,
    from: range.from,
    to: range.to,
    // 历史视图恒查终态：ongoing / new 属于「告警」列表，不该在这里重复出现
    terminalOnly: true,
    // 条件为 'all' 时不下发该字段，而不是下发 undefined/空串：
    // SQL 侧只认"字段存在"这一种判据
    ...(filters.severity !== 'all' ? { severity: filters.severity } : {}),
    ...(filters.status !== 'all' ? { status: filters.status } : {}),
    ...(keyword !== '' ? { keyword } : {}),
  };
}

/** 用户是否偏离了默认窗口 —— 用于列表底部的范围提示 */
export function isDefaultWindow(filters: HistoryFilters): boolean {
  return filters.range === null;
}