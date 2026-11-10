/**
 * Webhook 发送器（Dispatcher）行为测试。
 *
 * 关注三件事：
 * 1. 按配置发 GET / POST；
 * 2. 目标不可达 / 超时 ⇒ **静默记录，不抛异常**（绝不能把主进程带崩）；
 * 3. 模板里的变量确实被替换进了请求体。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Notifier, type NotificationConfig } from './notifier';
import type { AlertRecord } from './database';

const alertRecord = (over: Partial<AlertRecord> = {}): AlertRecord =>
  ({
    id: 1,
    alert_key: 'high_packet_loss:starlink',
    alert_type: 'high_packet_loss',
    severity: 'warning',
    status: 'ongoing',
    first_seen: '2026-11-10T00:00:00.000Z',
    last_seen: '2026-11-10T01:00:00.000Z',
    occurrence_count: 7,
    last_notified_at: null,
    notification_count: 0,
    summary: '丢包率 12%',
    description: '检测到持续丢包',
    evidence: JSON.stringify({ rate: 0.12 }),
    recommendations: JSON.stringify(['检查 PoE 线缆']),
    ...over,
  }) as AlertRecord;

const config = (over: Partial<NonNullable<NotificationConfig['webhook']>> = {}): NotificationConfig => ({
  webhook: {
    enabled: true,
    url: 'https://example.test/hook',
    method: 'POST',
    payloadTemplate: '{"content": "{{alert_title}}：{{alert_summary}}"}',
    timeoutMs: 1000,
    ...over,
  },
});

describe('Webhook 发送器', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('POST：把渲染后的模板作为请求体发出去', async () => {
    const notifier = new Notifier(config());
    await notifier.notify({
      type: 'new',
      alert: alertRecord(),
      title: '丢包率过高',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.test/hook');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"content": "丢包率过高：丢包率 12%"}');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('GET：负载摊平成查询参数，URL 不变（不含 body）', async () => {
    const notifier = new Notifier(
      config({ method: 'GET', payloadTemplate: '{"title": "{{alert_title}}"}' }),
    );
    await notifier.notify({ type: 'new', alert: alertRecord(), title: '丢包率过高' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(String(url)).toContain('title=');
    expect(decodeURIComponent(String(url))).toContain('丢包率过高');
  });

  it('自定义 headers 会带上（鉴权场景）', async () => {
    const notifier = new Notifier(
      config({ headers: { Authorization: 'Bearer xxx' } }),
    );
    await notifier.notify({ type: 'new', alert: alertRecord() });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Authorization).toBe('Bearer xxx');
  });

  it('目标返回 4xx/5xx ⇒ 记日志但不抛异常', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });
    const notifier = new Notifier(config());

    await expect(
      notifier.notify({ type: 'new', alert: alertRecord() }),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it('目标不可达（fetch 抛错）⇒ 静默吞掉，绝不抛出', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const notifier = new Notifier(config());

    await expect(
      notifier.notify({ type: 'new', alert: alertRecord() }),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it('超时（AbortError）⇒ 按失败处理，同样不抛', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );
    const notifier = new Notifier(config({ timeoutMs: 50 }));

    await expect(
      notifier.notify({ type: 'new', alert: alertRecord() }),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it('模板里有未定义变量 ⇒ 记一条 warn，请求照发', async () => {
    const notifier = new Notifier(
      config({ payloadTemplate: '{"x": "{{not_a_variable}}"}' }),
    );
    await notifier.notify({ type: 'new', alert: alertRecord() });

    expect(console.warn).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('未启用 webhook 时不发请求', async () => {
    const notifier = new Notifier({
      webhook: { enabled: false, url: 'https://example.test/hook' },
    });
    await notifier.notify({ type: 'new', alert: alertRecord() });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('evidence / recommendations 以对象/数组进入请求体', async () => {
    const notifier = new Notifier(
      config({
        payloadTemplate: '{"evidence": {{alert_evidence}}, "recs": {{alert_recommendations}}}',
      }),
    );
    await notifier.notify({ type: 'new', alert: alertRecord() });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body);
    expect(body.evidence).toEqual({ rate: 0.12 });
    expect(body.recs).toEqual(['检查 PoE 线缆']);
  });
});
