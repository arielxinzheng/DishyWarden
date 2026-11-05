/**
 * 【刚刚恢复 (Recently Resolved)】—— 状态编排层
 *
 * 分层职责:
 *   useRecentlyResolved.ts    ← 本文件: 何时拉、何时重算、已读偏好存哪
 *   recentlyResolved.ts       纯变换: 记录 → 可见列表; localStorage 编解码
 *   RecentlyResolvedCard.tsx  纯展示, 不发请求、不碰 storage
 *
 * 为什么单独成 hook 而不写在 index.tsx 里:
 *   那是 1000+ 行的聚合组件。"数据源 + 定时器 + 已读偏好"三件事摊进去会让它
 *   再多背一个关注点。抽出来后, 这个卡片的整个状态机只住在一个文件里 ——
 *   能单独读、单独测, 换数据源时也不用碰首页。
 *
 * 为什么数据源是「查询」而不是「onAlertResolved 事件」:
 *   事件只在应用运行期间到达。用户关掉应用、半小时后回来, 那次中断的恢复事件
 *   早就错过了。要满足「人不在场也能回溯」, 必须有能从库里直接重建窗口的路径 —
 *   事件只当失效信号, 收到后重查, 不作为数据来源。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addDismissedKey,
  dismissKeyOf,
  loadDismissedKeys,
  persistDismissedKeys,
  selectRecentlyResolved,
  type ResolvedAlertLike,
} from './recentlyResolved';

/** 重算节拍。卡片窗口是 1 小时, 30s 一档足够, 没必要每秒重排整页。 */
const TICK_MS = 30_000;

/** 库内只取一屏。1 小时窗口内的 critical 恢复量不会超过这个量级。 */
const QUERY_LIMIT = 20;

export interface RecentlyResolvedState {
  /** 已按恢复时间倒序、已过白名单/窗口/已读过滤 */
  alerts: readonly ResolvedAlertLike[];
  /** 与 alerts 判据同源的「现在」, 保证同一次渲染里相对时间口径一致 */
  now: number;
  dismiss: (alert: ResolvedAlertLike) => void;
}

/** 查库。失败返回 null —— 调用方保留上一批数据, 等下一个信号自然重试。 */
async function fetchResolved(): Promise<ResolvedAlertLike[] | null> {
  if (!window.electronAPI) return null;
  try {
    const { alerts } = await window.electronAPI.getAlertHistory({
      limit: QUERY_LIMIT,
      offset: 0,
      severity: 'critical',
      status: 'resolved',
    });
    return alerts || [];
  } catch {
    // 告警库短暂不可用不该让首页报错。返回 null 表示"没拿到", 不是"没有"。
    return null;
  }
}

export function useRecentlyResolved(): RecentlyResolvedState {
  const [records, setRecords] = useState<ResolvedAlertLike[]>([]);
  const [dismissed, setDismissed] = useState<string[]>(loadDismissedKeys);
  // 纯重算触发器: 窗口滑出、相对时间走动都靠它推动, 它本身不是"现在"
  const [tickAt, setTickAt] = useState(() => Date.now());

  const reload = useCallback(async () => {
    const next = await fetchResolved();
    if (next) setRecords(next);
  }, []);

  // 秒级响应: 一条告警刚恢复就立刻重新查询, 不让用户等 tick。
  useEffect(() => {
    if (!window.electronAPI) return;
    const offResolved = window.electronAPI.onAlertResolved(() => reload());
    return offResolved;
  }, [reload]);

  // 兜底对齐: 降噪 / 误报 / 手动恢复都不发 onAlertResolved, 只在库里改 status。
  // 与其给每种动作各挂一个事件(漏一个就是一个残留 bug), 干脆让 tick 定期做
  // 全量对齐 —— 最终一致性窗口 30s, 对"已恢复"这种回顾型信息足够。
  useEffect(() => {
    reload();
    const timer = setInterval(() => {
      reload();
      setTickAt(Date.now());
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [reload]);

  // 偏好落地放 effect 而非 updater 里: updater 必须保持纯,
  // StrictMode 下它会被调用两次。
  useEffect(() => {
    persistDismissedKeys(dismissed);
  }, [dismissed]);

  const dismiss = useCallback((alert: ResolvedAlertLike) => {
    setDismissed((prev) => addDismissedKey(prev, dismissKeyOf(alert)));
  }, []);

  // now 取实时值而非 tickAt: tick 是上一次的刻度, 拿它当 now 会把刚恢复的告警
  // 判成"未来时间", 漏显一整个 tick 周期。
  const view = useMemo(() => {
    const now = Date.now();
    return { now, alerts: selectRecentlyResolved(records, { now, dismissed }) };
  }, [records, dismissed, tickAt]);

  return { ...view, dismiss };
}