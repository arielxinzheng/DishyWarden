/**
 * DNS 探针的「依赖抑制」测试。
 *
 * 背景：DNS 探针失败有两种完全不同的含义 ——
 *   ① 解析失败（NXDOMAIN / SERVFAIL / 超时）⇒ 真的是 DNS 问题
 *   ② 目标不可达（ECONNREFUSED / 主机不可达）⇒ **被测数据源本身下线了**
 *
 * ② 若按 ① 报成"域名解析失败"，就是误诊：用户会以为自己的 DNS 配置坏了，
 * 实际挂掉的是本地 mock / 探针目标。所以 ② 必须走独立的告警类型。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AlertManager } from './manager';
import type { AlertRecord } from './database';

vi.mock('./database', () => {
  return {
    AlertDatabase: class MockAlertDatabase {
      private alerts: Map<string, AlertRecord> = new Map();
      private idCounter = 1;

      upsertAlert(alert: AlertRecord): 'new' | 'ongoing' | 'resolved' {
        const existing = this.alerts.get(alert.alert_key);

        if (!existing) {
          this.alerts.set(alert.alert_key, { ...alert, id: this.idCounter++ });
          return 'new';
        } else if (existing.status === 'ongoing' && alert.status === 'resolved') {
          this.alerts.set(alert.alert_key, { ...existing, ...alert });
          return 'resolved';
        } else {
          const updated = {
            ...existing,
            occurrence_count: existing.occurrence_count + 1,
            last_seen: alert.last_seen,
          };
          this.alerts.set(alert.alert_key, updated);
          return 'ongoing';
        }
      }

      markNotified(alertKey: string): void {
        const alert = this.alerts.get(alertKey);
        if (alert) {
          alert.notification_count++;
          alert.last_notified_at = new Date().toISOString();
        }
      }

      getAlertByKey(alertKey: string): any {
        return this.alerts.get(alertKey);
      }

      getActiveAlerts(): any[] {
        return Array.from(this.alerts.values()).filter(
          (a: { status: string }) => a.status === 'new' || a.status === 'ongoing'
        );
      }

      getAlertsNeedingUpdate(): any[] {
        const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
        return Array.from(this.alerts.values()).filter((a) => {
          if (a.status !== 'ongoing') return false;
          if (!a.last_notified_at) return true;
          if (a.last_notified_at < threeHoursAgo) return true;
          if (a.occurrence_count % 10 === 0 && a.occurrence_count > a.notification_count * 10) {
            return true;
          }
          return false;
        });
      }

      cleanupResolvedAlerts(daysToKeep: number): number {
        const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
        let count = 0;
        for (const [key, alert] of this.alerts.entries()) {
          if (alert.status === 'resolved' && alert.last_seen < cutoffDate) {
            this.alerts.delete(key);
            count++;
          }
        }
        return count;
      }

      getAlertHistory(
        limit: number,
        offset: number,
        severityFilter?: string,
        statusFilter?: string
      ): any[] {
        let filtered = Array.from(this.alerts.values());

        if (severityFilter) {
          filtered = filtered.filter((a) => a.severity === severityFilter);
        }
        if (statusFilter) {
          filtered = filtered.filter((a) => a.status === statusFilter);
        }

        return filtered
          .sort((a, b) => b.last_seen.localeCompare(a.last_seen))
          .slice(offset, offset + limit);
      }

      getAlertCount(severityFilter?: string, statusFilter?: string): number {
        let filtered = Array.from(this.alerts.values());

        if (severityFilter) {
          filtered = filtered.filter((a) => a.severity === severityFilter);
        }
        if (statusFilter) {
          filtered = filtered.filter((a) => a.status === statusFilter);
        }

        return filtered.length;
      }

      /** 离线队列清理（GC） */
      cleanupFlushedOfflineAlerts = vi.fn((_daysToKeep = 0) => 0);

      close(): void {
        this.alerts.clear();
      }
    },
  };
});

