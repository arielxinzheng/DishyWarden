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
 * 严重等级已在 selectRecentlyResolved 里按 severity 收口, 这里只负责把 ruleId
 * 翻成人话。没收录的用后端 summary —— 硬编码全量映射会随规则演进腐坏,
 * 后端 summary 才是权威文案。
 */
const SCENARIO_LABEL: Record<string, string> = {
  dish_offline: '网络中断',
  collector_heartbeat_lost: '采集器离线',
  cable_connectivity: '连接线断开',
  router_offline: '路由器离线',
  motors_stowed: '天线电机停转',
  poe_power: '供电异常',
};

export function scenarioOf(alert: ResolvedAlertLike): string {
  const label = SCENARIO_LABEL[alert.alert_type];
  if (label) return label;
  const summary = (alert.summary || '').trim();
  return summary || '服务异常';
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

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

/** 相对时间: `刚刚` / `12 分钟前` / `1 小时前` —— 撑起「刚恢复」的心智 */
export function formatAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '刚刚';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
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