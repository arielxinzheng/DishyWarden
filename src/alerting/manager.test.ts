/**
 * AlertManager + AlertDatabase 集成测试
 * 
 * 注意：better-sqlite3 编译为 Electron ABI (NODE_MODULE_VERSION 130)，
 * 无法在标准 node 环境运行。此测试使用 Mock 数据库验证业务逻辑。
 * 
 * 测试范围：
 * 1. 告警规则触发与去重逻辑
 * 2. 数据库接口契约（通过 Mock 验证）
 * 3. 告警状态转换（new → ongoing → resolved）
 * 4. 通知计数与降噪
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AlertManager } from './manager';
import type { AlertRecord } from './database';
import type { TelemetryData } from '../core/dishClient';

// Mock AlertDatabase module
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

      /** 离线队列清理（GC）—— 记录调用次数供断言 */
      cleanupFlushedOfflineAlerts = vi.fn((_daysToKeep = 0) => 0);

      close(): void {
        this.alerts.clear();
      }
    },
  };
});

describe('alerting 集成测试 - AlertDatabase Mock', () => {
  let db: any;

  beforeEach(async () => {
    const { AlertDatabase } = await import('./database');
    db = new AlertDatabase();
  });

  describe('告警记录与去重', () => {
    it('新告警正确写入', () => {
      const alert = {
        alert_key: 'high_latency',
        alert_type: 'high_latency',
        severity: 'warning' as const,
        status: 'new' as const,
        first_seen: '2024-01-15T10:00:00Z',
        last_seen: '2024-01-15T10:00:00Z',
        occurrence_count: 1,
        last_notified_at: null,
        notification_count: 0,
        summary: '延迟过高',
        description: '当前延迟 150ms',
        evidence: JSON.stringify({ latency: 150 }),
        recommendations: JSON.stringify(['检查网络']),
      };

      const result = db.upsertAlert(alert);
      expect(result).toBe('new');

      const retrieved = db.getAlertByKey('high_latency');
      expect(retrieved).toBeDefined();
      expect(retrieved!.alert_type).toBe('high_latency');
      expect(retrieved!.severity).toBe('warning');
      expect(retrieved!.occurrence_count).toBe(1);
    });

    it('重复告警增加计数', () => {
      const alert = {
        alert_key: 'high_latency',
        alert_type: 'high_latency',
        severity: 'warning' as const,
        status: 'ongoing' as const,
        first_seen: '2024-01-15T10:00:00Z',
        last_seen: '2024-01-15T10:00:00Z',
        occurrence_count: 1,
        last_notified_at: null,
        notification_count: 0,
        summary: '延迟过高',
        description: '当前延迟 150ms',
        evidence: JSON.stringify({ latency: 150 }),
        recommendations: JSON.stringify(['检查网络']),
      };

      db.upsertAlert(alert);
      alert.last_seen = '2024-01-15T10:01:00Z';
      const result = db.upsertAlert(alert);
      
      expect(result).toBe('ongoing');
      const retrieved = db.getAlertByKey('high_latency');
      expect(retrieved!.occurrence_count).toBe(2);
      expect(retrieved!.last_seen).toBe('2024-01-15T10:01:00Z');
    });

    it('告警恢复状态正确更新', () => {
      const alert = {
        alert_key: 'high_latency',
        alert_type: 'high_latency',
        severity: 'warning' as const,
        status: 'ongoing' as 'ongoing' | 'resolved',
        first_seen: '2024-01-15T10:00:00Z',
        last_seen: '2024-01-15T10:00:00Z',
        occurrence_count: 5,
        last_notified_at: null,
        notification_count: 0,
        summary: '延迟过高',
        description: '当前延迟 150ms',
        evidence: JSON.stringify({ latency: 150 }),
        recommendations: JSON.stringify(['检查网络']),
      };

      db.upsertAlert(alert);
      alert.status = 'resolved';
      alert.last_seen = '2024-01-15T10:05:00Z';
      const result = db.upsertAlert(alert);

      expect(result).toBe('resolved');
      const retrieved = db.getAlertByKey('high_latency');
      expect(retrieved!.status).toBe('resolved');
      expect(retrieved!.occurrence_count).toBe(5);
    });
  });

  describe('告警查询', () => {
    beforeEach(() => {
      db.upsertAlert({
        alert_key: 'alert_critical_1',
        alert_type: 'dish_offline',
        severity: 'critical',
        status: 'ongoing',
        first_seen: '2024-01-15T10:00:00Z',
        last_seen: '2024-01-15T10:05:00Z',
        occurrence_count: 5,
        last_notified_at: null,
        notification_count: 0,
        summary: '设备离线',
        description: '天线未连接',
        evidence: '{}',
        recommendations: '[]',
      });

      db.upsertAlert({
        alert_key: 'alert_warning_1',
        alert_type: 'high_latency',
        severity: 'warning',
        status: 'ongoing',
        first_seen: '2024-01-15T10:10:00Z',
        last_seen: '2024-01-15T10:10:00Z',
        occurrence_count: 1,
        last_notified_at: null,
        notification_count: 0,
        summary: '延迟过高',
        description: '当前延迟 150ms',
        evidence: '{}',
        recommendations: '[]',
      });

      db.upsertAlert({
        alert_key: 'alert_resolved_1',
        alert_type: 'obstruction',
        severity: 'warning',
        status: 'resolved',
        first_seen: '2024-01-15T09:00:00Z',
        last_seen: '2024-01-15T09:30:00Z',
        occurrence_count: 10,
        last_notified_at: null,
        notification_count: 0,
        summary: '遮挡已解除',
        description: '视野清晰',
        evidence: '{}',
        recommendations: '[]',
      });
    });

    it('getActiveAlerts 只返回活跃告警', () => {
      const active = db.getActiveAlerts();
      expect(active).toHaveLength(2);
      expect(active.every((a: { status: string }) => a.status === 'new' || a.status === 'ongoing')).toBe(true);
    });

    it('getAlertHistory 支持状态过滤', () => {
      const resolved = db.getAlertHistory(100, 0, undefined, 'resolved');
      expect(resolved.length).toBeGreaterThan(0);
      expect(resolved.every((a: { status: string }) => a.status === 'resolved')).toBe(true);

      const ongoing = db.getAlertHistory(100, 0, undefined, 'ongoing');
      expect(ongoing.length).toBe(2);
      expect(ongoing.every((a: { status: string }) => a.status === 'ongoing')).toBe(true);
    });

    it('getAlertHistory 支持严重性过滤', () => {
      const critical = db.getAlertHistory(100, 0, 'critical');
      expect(critical.length).toBeGreaterThan(0);
      expect(critical.every((a: { severity: string }) => a.severity === 'critical')).toBe(true);
    });

    it('getAlertHistory 支持分页', () => {
      const page1 = db.getAlertHistory(2, 0);
      expect(page1).toHaveLength(2);

      const page2 = db.getAlertHistory(2, 2);
      expect(page2.length).toBeLessThanOrEqual(1);
    });
  });

  describe('通知记录', () => {
    it('markNotified 正确更新通知计数', () => {
      db.upsertAlert({
        alert_key: 'test_alert',
        alert_type: 'test',
        severity: 'warning',
        status: 'ongoing',
        first_seen: '2024-01-15T10:00:00Z',
        last_seen: '2024-01-15T10:00:00Z',
        occurrence_count: 1,
        last_notified_at: null,
        notification_count: 0,
        summary: '测试告警',
        description: '测试',
        evidence: '{}',
        recommendations: '[]',
      });

      db.markNotified('test_alert');

      const alert = db.getAlertByKey('test_alert');
      expect(alert!.notification_count).toBe(1);
      expect(alert!.last_notified_at).not.toBeNull();
    });

    it('多次通知累加计数', () => {
      db.upsertAlert({
        alert_key: 'test_alert',
        alert_type: 'test',
        severity: 'warning',
        status: 'ongoing',
        first_seen: '2024-01-15T10:00:00Z',
        last_seen: '2024-01-15T10:00:00Z',
        occurrence_count: 1,
        last_notified_at: null,
        notification_count: 0,
        summary: '测试告警',
        description: '测试',
        evidence: '{}',
        recommendations: '[]',
      });

      db.markNotified('test_alert');
      db.markNotified('test_alert');
      db.markNotified('test_alert');

      const alert = db.getAlertByKey('test_alert');
      expect(alert!.notification_count).toBe(3);
    });
  });
});