// 通知配置形状见 src/alerting/notifier.ts 的 NotificationConfig；
// 这里全部关掉，避免测试真的往外发请求。
const mockNotificationConfig = {
  telegram: { enabled: false, botToken: '', chatId: '' },
  webhook: { enabled: false, url: '' },
  email: { enabled: false, smtpHost: '', smtpPort: 0, from: '', to: '', user: '', password: '' },
  sms: { enabled: false, url: '', method: 'POST' as const, headers: {} },
} as any;

/** 构造一个 DNS 探针结果 */
const dnsResult = (failureMode: 'unreachable' | 'resolution', error: string) => ({
  nodeId: 'dns-dual-check',
  ok: false,
  rttMs: null,
  error,
  detail: 'test',
  failureMode,
  ts: Date.now(),
  dualDns: {
    user: { ok: false, rttMs: null, error, failureMode },
    baseline: { ok: false, rttMs: null, error, failureMode },
  },
});

const okResult = {
  nodeId: 'dns-dual-check',
  ok: true,
  rttMs: 8,
  detail: '双轨探测正常',
  ts: Date.now(),
  dualDns: {
    user: { ok: true, rttMs: 8, resolvedIp: '127.0.0.1' },
    baseline: { ok: true, rttMs: 3, resolvedIp: '127.0.0.1' },
  },
};

describe('DNS 探针依赖抑制', () => {
  let manager: AlertManager;

  beforeEach(() => {
    manager = new AlertManager(mockNotificationConfig, { highLatencyMs: 100, highPacketLoss: 0.1 });
  });

  afterEach(() => {
    manager.close();
  });

  const activeTypes = () => manager.getActiveAlerts().map((a: any) => a.alert_type);

  it('目标不可达 → 报「数据源不可用」，不报「DNS 解析失败」', async () => {
    for (let i = 0; i < 3; i++) {
      await manager.checkDnsProbe(dnsResult('unreachable', 'ECONNREFUSED') as any);
    }

    expect(activeTypes()).toContain('probe_source_unavailable');
    expect(activeTypes()).not.toContain('dns_failure');
  });

  it('解析失败（ENOTFOUND）→ 仍然报「DNS 解析失败」，不报数据源不可用', async () => {
    for (let i = 0; i < 3; i++) {
      await manager.checkDnsProbe(dnsResult('resolution', 'ENOTFOUND') as any);
    }

    expect(activeTypes()).toContain('dns_failure');
    expect(activeTypes()).not.toContain('probe_source_unavailable');
  });

  it('模式从「解析失败」翻成「不可达」→ 旧的 dns_failure 被撤掉', async () => {
    for (let i = 0; i < 3; i++) {
      await manager.checkDnsProbe(dnsResult('resolution', 'ENOTFOUND') as any);
    }
    expect(activeTypes()).toContain('dns_failure');

    // 同一个节点改判为"数据源不可达"
    for (let i = 0; i < 3; i++) {
      await manager.checkDnsProbe(dnsResult('unreachable', 'ECONNREFUSED') as any);
    }

    const types = activeTypes();
    expect(types).toContain('probe_source_unavailable');
    expect(types).not.toContain('dns_failure');
  });

  it('数据源恢复 → 「数据源不可用」自动解除', async () => {
    for (let i = 0; i < 3; i++) {
      await manager.checkDnsProbe(dnsResult('unreachable', 'ECONNREFUSED') as any);
    }
    expect(activeTypes()).toContain('probe_source_unavailable');

    await manager.checkDnsProbe(okResult as any);
    expect(activeTypes()).not.toContain('probe_source_unavailable');
  });

  it('连续失败不足 3 次不告警（沿用故障确认次数）', async () => {
    await manager.checkDnsProbe(dnsResult('unreachable', 'ECONNREFUSED') as any);
    await manager.checkDnsProbe(dnsResult('unreachable', 'ECONNREFUSED') as any);
    expect(activeTypes()).not.toContain('probe_source_unavailable');
  });
});
