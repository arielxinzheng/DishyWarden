/**
 * 告警分发器测试。
 *
 * 覆盖四条关键行为：
 * 1. 内网目标：无视公网连通性，**立刻**发（断网时也发）；
 * 2. 公网目标 + 无外网：**一次网络尝试都不做**，直接进离线队列；
 * 3. 公网目标 + 有外网：直接发；发失败才入队；
 * 4. 恢复冲刷：按类型**聚合成一条**汇总，不是一条条轰炸。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AlertDispatcher } from './dispatcher';
import type { Notifier, SendResult } from './notifier';
import type { AlertDatabase } from './database';
import type { NetworkPath } from './networkPath';
import type { QueuedAlert } from './offlineQueue';

const alertRecord = (over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    alert_key: 'obstruction:starlink',
    alert_type: 'obstruction',
    severity: 'warning',
    status: 'ongoing',
    first_seen: '2026-11-10T00:00:00.000Z',
    last_seen: '2026-11-10T01:00:00.000Z',
    occurrence_count: 3,
    last_notified_at: null,
    notification_count: 0,
    summary: '天线视野遮挡',
    description: '遮挡率 12%',
    evidence: '{}',
    recommendations: '[]',
    ...over,
  }) as any;

/** 假的队列存储 */
class FakeQueue {
  items: QueuedAlert[] = [];
  flushed: number[] = [];

  enqueueOfflineAlert = vi.fn((channel: string, alert: any, context: unknown) => {
    this.items.push({
      id: this.items.length + 1,
      channel,
      alert_key: alert.alert_key,
      alert_type: alert.alert_type,
      severity: alert.severity,
      summary: alert.summary,
      description: alert.description,
      evidence: alert.evidence,
      recommendations: alert.recommendations,
      context: JSON.stringify(context ?? null),
      queued_at: new Date().toISOString(),
      flushed_at: null,
    });
  });

  getPendingOfflineAlerts = vi.fn((channel?: string) =>
    this.items.filter((i) => !i.flushed_at && (!channel || i.channel === channel)),
  );

  countPendingOfflineAlerts = vi.fn(
    () => this.items.filter((i) => !i.flushed_at).length,
  );

  /** 离线队列清理（GC）—— 记录调用次数供断言 */
  cleanupFlushedOfflineAlerts = vi.fn((_daysToKeep?: number) => 0);

  markOfflineAlertsFlushed = vi.fn((ids: number[]) => {
    this.flushed.push(...ids);
    for (const item of this.items) {
      if (ids.includes(item.id)) item.flushed_at = new Date().toISOString();
    }
  });
}

/** 假的 notifier */
const makeNotifier = (
  targets: Array<{ kind: 'telegram' | 'email' | 'webhook'; scope: 'lan' | 'public' }>,
  sendResult: SendResult = { ok: true },
) => {
  const sent: Array<{ kind: string; summary: string }> = [];
  const notifier = {
    enabledTargets: vi.fn(() =>
      targets.map((t) => ({ kind: t.kind, host: 'h', scope: t.scope, reason: '' })),
    ),
    sendTo: vi.fn(async (kind: string, context: any) => {
      sent.push({ kind, summary: context.alert.summary });
      return sendResult;
    }),
  } as unknown as Notifier;
  return { notifier, sent };
};

const context = (over: Record<string, unknown> = {}) =>
  ({
    type: 'new',
    alert: alertRecord(),
    ...over,
  }) as any;

