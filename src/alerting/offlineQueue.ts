/**
 * 离线暂存队列（Store & Forward）。
 *
 * ## 要解决的问题
 *
 * 断网时公网通道（Telegram / Email / 公网 Webhook）发不出去。两种错误做法：
 * - 死等重试 ⇒ 阻塞告警线程，告警流程被拖死；
 * - 直接丢弃 ⇒ 用户永远不知道断网期间发生过什么。
 *
 * 正确做法：**捕获超时，把告警序列化进本地 SQLite**，网络恢复后补发。
 *
 * ## 补发时必须聚合
 *
 * 断网一晚上可能积 50 条告警 —— 恢复时连发 50 封邮件是灾难（用户会直接
 * 静音掉整个通道）。所以补发时按**告警类型聚合成一条汇总**：
 *
 *   🔔 网络已恢复。断网期间共发生 5 条遮挡告警，3 条丢包告警（详见控制台）。
 *
 * 原始条目仍然留在队列里（标记为已冲刷），控制台可以查细节。
 */

import type { AlertRecord } from './database';

/** 队列里的一条待补发告警 */
export interface QueuedAlert {
  id: number;
  channel: string;
  alert_key: string;
  alert_type: string;
  severity: string;
  summary: string;
  description: string | null;
  evidence: string | null;
  recommendations: string | null;
  /** 通知上下文（new / resolved / duration 等）的 JSON */
  context: string | null;
  queued_at: string;
  flushed_at: string | null;
}

/** 聚合后的一组 */
export interface AggregatedGroup {
  alertType: string;
  count: number;
}

/**
 * 按告警类型聚合。
 *
 * 顺序：按条数从多到少，同数按类型名排序 —— 汇总信息里最重要的告警排在前面。
 */
export function aggregateByType(items: QueuedAlert[]): AggregatedGroup[] {
  const counter = new Map<string, number>();
  for (const item of items) {
    counter.set(item.alert_type, (counter.get(item.alert_type) ?? 0) + 1);
  }
  return [...counter.entries()]
    .map(([alertType, count]) => ({ alertType, count }))
    .sort((a, b) => (b.count - a.count) || a.alertType.localeCompare(b.alertType));
}

/**
 * 生成汇总文案。
 *
 * @param groups  聚合结果
 * @param labelOf 告警类型 → 中文短标签（通常取规则名）
 */
export function buildRecoverySummary(
  groups: AggregatedGroup[],
  labelOf: (alertType: string) => string,
): string {
  if (groups.length === 0) {
    return '🔔 网络已恢复。断网期间没有积压告警。';
  }

  const total = groups.reduce((sum, g) => sum + g.count, 0);
  const parts = groups.map((g) => `${g.count} 条${labelOf(g.alertType)}`);

  return (
    `🔔 网络已恢复。断网期间共发生 ${total} 条告警：` +
    `${parts.join('、')}（详见控制台）。`
  );
}

/**
 * 汇总用的告警标签。
 *
 * 规则名一般已经是名词短语（「严重丢包」「天线视野遮挡」），
 * 后面补「告警」读起来更顺；若规则名自带「告警」就不重复补。
 */
export function defaultAlertLabel(alertType: string): string {
  return alertType.endsWith('告警') ? alertType : `${alertType}告警`;
}

/** 把一条队列记录还原成可发送的告警记录（用于补发） */
export function queuedToAlertRecord(item: QueuedAlert): AlertRecord {
  return {
    id: 0,
    alert_key: item.alert_key,
    alert_type: item.alert_type,
    severity: item.severity,
    status: 'ongoing',
    first_seen: item.queued_at,
    last_seen: item.queued_at,
    occurrence_count: 1,
    last_notified_at: null,
    notification_count: 0,
    summary: item.summary,
    description: item.description ?? '',
    evidence: item.evidence,
    recommendations: item.recommendations,
    snooze_until: null,
    snooze_type: null,
    marked_false_positive: 0,
    created_at: item.queued_at,
    updated_at: item.queued_at,
  } as AlertRecord;
}
