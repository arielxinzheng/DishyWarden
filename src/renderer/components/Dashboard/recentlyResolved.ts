/**
 * 【刚刚恢复 (Recently Resolved)】—— 短时留存纯逻辑层
 *
 * 分层职责:
 *   index.tsx                 拉数据 + 打 tick + 组装
 *   recentlyResolved.ts       ← 本文件: 数据 → 可见列表的纯变换; localStorage 读写
 *   RecentlyResolvedCard.tsx  纯展示, 不发请求、不碰 storage
 *
 * 为什么数据源是「查询」而不是「onAlertResolved 事件」:
 *   事件只在应用运行期间到达。用户关掉应用、半小时后回来, 那次中断的恢复事件
 *   早就错过了。要满足「人不在场也能回溯」, 必须有能从库里直接重建窗口的路径 ——
 *   事件只当失效信号, 收到后重查, 不作为数据来源。
 *
 * 为什么用 last_seen 当恢复时刻:
 *   AlertDatabase.upsertAlert 的 ongoing→resolved 分支把 last_seen 写成 resolve
 *   那一刻 (database.ts「告警恢复」)。表里没有 resolved_at 列, 但 resolved 态的
 *   last_seen 就是恢复时间, 够用, 不必为此加一次列迁移。
 */

/** 留存窗口: 最近 1 小时内恢复的告警才上首页 */
export const RESOLVED_WINDOW_MS = 60 * 60 * 1000;

/** 首页最多同时铺 3 条, 其余折成「还有 N 条」 */
export const VISIBLE_LIMIT = 3;

const DISMISS_STORAGE_KEY = 'slmonitor.dashboard.dismissedResolved';
const MAX_DISMISSED_KEYS = 50;

/**
 * 展示所需的最小字段集。
 * 故意不 import AlertRecord —— 那个类型住在主进程模块里, renderer
 * 只该依赖契约形状, 不该依赖主进程实现。
 */
export interface ResolvedAlertLike {
  alert_key: string;
  alert_type: string;
  severity: string;
  first_seen: string;
  last_seen: string;
  summary: string;
}

const parseTs = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
};

export const recoveredAt = (alert: ResolvedAlertLike): number => parseTs(alert.last_seen);

/**
 * 关闭标记带上 last_seen。
 * 同一个 alert_key 今天可能恢复两次, 关掉第一次不该把第二次也一起吞掉。
 */
export const dismissKeyOf = (alert: ResolvedAlertLike): string =>
  `${alert.alert_key}@${alert.last_seen}`;

/**
 * 记录 → 可见列表。
 *
 * 唯一收口点: severity 白名单、1 小时窗口、用户已读过滤、排序全在这里。
 * 展示层不许再复制一份过滤条件 —— 两处判据会漂移。
 */
export function selectRecentlyResolved(
  records: readonly ResolvedAlertLike[],
  { now, dismissed }: { now: number; dismissed: readonly string[] }
): ResolvedAlertLike[] {
  const hidden = new Set(dismissed);
  const windowStart = now - RESOLVED_WINDOW_MS;

  return records
    .filter((alert) => alert.severity === 'critical')
    .filter((alert) => {
      const at = recoveredAt(alert);
      return at > windowStart && at <= now;
    })
    .filter((alert) => !hidden.has(dismissKeyOf(alert)))
    .sort((a, b) => recoveredAt(b) - recoveredAt(a));
}

/**
 * 已知故障场景的**语义码**。
 *
 * ⚠️ 本文件是纯逻辑层, 不产出中文文案 —— 文案统一由视图层从
 * `dashboard:recently_resolved.scenario_*` 取; 单测断言这些码, 不依赖界面语言。
 */
export type ResolvedScenario =
  | 'dish_offline'
  | 'collector_heartbeat_lost'
  | 'cable_connectivity'
  | 'router_offline'
  | 'motors_stowed'
  | 'poe_power';

/** 规则 id → 场景码。没收录的返回 null, 由视图层用后端 summary 兜底。 */
const SCENARIO_CODES: Record<string, ResolvedScenario> = {
  dish_offline: 'dish_offline',
  collector_heartbeat_lost: 'collector_heartbeat_lost',
  cable_connectivity: 'cable_connectivity',
  router_offline: 'router_offline',
  motors_stowed: 'motors_stowed',
  poe_power: 'poe_power',
};

export function scenarioOf(alert: ResolvedAlertLike): ResolvedScenario | null {
  return SCENARIO_CODES[alert.alert_type] ?? null;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

const clockOf = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const dayOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

/** 故障区间: 同日 `14:05 - 14:10`, 跨日 `11/5 14:05 - 11/6 01:10` */
export function formatSpan(firstIso: string, lastIso: string): string {
  const start = parseTs(firstIso);
  const end = parseTs(lastIso);
  if (!start || !end) return '';
  const sameDay = new Date(start).toDateString() === new Date(end).toDateString();
  return sameDay
    ? `${clockOf(start)} - ${clockOf(end)}`
    : `${dayOf(start)} ${clockOf(start)} - ${dayOf(end)} ${clockOf(end)}`;
}

/**
 * 时长 → **结构化描述**, 不返回句子。
 *
 * 单位/数值由视图层按当前语言套模板（`duration_minutes` /
 * `duration_hours_minutes` …），这样中英文的语序/单位词都不用在这里分裂。
 */
export type DurationDescriptor =
  | { kind: 'below_minute' }
  | { kind: 'minutes'; minutes: number }
  | { kind: 'hours'; hours: number }
  | { kind: 'hours_minutes'; hours: number; minutes: number };

export function describeDuration(ms: number): DurationDescriptor | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return { kind: 'below_minute' };
  if (minutes < 60) return { kind: 'minutes', minutes };
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? { kind: 'hours', hours }
    : { kind: 'hours_minutes', hours, minutes: rest };
}

/**
 * 相对时间 → **语义码**: `刚刚` / `N 分钟前` / `N 小时前` —— 撑起「刚恢复」的心智。
 * 单位与语序交给视图层（common:just_now / minutes_ago / hours_ago）。
 */
export type RelativeAge =
  | { unit: 'just_now' }
  | { unit: 'minutes'; count: number }
  | { unit: 'hours'; count: number };

export function relativeAge(ms: number): RelativeAge {
  if (!Number.isFinite(ms) || ms < 0) return { unit: 'just_now' };
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return { unit: 'just_now' };
  if (minutes < 60) return { unit: 'minutes', count: minutes };
  return { unit: 'hours', count: Math.floor(minutes / 60) };
}

export function loadDismissedKeys(): string[] {
  try {
    const raw = window.localStorage.getItem(DISMISS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key): key is string => typeof key === 'string');
  } catch {
    // 隐私模式 / 配额满 / 脏数据都可能抛。丢掉已读记录只是提示重新出现,
    // 不能因为读不到偏好就把整个仪表盘渲染挂掉。
    return [];
  }
}

export function persistDismissedKeys(keys: readonly string[]): void {
  try {
    window.localStorage.setItem(
      DISMISS_STORAGE_KEY,
      JSON.stringify(keys.slice(-MAX_DISMISSED_KEYS))
    );
  } catch {
    /* 同上: 持久化失败退化为本次会话内生效 */
  }
}

export const addDismissedKey = (keys: readonly string[], key: string): string[] =>
  keys.includes(key) ? keys.slice() : [...keys, key].slice(-MAX_DISMISSED_KEYS);