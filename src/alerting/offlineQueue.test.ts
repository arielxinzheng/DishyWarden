/**
 * 网络路径判定 + 离线队列聚合（降噪）测试。
 */

import { describe, it, expect } from 'vitest';
import { resolveNetworkPath, describeNetworkPath } from './networkPath';
import {
  aggregateByType,
  buildRecoverySummary,
  defaultAlertLabel,
  queuedToAlertRecord,
  type QueuedAlert,
} from './offlineQueue';

describe('外网路径判定', () => {
  it('公网不通 ⇒ none（进离线队列）', () => {
    expect(resolveNetworkPath({ publicReachable: false, starlinkOnline: true })).toBe('none');
    expect(resolveNetworkPath({ publicReachable: false, starlinkOnline: false })).toBe('none');
  });

  it('公网通 + 星链在线 ⇒ starlink', () => {
    expect(resolveNetworkPath({ publicReachable: true, starlinkOnline: true })).toBe('starlink');
  });

  it('公网通 + 星链不在线 ⇒ backup（多 WAN / 5G 备线，照发）', () => {
    expect(resolveNetworkPath({ publicReachable: true, starlinkOnline: false })).toBe('backup');
  });

  it('路径描述', () => {
    expect(describeNetworkPath('none')).toContain('无外网');
    expect(describeNetworkPath('backup')).toContain('备线');
  });
});

describe('离线队列聚合（降噪）', () => {
  const item = (alertType: string, id: number): QueuedAlert => ({
    id,
    channel: 'telegram',
    alert_key: `${alertType}:starlink`,
    alert_type: alertType,
    severity: 'warning',
    summary: 's',
    description: null,
    evidence: null,
    recommendations: null,
    context: null,
    queued_at: '2026-11-10T00:00:00.000Z',
    flushed_at: null,
  });

  it('按类型计数，多的排前面', () => {
    const groups = aggregateByType([
      item('obstruction', 1),
      item('obstruction', 2),
      item('obstruction', 3),
      item('packet_loss', 4),
      item('packet_loss', 5),
    ]);
    expect(groups).toEqual([
      { alertType: 'obstruction', count: 3 },
      { alertType: 'packet_loss', count: 2 },
    ]);
  });

  it('汇总文案包含总数与各类型条数', () => {
    const summary = buildRecoverySummary(
      [
        { alertType: 'obstruction', count: 5 },
        { alertType: 'packet_loss', count: 3 },
      ],
      (t) => (t === 'obstruction' ? '遮挡告警' : '丢包告警'),
    );
    expect(summary).toContain('网络已恢复');
    expect(summary).toContain('共发生 8 条告警');
    expect(summary).toContain('5 条遮挡告警');
    expect(summary).toContain('3 条丢包告警');
    expect(summary).toContain('详见控制台');
  });

  it('空队列也有话说', () => {
    const summary = buildRecoverySummary([], () => 'x');
    expect(summary).toContain('网络已恢复');
    expect(summary).toContain('没有积压告警');
  });

  it('默认标签：规则名不带「告警」时补上', () => {
    expect(defaultAlertLabel('严重丢包')).toBe('严重丢包告警');
    expect(defaultAlertLabel('遮挡告警')).toBe('遮挡告警');
  });

  it('队列记录能还原成告警记录', () => {
    const record = queuedToAlertRecord(item('obstruction', 7));
    expect(record.alert_type).toBe('obstruction');
    expect(record.alert_key).toBe('obstruction:starlink');
    expect(record.summary).toBe('s');
  });
});
