/**
 * 离线队列 GC（清理机制）测试。
 *
 * 三条路径：
 * 1. **启动自检** —— 数据库连接建立后立即清一次已冲刷记录
 * 2. **定时兜底** —— 每 24 小时清一次（长连接下的存储收敛）
 * 3. **即时回收** —— 冲刷成功后立刻清（见 dispatcher.test.ts）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AlertManager } from './manager';

/** 抓住 mock 数据库实例，才能断言 GC 是否被调用 */
const hoisted = vi.hoisted(() => ({ db: null as any }));

vi.mock('./database', () => {
  return {
    AlertDatabase: class MockAlertDatabase {
      /** 清理已冲刷记录 —— GC 的唯一入口 */
      cleanupFlushedOfflineAlerts = vi.fn((_daysToKeep = 0) => 3);

      constructor() {
        hoisted.db = this;
      }

      getAlertByKey(): any {
        return undefined;
      }
      getActiveAlerts(): any[] {
        return [];
      }
      upsertAlert(): any {
        return 'new';
      }
      close(): void {}
    },
  };
});

describe('离线队列 GC', () => {
  let manager: AlertManager;

  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.db = null;
    manager = new AlertManager({ webhookEnabled: false } as any, {} as any);
  });

  afterEach(() => {
    manager.close();
    vi.useRealTimers();
  });

  it('启动自检：数据库连接建立后立即清一次已冲刷记录', () => {
    expect(hoisted.db).not.toBeNull();
    expect(hoisted.db.cleanupFlushedOfflineAlerts).toHaveBeenCalledTimes(1);
    // 兜底路径用默认保留期（7 天）—— 只清"早就冲刷完"的残留
    expect(hoisted.db.cleanupFlushedOfflineAlerts).toHaveBeenCalledWith();
  });

  it('定时兜底：默认每 24 小时清一次', () => {
    const cleanup = hoisted.db.cleanupFlushedOfflineAlerts as any;
    cleanup.mockClear();

    manager.startOfflineQueueCleanup();

    // 24 小时内不触发
    vi.advanceTimersByTime(86400000 - 1);
    expect(cleanup).not.toHaveBeenCalled();

    // 到点触发
    vi.advanceTimersByTime(1);
    expect(cleanup).toHaveBeenCalledTimes(1);

    // 下一个周期再来一次
    vi.advanceTimersByTime(86400000);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('close() 之后定时器不再触发（不留下悬垂定时器）', () => {
    const cleanup = hoisted.db.cleanupFlushedOfflineAlerts as any;
    cleanup.mockClear();

    manager.startOfflineQueueCleanup(1000);
    manager.close();
    vi.advanceTimersByTime(5000);

    expect(cleanup).not.toHaveBeenCalled();
  });

  it('清理失败不影响管理器（只记日志）', () => {
    const cleanup = hoisted.db.cleanupFlushedOfflineAlerts as any;
    cleanup.mockClear();
    cleanup.mockImplementation(() => {
      throw new Error('database is locked');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => manager.startOfflineQueueCleanup(1000)).not.toThrow();
    vi.advanceTimersByTime(1000);

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