describe('告警分发器', () => {
  let queue: FakeQueue;
  let path: NetworkPath;

  const build = (
    targets: Array<{ kind: 'telegram' | 'email' | 'webhook'; scope: 'lan' | 'public' }>,
    sendResult: SendResult = { ok: true },
  ) => {
    const { notifier, sent } = makeNotifier(targets, sendResult);
    const dispatcher = new AlertDispatcher({
      notifier,
      db: queue as unknown as AlertDatabase,
      currentPath: () => path,
      labelOf: (t) => (t === 'obstruction' ? '遮挡告警' : '丢包告警'),
    });
    return { dispatcher, notifier, sent };
  };

  beforeEach(() => {
    queue = new FakeQueue();
    path = 'starlink';
  });

  describe('内网目标', () => {
    it('完全无外网时也立刻发（不做网络前置校验）', async () => {
      path = 'none';
      const { dispatcher, sent } = build([{ kind: 'webhook', scope: 'lan' }]);

      const result = await dispatcher.dispatch(context());

      expect(sent).toHaveLength(1);
      expect(result.sent[0]?.scope).toBe('lan');
      expect(queue.items).toHaveLength(0); // 内网目标不进队列
    });

    it('内网通道发失败也不进队列（它本来就是内网，失败是它自己的问题）', async () => {
      const { dispatcher, sent } = build([{ kind: 'webhook', scope: 'lan' }], {
        ok: false,
        error: 'ECONNREFUSED',
      });

      await dispatcher.dispatch(context());

      expect(sent).toHaveLength(1);
      expect(queue.items).toHaveLength(0);
    });
  });

  describe('公网目标', () => {
    it('无外网时一次尝试都不做，直接入队', async () => {
      path = 'none';
      const { dispatcher, notifier } = build([{ kind: 'telegram', scope: 'public' }]);

      const result = await dispatcher.dispatch(context());

      expect(notifier.sendTo).not.toHaveBeenCalled();
      expect(queue.items).toHaveLength(1);
      expect(queue.items[0]?.channel).toBe('telegram');
      expect(result.queued).toHaveLength(1);
    });

    it('有外网时直接发', async () => {
      path = 'starlink';
      const { dispatcher, sent } = build([{ kind: 'telegram', scope: 'public' }]);

      await dispatcher.dispatch(context());

      expect(sent).toHaveLength(1);
      expect(queue.items).toHaveLength(0);
    });

    it('备用链路（多 WAN / 5G 备线）照发不误', async () => {
      path = 'backup';
      const { dispatcher, sent } = build([{ kind: 'telegram', scope: 'public' }]);

      await dispatcher.dispatch(context());

      expect(sent).toHaveLength(1);
      expect(queue.items).toHaveLength(0);
    });

    it('发送失败（超时/连接拒绝）→ 入队，不抛异常', async () => {
      path = 'starlink';
      const { dispatcher } = build([{ kind: 'telegram', scope: 'public' }], {
        ok: false,
        error: '请求超时（5000ms）',
      });

      await expect(dispatcher.dispatch(context())).resolves.toBeDefined();
      expect(queue.items).toHaveLength(1);
      expect(queue.items[0]?.alert_type).toBe('obstruction');
    });
  });

  describe('混合通道', () => {
    it('内网立刻发、公网入队，互不影响', async () => {
      path = 'none';
      const { dispatcher, sent } = build([
        { kind: 'webhook', scope: 'lan' },
        { kind: 'telegram', scope: 'public' },
        { kind: 'email', scope: 'public' },
      ]);

      const result = await dispatcher.dispatch(context());

      expect(sent).toHaveLength(1);
      expect(sent[0]?.kind).toBe('webhook');
      expect(queue.items.map((i) => i.channel).sort()).toEqual(['email', 'telegram']);
      expect(result.sent).toHaveLength(1);
      expect(result.queued).toHaveLength(2);
    });
  });

  describe('恢复冲刷', () => {
    it('无外网时不冲刷', async () => {
      path = 'none';
      queue.enqueueOfflineAlert('telegram', alertRecord(), { type: 'new' });
      const { dispatcher, sent } = build([{ kind: 'telegram', scope: 'public' }]);

      const flushed = await dispatcher.flushIfRecovered();

      expect(flushed).toBe(0);
      expect(sent).toHaveLength(0);
    });

    it('50 条积压 → 只发 1 条汇总（不轰炸）', async () => {
      path = 'starlink';
      for (let i = 0; i < 5; i++) {
        queue.enqueueOfflineAlert('telegram', alertRecord({ alert_type: 'obstruction' }), {});
      }
      for (let i = 0; i < 3; i++) {
        queue.enqueueOfflineAlert('telegram', alertRecord({ alert_type: 'packet_loss' }), {});
      }
      const { dispatcher, sent } = build([{ kind: 'telegram', scope: 'public' }]);

      const flushed = await dispatcher.flushIfRecovered();

      expect(flushed).toBe(8);
      expect(sent).toHaveLength(1); // ← 只发一条
      expect(sent[0]?.summary).toContain('网络已恢复');
      expect(sent[0]?.summary).toContain('5 条遮挡告警');
      expect(sent[0]?.summary).toContain('3 条丢包告警');
      expect(queue.flushed).toHaveLength(8); // 原始条目都标记为已冲刷
    });

    it('补发成功才标记已冲刷；失败则保留队列待下次重试', async () => {
      path = 'starlink';
      queue.enqueueOfflineAlert('telegram', alertRecord(), {});
      const { dispatcher } = build([{ kind: 'telegram', scope: 'public' }], {
        ok: false,
        error: '发送失败',
      });

      const flushed = await dispatcher.flushIfRecovered();

      expect(flushed).toBe(0);
      expect(queue.flushed).toHaveLength(0); // 没标记 ⇒ 下次还会重试
    });

    it('冲刷后立即回收已冲刷的队列行（daysToKeep=0，不等定时器）', async () => {
      path = 'starlink';
      queue.enqueueOfflineAlert('telegram', alertRecord(), {});
      const { dispatcher } = build([{ kind: 'telegram', scope: 'public' }]);

      await dispatcher.flushIfRecovered();

      // 回收是 setImmediate（后台）—— 让出一次事件循环再断言
      await new Promise((r) => setTimeout(r, 0));
      expect(queue.cleanupFlushedOfflineAlerts).toHaveBeenCalledTimes(1);
      expect(queue.cleanupFlushedOfflineAlerts).toHaveBeenCalledWith(0);
    });

    it('没有待冲刷内容时不做无意义的回收', async () => {
      path = 'starlink';
      const { dispatcher } = build([{ kind: 'telegram', scope: 'public' }]);

      await dispatcher.flushIfRecovered();

      await new Promise((r) => setTimeout(r, 0));
      expect(queue.cleanupFlushedOfflineAlerts).not.toHaveBeenCalled();
    });

    it('多通道各自冲刷（各发一条汇总）', async () => {
      path = 'starlink';
      queue.enqueueOfflineAlert('telegram', alertRecord(), {});
      queue.enqueueOfflineAlert('email', alertRecord(), {});
      const { dispatcher, sent } = build([
        { kind: 'telegram', scope: 'public' },
        { kind: 'email', scope: 'public' },
      ]);

      const flushed = await dispatcher.flushIfRecovered();

      expect(flushed).toBe(2);
      expect(sent).toHaveLength(2);
      expect(sent.map((s) => s.kind).sort()).toEqual(['email', 'telegram']);
    });
  });
});