describe('alerting 集成测试 - AlertManager', () => {
  let manager: AlertManager;
  let mockNotificationConfig: any;

  // 字段严格对齐 TelemetryData (src/core/dishClient.ts) —— 多余字段或
  // 拼错的字段名会被 TS 拦下, 而这些字段只设不断言, 留着只会误导。
  const createMockTelemetry = (overrides: Partial<TelemetryData> = {}): TelemetryData => ({
    state: 'ONLINE',
    uptime: 3600,
    snr: 8,
    popPingLatencyMs: 45,
    popPingDropRate: 0.01,
    downlinkThroughputBps: 50_000_000,
    uplinkThroughputBps: 5_000_000,
    fractionObstructed: 0.02,
    currentlyObstructed: false,
    secondsObstructed: 0,
    satelliteId: 12345,
    secondsToFirstNonemptySlot: 0,
    dishTemperature: 35,
    powerSupplyTemperature: 30,
    hardwareVersion: '1.0.0',
    softwareVersion: '1.0.0',
    // ⚠️ 这些**可选**字段必须给"正常值", 否则 undefined 会让
    //    gnss_positioning / router_offline 等规则误判为异常
    //    (gpsSats ?? 0 < 4 ⇒ 命中; connectedRouterCount ?? 0 === 0 ⇒ 命中)
    gpsValid: true,
    gpsSats: 12,
    gpsConvergenceState: 'CONVERGED',
    connectedRouterCount: 1,
    ethSpeedMbps: 1000,
    ethDuplex: 'full',
    wifiRssi: -45,
    wifiTxRate: 300,
    wifiRxRate: 300,
    // wifiRetransmitRate / wifiChannelUtilization 是**比例**(0-1), 不是百分比
    wifiChannelUtilization: 0.2,
    wifiRetransmitRate: 0.01,
    wifiClientCount: 2,
    // alignment_issue 要求状态字面量是 'FILTER_CONVERGED'
    attitudeEstimationState: 'FILTER_CONVERGED',
    tiltAngleDeg: 0,
    boresightAzimuthDeg: 135,
    boresightElevationDeg: 45,
    alignmentStats: {
      validS: true,
      attitudeUncertaintyDeg: 0.5,
      desiredBoresightAzimuthDeg: 135,
      desiredBoresightElevationDeg: 45,
    },
    // alerts 是 dishGetStatus.alerts 的**对象结构**(布尔标志),
    // 不是字符串数组 —— 规则用 hasAlert(data, 'thermalThrottle') 读。
    alerts: {},
    ...overrides,
  });

  beforeEach(() => {
    mockNotificationConfig = {
      webhookEnabled: false,
      emailEnabled: false,
      smsEnabled: false,
    };

    manager = new AlertManager(mockNotificationConfig, {
      highLatencyMs: 100,
      highPacketLoss: 0.1,
    });
  });

  afterEach(() => {
    manager.close();
  });

  describe('告警规则触发', () => {
    it('正常数据不触发告警', async () => {
      const data = createMockTelemetry();

      let alertTriggered = false;
      manager.once('alert:new', () => {
        alertTriggered = true;
      });

      await manager.checkTelemetry(data);

      expect(alertTriggered).toBe(false);
      const active = manager.getActiveAlerts();
      expect(active).toHaveLength(0);
    });

    it('频繁断线重连（10 分钟内翻转 ≥3 次）才报 frequent_searching', async () => {
      // 单帧 SEARCHING 只是正常锁星，跨帧反复横跳才是问题 —— 旧实现
      // 用 uptime > 600 冒充"卡了 10 分钟"，刚开机正常锁星的用户会被误报。
      for (let i = 0; i < 6; i++) {
        await manager.checkTelemetry(
          createMockTelemetry({ state: i % 2 === 0 ? 'ONLINE' : 'SEARCHING' })
        );
      }
      const active = manager.getActiveAlerts();
      expect(active.some((a) => a.alert_type === 'frequent_searching')).toBe(true);
    });

    it('停止抖动满 5 分钟静默期后告警自动恢复', async () => {
      for (let i = 0; i < 6; i++) {
        await manager.checkTelemetry(
          createMockTelemetry({ state: i % 2 === 0 ? 'ONLINE' : 'SEARCHING' })
        );
      }
      expect(
        manager.getActiveAlerts().some((a) => a.alert_type === 'frequent_searching')
      ).toBe(true);

      // 把翻转时刻整体推到 6 分钟前：仍在 10 分钟计数窗口内（计数≥3），
      // 但已超过 5 分钟静默期 ⇒ 视为「已经稳定下来」，应当恢复
      (manager as any).linkFlips = (manager as any).linkFlips.map(
        (t: number) => t - 6 * 60_000
      );
      // 上一帧停在 SEARCHING；若直接喂 ONLINE，这一帧本身又会被记成一笔新翻转，
      // 所以先把"上一次状态"也置为 ONLINE，模拟链路其实早就稳住了。
      (manager as any).lastLinkState = 'ONLINE';

      await manager.checkTelemetry(createMockTelemetry({ state: 'ONLINE' }));
      expect(
        manager.getActiveAlerts().some((a) => a.alert_type === 'frequent_searching')
      ).toBe(false);
    });

    it('状态稳定 ONLINE 时不报 frequent_searching', async () => {
      for (let i = 0; i < 10; i++) {
        await manager.checkTelemetry(createMockTelemetry({ state: 'ONLINE' }));
      }
      const active = manager.getActiveAlerts();
      expect(active.some((a) => a.alert_type === 'frequent_searching')).toBe(false);
    });

    it('连续卡在 SEARCHING 超过 10 分钟 ⇒ 报 frequent_searching', async () => {
      await manager.checkTelemetry(createMockTelemetry({ state: 'SEARCHING' }));
      // 把"进入搜星的时刻"往前推 11 分钟, 模拟持续卡住
      (manager as any).searchingSince = Date.now() - 11 * 60_000;
      await manager.checkTelemetry(createMockTelemetry({ state: 'SEARCHING' }));

      const active = manager.getActiveAlerts();
      expect(active.some((a) => a.alert_type === 'frequent_searching')).toBe(true);
    });

    it('设备上报 alerts.dns 时报 DNS 解析异常', async () => {
      // 回归: proto 里 `bool dns = 15` 是一等字段，此前没有任何规则消费它，
      // 设备报了等于白报。
      const data = createMockTelemetry({
        alerts: { dns: true } as any,
      });
      await manager.checkTelemetry(data);

      const active = manager.getActiveAlerts();
      expect(active.some((a) => a.alert_type === 'dns_resolution')).toBe(true);
    });

    it('alerts.dns 为 false 时不报 DNS 解析异常', async () => {
      await manager.checkTelemetry(createMockTelemetry({ alerts: { dns: false } as any }));
      expect(
        manager.getActiveAlerts().some((a) => a.alert_type === 'dns_resolution')
      ).toBe(false);
    });

    it('路由器数量反复变化时报「路由器反复掉线」', async () => {
      // router_offline 只抓"数量为 0"的彻底断开；抓不到"掉一下又回来"的抖动
      const counts = [2, 1, 2, 1, 2];
      for (const c of counts) {
        await manager.checkTelemetry(createMockTelemetry({ connectedRouterCount: c }));
      }
      const active = manager.getActiveAlerts();
      expect(active.some((a) => a.alert_type === 'router_flapping')).toBe(true);
      // 路由器始终至少有一台 ⇒ 不该报"路由器离线"
      expect(active.some((a) => a.alert_type === 'router_offline')).toBe(false);
    });

    it('路由器数量稳定时不报「路由器反复掉线」', async () => {
      for (let i = 0; i < 8; i++) {
        await manager.checkTelemetry(createMockTelemetry({ connectedRouterCount: 2 }));
      }
      expect(
        manager.getActiveAlerts().some((a) => a.alert_type === 'router_flapping')
      ).toBe(false);
    });

    it('路由器稳定后满 5 分钟静默期即恢复', async () => {
      for (const c of [2, 1, 2, 1, 2]) {
        await manager.checkTelemetry(createMockTelemetry({ connectedRouterCount: c }));
      }
      expect(
        manager.getActiveAlerts().some((a) => a.alert_type === 'router_flapping')
      ).toBe(true);

      // 把变化时刻推到 6 分钟前（仍在统计窗口内，但已过静默期）
      (manager as any).routerCountChanges = (manager as any).routerCountChanges.map(
        (t: number) => t - 6 * 60_000
      );
      (manager as any).lastRouterCount = 2;

      await manager.checkTelemetry(createMockTelemetry({ connectedRouterCount: 2 }));
      expect(
        manager.getActiveAlerts().some((a) => a.alert_type === 'router_flapping')
      ).toBe(false);
    });

    it('SEARCHING（正在锁星）不应报「天线未连接」', async () => {
      // 回归: 旧判据是 state !== 'ONLINE'，刚开始搜星的家庭网络会被判成
      // critical「天线未连接」；恶劣天气导致 SNR 掉到噪声底时也会触发，
      // 和 frequent_searching 双报。只有 OFFLINE 才是真的离线。
      const data = createMockTelemetry({ state: 'SEARCHING', uptime: 3600 });
      await manager.checkTelemetry(data);

      const active = manager.getActiveAlerts();
      expect(active.some((a) => a.alert_type === 'dish_offline')).toBe(false);
    });

    it('离线触发 critical 告警', async () => {
      const data = createMockTelemetry({ state: 'OFFLINE' });

      const alertPromise = new Promise((resolve) => {
        manager.once('alert:new', resolve);
      });

      await manager.checkTelemetry(data);
      await alertPromise;

      const active = manager.getActiveAlerts();
      expect(active).toHaveLength(1);
      expect(active[0].alert_type).toBe('dish_offline');
      expect(active[0].severity).toBe('critical');
    });

    it('高延迟触发 warning 告警', async () => {
      const data = createMockTelemetry({ popPingLatencyMs: 150 });

      const alertPromise = new Promise((resolve) => {
        manager.once('alert:new', resolve);
      });

      await manager.checkTelemetry(data);
      await alertPromise;

      const active = manager.getActiveAlerts();
      expect(active).toHaveLength(1);
      expect(active[0].alert_type).toBe('high_latency');
      expect(active[0].severity).toBe('warning');
    });

    it('高丢包触发 critical 告警', async () => {
      // snr 给 25(>15) ⇒ severe_weather 不满足"低SNR"条件, 只剩
      // high_packet_loss 一条 —— 本用例只验 high_packet_loss 这一条规则。
      // (snr=8 时 severe_weather 也会命中, 那是**另一个**规则的正确行为)
      const data = createMockTelemetry({ popPingDropRate: 0.15, snr: 25 });

      const alertPromise = new Promise((resolve) => {
        manager.once('alert:new', resolve);
      });

      await manager.checkTelemetry(data);
      await alertPromise;

      const active = manager.getActiveAlerts();
      expect(active).toHaveLength(1);
      expect(active[0].alert_type).toBe('high_packet_loss');
      expect(active[0].severity).toBe('critical');
    });

    it('遮挡触发 warning 告警', async () => {
      const data = createMockTelemetry({
        currentlyObstructed: true,
        fractionObstructed: 0.15,
      });

      const alertPromise = new Promise((resolve) => {
        manager.once('alert:new', resolve);
      });

      await manager.checkTelemetry(data);
      await alertPromise;

      const active = manager.getActiveAlerts();
      expect(active).toHaveLength(1);
      expect(active[0].alert_type).toBe('obstruction_detected');
    });

    it('多重异常触发多个告警', async () => {
      const data = createMockTelemetry({
        popPingLatencyMs: 150,
        popPingDropRate: 0.15,
        currentlyObstructed: true,
      });

      const alerts: any[] = [];
      manager.on('alert:new', (alert) => alerts.push(alert));

      await manager.checkTelemetry(data);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(alerts.length).toBeGreaterThanOrEqual(3);
      const types = alerts.map((a) => a.alert_type);
      expect(types).toContain('high_latency');
      expect(types).toContain('high_packet_loss');
      expect(types).toContain('obstruction_detected');
    });
  });

  describe('告警状态转换', () => {
    it('持续触发的告警增加计数', async () => {
      const data = createMockTelemetry({ popPingLatencyMs: 150 });

      await manager.checkTelemetry(data);
      await new Promise((resolve) => setTimeout(resolve, 50));

      let active = manager.getActiveAlerts();
      const firstCount = active[0].occurrence_count;

      await manager.checkTelemetry(data);
      await new Promise((resolve) => setTimeout(resolve, 50));

      active = manager.getActiveAlerts();
      expect(active[0].occurrence_count).toBeGreaterThan(firstCount);
    });

    it('告警恢复触发 resolved 事件', async () => {
      const badData = createMockTelemetry({ popPingLatencyMs: 150 });
      await manager.checkTelemetry(badData);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const goodData = createMockTelemetry({ popPingLatencyMs: 45 });

      const resolvedPromise = new Promise((resolve) => {
        manager.once('alert:resolved', resolve);
      });

      await manager.checkTelemetry(goodData);
      await resolvedPromise;

      const active = manager.getActiveAlerts();
      expect(active).toHaveLength(0);
    });
  });

  /**
   * 服务受限
   *
   * 数据取自 DishyMock 的 service_restriction 场景**实测响应**:
   *   disablementCode: 'SERVICE_RESTRICTED'
   *   classOfService:   'RESTRICTED'
   *   downlinkThroughputBps: 5000000   (5 Mbps, 卡在 low_throughput 阈值边缘)
   *   alerts: {}                        (空的, 所以不能靠 alerts 判)
   *
   * 这里覆盖的是曾经踩过的坑: 规则对象写了 `getDetails` 而不是
   * `summary/description/evidence`, 导致 checkTelemetry 调用
   * rule.summary() 抛 TypeError → 被 catch 吞掉 → 页面上**永远没有告警**,
   * 同时又因为 low_throughput 排除了服务受限 ⇒ 完全静默。
   */
  describe('服务受限告警', () => {
    const restricted = (overrides: Partial<TelemetryData> = {}) =>
      createMockTelemetry({
        classOfService: 'RESTRICTED',
        disablementCode: 'SERVICE_RESTRICTED',
        downlinkThroughputBps: 5_000_000,
        ...overrides,
      });

    it('触发「服务受限」告警', async () => {
      await manager.checkTelemetry(restricted());

      const types = manager.getActiveAlerts().map((a) => a.alert_type);
      expect(types).toContain('service_restricted');
    });

    it('告警内容完整 (summary/description/evidence 都不是空壳)', async () => {
      await manager.checkTelemetry(restricted());

      const alert = manager
        .getActiveAlerts()
        .find((a) => a.alert_type === 'service_restricted');

      expect(alert).toBeDefined();
      expect(alert!.summary).toBeTruthy();
      expect(alert!.description).toBeTruthy();
      expect(JSON.parse(alert!.evidence)).toMatchObject({
        disablement_code: 'SERVICE_RESTRICTED',
      });
    });

    it('只给 disablementCode 也能触发 (判据不能只认 classOfService)', async () => {
      await manager.checkTelemetry(
        restricted({ classOfService: undefined })
      );

      const types = manager.getActiveAlerts().map((a) => a.alert_type);
      expect(types).toContain('service_restricted');
    });

    it('只给 classOfService 也能触发', async () => {
      await manager.checkTelemetry(
        restricted({ disablementCode: undefined })
      );

      const types = manager.getActiveAlerts().map((a) => a.alert_type);
      expect(types).toContain('service_restricted');
    });

    it('服务受限时不再重复报「下行速率低」', async () => {
      await manager.checkTelemetry(restricted());

      const types = manager.getActiveAlerts().map((a) => a.alert_type);
      expect(types).not.toContain('low_throughput');
    });

    it('服务恢复后告警自动 resolve', async () => {
      await manager.checkTelemetry(restricted());
      await manager.checkTelemetry(createMockTelemetry());

      const types = manager.getActiveAlerts().map((a) => a.alert_type);
      expect(types).not.toContain('service_restricted');
    });
  });

  /**
   * alerts 布尔标志
   *
   * alerts 曾是 string[] (规则用 .includes('xxx')), 后改成对象结构。
   * 规则没跟着改 ⇒ `alerts.includes` 是 undefined ⇒ 调它抛 TypeError
   * ⇒ 这些规则全部静默失效。这里逐条钉住。
   */
  describe('alerts 布尔标志 (对象结构)', () => {
    const activeTypes = () => manager.getActiveAlerts().map((a) => a.alert_type);

    it('thermalThrottle → thermal_throttle', async () => {
      await manager.checkTelemetry(
        createMockTelemetry({ alerts: { thermalThrottle: true } })
      );
      expect(activeTypes()).toContain('thermal_throttle');
    });

    it('motorsStow → motors_stowed', async () => {
      await manager.checkTelemetry(
        createMockTelemetry({ alerts: { motorsStow: true } })
      );
      expect(activeTypes()).toContain('motors_stowed');
    });

    it('isHeating → dish_heating', async () => {
      await manager.checkTelemetry(
        createMockTelemetry({ alerts: { isHeating: true } })
      );
      expect(activeTypes()).toContain('dish_heating');
    });

    it('slowEthernetSpeeds → slow_ethernet', async () => {
      await manager.checkTelemetry(
        createMockTelemetry({ alerts: { slowEthernetSpeeds: true } })
      );
      expect(activeTypes()).toContain('slow_ethernet');
    });

    it('connectivity → cable_connectivity', async () => {
      await manager.checkTelemetry(
        createMockTelemetry({ alerts: { connectivity: true } })
      );
      expect(activeTypes()).toContain('cable_connectivity');
    });
  });

  describe('告警阈值可配置', () => {
    it('使用自定义阈值触发告警', async () => {
      const highThresholdManager = new AlertManager(mockNotificationConfig, {
        highLatencyMs: 200,
        highPacketLoss: 0.2,
      });

      const data1 = createMockTelemetry({ popPingLatencyMs: 150 });
      await highThresholdManager.checkTelemetry(data1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      let active = highThresholdManager.getActiveAlerts();
      expect(active).toHaveLength(0);

      const data2 = createMockTelemetry({ popPingLatencyMs: 250 });
      await highThresholdManager.checkTelemetry(data2);
      await new Promise((resolve) => setTimeout(resolve, 50));

      active = highThresholdManager.getActiveAlerts();
      expect(active.length).toBeGreaterThan(0);
      expect(active[0].alert_type).toBe('high_latency');

      highThresholdManager.close();
    });
  });
});