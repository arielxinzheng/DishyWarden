/**
 * 「NO_SCHEDULE 告警闪一下就消失」的回归测试
 *
 * ## 症状
 *
 * DishyMock 模拟 `outage.cause == NO_SCHEDULE`, 页面上的告警
 * **闪一下就消失**, 但历史记录里能看到 —— 而且每条记录
 * `first_seen → last_seen` 只差 **2 秒**。
 *
 * 实测(alerts.db):
 * ```
 *   08:58:59.818  ongoing
 *   08:59:01.856  resolved    ← 只活了 2 秒
 *   08:59:29.816  ongoing     ← 30 秒后又出现
 *   08:59:31.851  resolved
 * ```
 *
 * ## 根因
 *
 * `no_satellite_schedule` 是**非遥测驱动**的规则(数据源是
 * `dishGetHistory` 的 outages), 但它被放在了 `this.rules` 里,
 * 于是 `checkTelemetry()` 也会遍历它:
 *
 * ```
 *   t+0ms   checkTelemetry  ⇒ condition() 恒 false ⇒ 走 else ⇒ **resolve**
 *   t+2s    checkOutages    ⇒ 有 NO_SCHEDULE ⇒ **重新置回 ongoing**
 * ```
 *
 * 每轮采集(30s)重复一次 ⇒ 告警一直在闪。
 *
 * ## 修法
 *
 * 1. 规则加 `managedBy: 'outages'` 标记, `checkTelemetry()` 跳过它
 * 2. 采集侧**无论有没有事件都 emit('outages')** ——
 *    否则 NO_SCHEDULE 消失后告警永远停在 ongoing, 不会 resolve
 * 3. `first_seen` 延续首次出现的时间, 不再每轮重置
 *
 * ## 本测试覆盖
 *
 * - 遥测驱动的规则**不受影响**(仍会被 checkTelemetry resolve)
 * - outage 驱动的规则在 checkTelemetry 里**完全不被碰**
 * - 告警能正常触发 → 持续 ongoing → 条件消失后 resolve
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AlertManager } from './manager';
import type { AlertRecord } from './database';
import type { TelemetryData } from '../core/dishClient';

// Mock AlertDatabase —— 与 manager.test.ts 保持同样的契约
vi.mock('./database', () => {
  return {
    AlertDatabase: class MockAlertDatabase {
      alerts: Map<string, AlertRecord> = new Map();
      private idCounter = 1;

      upsertAlert(alert: any): 'new' | 'ongoing' | 'resolved' {
        const existing = this.alerts.get(alert.alert_key);

        if (!existing) {
          this.alerts.set(alert.alert_key, {
            ...alert,
            id: this.idCounter++,
          } as AlertRecord);
          return 'new';
        }
        if (existing.status === 'ongoing' && alert.status === 'resolved') {
          this.alerts.set(alert.alert_key, { ...existing, ...alert } as AlertRecord);
          return 'resolved';
        }
        if (existing.status === 'resolved' && alert.status === 'ongoing') {
          // 重新激活 —— 与真实 database.ts 一致: first_seen 重置, 计数归 1
          this.alerts.set(alert.alert_key, {
            ...existing,
            ...alert,
            occurrence_count: 1,
          } as AlertRecord);
          return 'new';
        }
        // 持续触发
        this.alerts.set(alert.alert_key, {
          ...existing,
          ...alert,
          occurrence_count: existing.occurrence_count + 1,
        } as AlertRecord);
        return 'ongoing';
      }

      markNotified(): void {}
      getAlertByKey(alertKey: string): any { return this.alerts.get(alertKey); }
      getActiveAlerts(): any[] {
        return Array.from(this.alerts.values()).filter(
          (a: any) => a.status === 'new' || a.status === 'ongoing',
        );
      }
      getAlertsNeedingUpdate(): any[] { return []; }
      cleanupResolvedAlerts(): number { return 0; }
      getAlertHistory(): any[] { return []; }
      getAlertCount(): number { return this.alerts.size; }
      close(): void { this.alerts.clear(); }
    },
  };
});

const telemetry = (over: Partial<TelemetryData> = {}): TelemetryData =>
  ({
    state: 'ONLINE',
    uptime: 3600,
    popPingLatencyMs: 35,
    popPingDropRate: 0,
    publicPingLatencyMs: 30,
    localGatewayLatencyMs: 4,
    downlinkThroughputBps: 120e6,
    uplinkThroughputBps: 12e6,
    snr: 12,
    secondsObstructed: 0,
    fractionObstructed: 0,
    currentlyObstructed: false,
    satelliteId: 0,
    secondsToFirstNonemptySlot: 0,
    ...over,
  }) as TelemetryData;

const NO_SCHEDULE = {
  startTimestamp: Date.now(),
  durationMs: 45_000,
  triggered: 'NO_SCHEDULE',
};

describe('NO_SCHEDULE 告警生命周期', () => {
  let manager: AlertManager;

  beforeEach(async () => {
    const { AlertDatabase } = await import('./database');
    manager = new AlertManager(
      { channels: [], globalEnabled: true, minSeverity: 'info' } as any,
      { highLatencyMs: 100, highPacketLoss: 0.1, lowSnrDb: 5 } as any,
      undefined,
    );
    // 用 mock 的 db 实例替换内部的
    (manager as any).db = new AlertDatabase();
  });

  it('checkTelemetry 不会碰 outage 驱动的规则(关键回归)', async () => {
    // 先让 outage 路径触发告警
    await manager.checkOutages([NO_SCHEDULE] as any);

    const db = (manager as any).db;
    const afterFire = db.getAlertByKey('no_satellite_schedule:starlink');
    expect(afterFire).toBeDefined();
    expect(afterFire.status).toBe('ongoing');

    // ⚠️ 关键: 再调 checkTelemetry —— 它**不应该**把告警 resolve 掉
    await manager.checkTelemetry(telemetry());

    const afterTelemetry = db.getAlertByKey('no_satellite_schedule:starlink');
    expect(afterTelemetry.status).toBe('ongoing');   // ← 修复前这里是 'resolved'
  });

  it('连续多轮 checkTelemetry + checkOutages 告警保持 ongoing', async () => {
    const db = (manager as any).db;

    // 模拟 3 轮采集: data 事件先到, outages 事件 2 秒后到
    for (let round = 0; round < 3; round++) {
      await manager.checkTelemetry(telemetry());
      await manager.checkOutages([NO_SCHEDULE] as any);
    }

    const rec = db.getAlertByKey('no_satellite_schedule:starlink');
    expect(rec.status).toBe('ongoing');
  });

  it('NO_SCHEDULE 消失后告警会 resolve', async () => {
    const db = (manager as any).db;

    await manager.checkOutages([NO_SCHEDULE] as any);
    expect(db.getAlertByKey('no_satellite_schedule:starlink').status).toBe('ongoing');

    // 条件不成立 —— 采集侧 emit 空数组(这是修复的关键: 无事件时也要 emit)
    await manager.checkOutages([] as any);

    expect(db.getAlertByKey('no_satellite_schedule:starlink').status).toBe('resolved');
  });

  it('遥测驱动的规则仍然会被 checkTelemetry resolve(不受影响)', async () => {
    const db = (manager as any).db;

    // high_latency 是遥测驱动的: 延迟超阈值触发
    await manager.checkTelemetry(telemetry({ popPingLatencyMs: 500 }));
    const fired = db.getAlertByKey('high_latency:starlink');
    expect(fired).toBeDefined();
    expect(fired.status).toBe('ongoing');

    // 延迟恢复正常 ⇒ 应该自动 resolve
    await manager.checkTelemetry(telemetry({ popPingLatencyMs: 35 }));
    expect(db.getAlertByKey('high_latency:starlink').status).toBe('resolved');
  });

  it('first_seen 延续首次出现的时间, 不每轮重置', async () => {
    const db = (manager as any).db;

    await manager.checkOutages([NO_SCHEDULE] as any);
    const first = db.getAlertByKey('no_satellite_schedule:starlink').first_seen;

    await new Promise(r => setTimeout(r, 20));
    await manager.checkOutages([NO_SCHEDULE] as any);
    const second = db.getAlertByKey('no_satellite_schedule:starlink').first_seen;

    expect(second).toBe(first);
  });
});
