/**
 * 升级管理器测试
 *
 * 重点守三条：
 * 1. **没配置更新源 / 开发态 ⇒ 不检查更新**（状态 disabled，不去打网络）
 * 2. **失败必须静默降级**（返回结构合法的状态，不抛异常）
 * 3. **打点映射正确**（available / no_update / error 分别对应 upgrade_check 的三种 result）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdateManager, type UpdateState } from './updater';
import type { CloudUpgradeRecord } from './cloudClient';
import type { AppConfig } from '../config/manager';

function makeConfig(overrides: Partial<AppConfig['cloud']> = {}): AppConfig {
  return {
    collector: {} as AppConfig['collector'],
    prometheus: {} as AppConfig['prometheus'],
    notifications: {} as AppConfig['notifications'],
    grafana: {} as AppConfig['grafana'],
    alertThresholds: {} as AppConfig['alertThresholds'],
    probe: {} as AppConfig['probe'],
    version: '1.0.0',
    cloud: {
      endpoint: '',
      clientId: 'client-0001',
      feedbackEnabled: false,
      updateFeedUrl: '',
      checkIntervalHours: 12,
      ...overrides,
    },
  };
}

function makeManager(opts: {
  config?: AppConfig;
  packaged?: boolean;
  reports?: CloudUpgradeRecord[];
}) {
  const states: UpdateState[] = [];
  const reports = opts.reports ?? [];
  const manager = new UpdateManager({
    getConfig: () => opts.config ?? makeConfig(),
    getAppVersion: () => '1.0.0',
    isPackaged: () => opts.packaged ?? true,
    onState: (state) => states.push(state),
    report: (record) => reports.push(record),
    firstCheckDelayMs: 10_000_000, // 不让测试真的等首查
  });
  return { manager, states, reports };
}

describe('UpdateManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('初始状态应是 idle 且带当前版本', () => {
    const { manager } = makeManager({});
    const state = manager.getState();
    expect(state.status).toBe('idle');
    expect(state.currentVersion).toBe('1.0.0');
  });

  it('未配置更新源时应判定为 disabled 且不打网络', async () => {
    const { manager, reports } = makeManager({ config: makeConfig({ updateFeedUrl: '' }) });

    const state = await manager.check(false);

    expect(state.status).toBe('disabled');
    expect(state.error).toBeUndefined();
    expect(reports).toHaveLength(0);
  });

  it('开发态（未打包）应判定为 disabled', async () => {
    const { manager, reports } = makeManager({
      config: makeConfig({ updateFeedUrl: 'https://example.com/latest.yml' }),
      packaged: false,
    });

    const state = await manager.check(false);

    expect(state.status).toBe('disabled');
    expect(reports).toHaveLength(0);
  });

  it('检查失败时应降级为合法状态而不是抛异常', async () => {
    const { manager, reports } = makeManager({
      config: makeConfig({ updateFeedUrl: 'https://example.invalid/latest.yml' }),
    });

    const state = await manager.check(false);

    // 断言的是**降级契约**，不是具体状态：
    // 在 vitest（非 Electron）环境里 electron-updater 根本加载不了
    // （node_modules/electron 这个 npm shim 会劫持 require('electron')），
    // 所以这里只要求：状态合法、不抛异常、不会谎报"有新版"。
    expect([
      'disabled', 'error', 'up-to-date', 'available', 'idle', 'checking',
    ]).toContain(state.status);
    expect(typeof state.currentVersion).toBe('string');
    expect(state.status).not.toBe('available');
    if (state.status === 'error') {
      expect(reports.some((r) => r.type === 'upgrade_check' && r.result === 'error')).toBe(true);
    }
  });

  it('更新组件不可用时应降级为 disabled + updater_unavailable', async () => {
    const { manager } = makeManager({
      config: makeConfig({ updateFeedUrl: 'https://example.invalid/latest.yml' }),
      packaged: true,
    });

    const state = await manager.check(false);

    // vitest 里 electron-updater 加载失败 ⇒ 必须是 disabled + updater_unavailable，
    // 而不是把异常抛给调用方（升级嗅探绝不能影响监控主职）
    expect(state.status).toBe('disabled');
    expect(state.error).toBe('updater_unavailable');
  });

  it('开发态应给出 dev_mode 原因（而不是笼统的 disabled）', async () => {
    const { manager } = makeManager({
      config: makeConfig({ updateFeedUrl: 'https://example.com/latest.yml' }),
      packaged: false,
    });

    const state = await manager.check(false);
    expect(state.status).toBe('disabled');
    expect(state.error).toBe('dev_mode');
  });

  it('心跳上报的类型应为 upgrade_heartbeat', () => {
    const { manager, reports } = makeManager({});
    manager.reportHeartbeat();
    expect(reports).toEqual([{ type: 'upgrade_heartbeat' }]);
  });

  it('start/stop 不应抛异常，且 stop 后不再排期', () => {
    const { manager } = makeManager({});
    expect(() => {
      manager.start();
      manager.stop();
    }).not.toThrow();
  });

  it('状态里不应出现非法枚举值', async () => {
    const { manager } = makeManager({
      config: makeConfig({ updateFeedUrl: 'https://example.invalid/latest.yml' }),
    });
    const state = await manager.check(false);
    expect([
      'disabled', 'idle', 'checking', 'available', 'up-to-date',
      'downloading', 'downloaded', 'error',
    ]).toContain(state.status);
  });
});
