/**
 * 云端上报客户端测试
 *
 * 守两条底线：
 * 1. **白名单之外的信息绝不外发**（通知配置 token / webhook / 主机名）
 * 2. **上报失败绝不外抛**（绝不能影响 7×24 监控主职）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudClient, type CloudRecord } from './cloudClient';
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
      endpoint: 'https://cloud.example.com',
      clientId: 'client-0001',
      feedbackEnabled: true,
      updateFeedUrl: '',
      checkIntervalHours: 12,
      ...overrides,
    },
  };
}

describe('CloudClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('未配置云端地址时不应发出任何请求', async () => {
    const client = new CloudClient({
      getConfig: () => makeConfig({ endpoint: '' }),
      getAppVersion: () => '1.0.0',
    });

    const ok = await client.report({ type: 'general', note: 'hi' });

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('误报反馈未开开关时不应发出请求', async () => {
    const client = new CloudClient({
      getConfig: () => makeConfig({ feedbackEnabled: false }),
      getAppVersion: () => '1.0.0',
    });

    const ok = await client.report({ type: 'alert_false_positive', alert_key: 'high_latency' });

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('升级事件不受反馈开关影响（它是链路健康度数据）', async () => {
    const client = new CloudClient({
      getConfig: () => makeConfig({ feedbackEnabled: false }),
      getAppVersion: () => '1.0.0',
    });

    const ok = await client.report({ type: 'upgrade_heartbeat' });

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('上报成功应返回 true,并打到 /api/feedback', async () => {
    const client = new CloudClient({
      getConfig: () => makeConfig(),
      getAppVersion: () => '1.0.3',
      getPlatform: () => 'win32',
    });

    const ok = await client.report({ type: 'general', note: 'hello' });

    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cloud.example.com/api/feedback');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      type: 'general',
      client_id: 'client-0001',
      app_version: '1.0.3',
      platform: 'win32',
      note: 'hello',
    });
  });

  it('没有 client_id 时不应上报（服务端会拒）', async () => {
    const client = new CloudClient({
      getConfig: () => makeConfig({ clientId: '' }),
      getAppVersion: () => '1.0.0',
    });

    expect(await client.report({ type: 'general' })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('网络异常时返回 false 而不抛错', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const client = new CloudClient({
      getConfig: () => makeConfig(),
      getAppVersion: () => '1.0.0',
    });

    await expect(client.report({ type: 'general' })).resolves.toBe(false);
  });

  it('服务端返回 4xx 时返回 false（不重试）', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429 }));
    const client = new CloudClient({
      getConfig: () => makeConfig(),
      getAppVersion: () => '1.0.0',
    });

    expect(await client.report({ type: 'general' })).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('端点末尾多余斜杠不应产生双斜杠 URL', async () => {
    const client = new CloudClient({
      getConfig: () => makeConfig({ endpoint: 'https://cloud.example.com/' }),
      getAppVersion: () => '1.0.0',
    });

    await client.report({ type: 'general' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://cloud.example.com/api/feedback');
  });

  it('客户端侧白名单：多余的敏感字段不会进入请求体', async () => {
    const client = new CloudClient({
      getConfig: () => makeConfig(),
      getAppVersion: () => '1.0.0',
    });

    // 故意塞进敏感字段：客户端白名单应该把它们挡掉
    const record = {
      type: 'alert_false_positive',
      alert_key: 'high_latency',
      severity: 'warning',
      telegram_token: 'SECRET',
      webhook_url: 'https://x/hook',
      hostname: 'MyMac',
    } as unknown as CloudRecord;

    await client.report(record);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.telegram_token).toBeUndefined();
    expect(body.webhook_url).toBeUndefined();
    expect(body.hostname).toBeUndefined();
    expect(body.alert_key).toBe('high_latency');
  });

  it('evidence 原样上报（坐标是用户已授权的字段）', async () => {
    const client = new CloudClient({
      getConfig: () => makeConfig(),
      getAppVersion: () => '1.0.0',
    });

    await client.report({
      type: 'alert_false_positive',
      alert_key: 'high_latency',
      evidence: { latencyMs: 120, latitude: 40.05, longitude: 116.29 },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.evidence.latitude).toBe(40.05);
  });
});
