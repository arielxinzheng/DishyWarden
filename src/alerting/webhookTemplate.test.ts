/**
 * 通用 Webhook 模板渲染与请求构造测试。
 *
 * 覆盖：
 * - 变量插值（字符串位置 vs 结构位置，转义规则不同）
 * - 未定义变量的处理
 * - GET：负载摊平成查询参数
 * - POST：负载作为请求体，Content-Type 按能否解析成 JSON 决定
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WEBHOOK_TEMPLATE,
  WEBHOOK_TEMPLATE_VARIABLES,
  buildWebhookRequest,
  flattenToQuery,
  isJson,
  renderWebhookTemplate,
  type WebhookVarValue,
} from './webhookTemplate';

const vars: Record<string, WebhookVarValue> = {
  alert_title: '丢包率过高',
  alert_detail: '检测到持续丢包',
  alert_summary: '丢包率 12%',
  alert_type: 'high_packet_loss',
  alert_key: 'high_packet_loss:starlink',
  alert_severity: 'warning',
  alert_status: 'firing',
  alert_time: '2026-11-10T01:00:00.000Z',
  alert_first_seen: '2026-11-10T00:00:00.000Z',
  alert_count: 7,
  alert_duration: '',
  alert_recommendations: ['检查 PoE 线缆'],
  alert_evidence: { rate: 0.12 },
};

describe('Webhook 模板渲染', () => {
  it('字符串位置：插入并转义，不破坏 JSON', () => {
    const { text } = renderWebhookTemplate(
      '{"content": "告警：{{alert_title}}，详情：{{alert_detail}}"}',
      vars,
    );
    expect(isJson(text)).toBe(true);
    expect(JSON.parse(text)).toEqual({
      content: '告警：丢包率过高，详情：检测到持续丢包',
    });
  });

  it('字符串位置：带引号/换行的值不会撑破 JSON', () => {
    const { text } = renderWebhookTemplate(
      '{"content": "{{alert_title}}"}',
      { ...vars, alert_title: '他说"坏了"\n换行了' },
    );
    expect(isJson(text)).toBe(true);
    expect(JSON.parse(text).content).toBe('他说"坏了"\n换行了');
  });

  it('结构位置：插入原始 JSON（对象 / 数组 / 数字）', () => {
    const { text } = renderWebhookTemplate(
      '{"evidence": {{alert_evidence}}, "recommendations": {{alert_recommendations}}, "count": {{alert_count}}}',
      vars,
    );
    expect(isJson(text)).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.evidence).toEqual({ rate: 0.12 });
    expect(parsed.recommendations).toEqual(['检查 PoE 线缆']);
    expect(parsed.count).toBe(7);
  });

  it('未定义的变量 → 记进 unknownVars，字符串位置留空、结构位置为 null', () => {
    const { text, unknownVars } = renderWebhookTemplate(
      '{"a": "{{nope}}", "b": {{alsoNope}}}',
      vars,
    );
    expect(unknownVars).toEqual(['nope', 'alsoNope']);
    expect(isJson(text)).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.a).toBe('');
    expect(parsed.b).toBeNull();
  });

  it('未闭合的 {{ 原样保留，不吞字符', () => {
    const { text } = renderWebhookTemplate('{"a": "{{alert_title"}', vars);
    expect(text).toContain('{{alert_title');
  });

  it('空模板返回空串', () => {
    expect(renderWebhookTemplate('', vars).text).toBe('');
  });
});

describe('默认模板', () => {
  it('渲染后是合法 JSON，且保留旧版字段名', () => {
    const { text } = renderWebhookTemplate(DEFAULT_WEBHOOK_TEMPLATE, vars);
    expect(isJson(text)).toBe(true);
    const parsed = JSON.parse(text);
    for (const key of [
      'alert_type',
      'severity',
      'status',
      'timestamp',
      'summary',
      'description',
      'occurrence_count',
      'first_seen',
      'last_seen',
      'duration',
      'recommendations',
      'evidence',
    ]) {
      expect(parsed, `缺字段 ${key}`).toHaveProperty(key);
    }
    expect(parsed.evidence).toEqual({ rate: 0.12 });
    expect(parsed.recommendations).toEqual(['检查 PoE 线缆']);
  });

  it('变量清单覆盖默认模板用到的全部变量', () => {
    const keys = new Set(WEBHOOK_TEMPLATE_VARIABLES.map((v) => v.key));
    for (const key of Object.keys(vars)) {
      expect(keys.has(key as any), `变量清单缺 ${key}`).toBe(true);
    }
  });
});

describe('请求构造', () => {
  it('POST：负载作为请求体，JSON 内容用 application/json', () => {
    const req = buildWebhookRequest(
      {
        url: 'https://example.test/hook',
        method: 'POST',
        payloadTemplate: '{"content": "{{alert_title}}"}',
      },
      vars,
    );
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://example.test/hook');
    expect(req.body).toBe('{"content": "丢包率过高"}');
    expect(req.headers['Content-Type']).toBe('application/json');
  });

  it('POST：非 JSON 负载用 text/plain', () => {
    const req = buildWebhookRequest(
      {
        url: 'https://example.test/hook',
        method: 'POST',
        payloadTemplate: 'plain {{alert_title}}',
      },
      vars,
    );
    expect(req.headers['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(req.body).toBe('plain 丢包率过高');
  });

  it('POST：自定义 headers 覆盖默认 Content-Type', () => {
    const req = buildWebhookRequest(
      {
        url: 'https://example.test/hook',
        method: 'POST',
        headers: { Authorization: 'Bearer xxx', 'Content-Type': 'application/vnd.custom' },
        payloadTemplate: '{"a": 1}',
      },
      vars,
    );
    expect(req.headers.Authorization).toBe('Bearer xxx');
    expect(req.headers['Content-Type']).toBe('application/vnd.custom');
  });

  it('GET：JSON 负载摊平成查询参数', () => {
    const req = buildWebhookRequest(
      {
        url: 'https://example.test/hook',
        method: 'GET',
        payloadTemplate: '{"title": "{{alert_title}}", "count": {{alert_count}}}',
      },
      vars,
    );
    expect(req.method).toBe('GET');
    expect(req.body).toBeUndefined();
    expect(req.url).toContain('https://example.test/hook?');
    const params = new URLSearchParams(req.url.split('?')[1]);
    expect(params.get('title')).toBe('丢包率过高');
    expect(params.get('count')).toBe('7');
  });

  it('GET：保留 URL 上原有的查询参数', () => {
    const req = buildWebhookRequest(
      {
        url: 'https://example.test/hook?token=abc',
        method: 'GET',
        payloadTemplate: '{"a": "b"}',
      },
      vars,
    );
    const params = new URLSearchParams(req.url.split('?')[1]);
    expect(params.get('token')).toBe('abc');
    expect(params.get('a')).toBe('b');
  });

  it('GET：非 JSON 负载整段作为 payload 参数', () => {
    const req = buildWebhookRequest(
      {
        url: 'https://example.test/hook',
        method: 'GET',
        payloadTemplate: 'hello {{alert_title}}',
      },
      vars,
    );
    const params = new URLSearchParams(req.url.split('?')[1]);
    expect(params.get('payload')).toBe('hello 丢包率过高');
  });

  it('未配置方法时默认 POST', () => {
    const req = buildWebhookRequest({ url: 'https://example.test/hook' }, vars);
    expect(req.method).toBe('POST');
  });

  it('未配置模板时用默认模板', () => {
    const req = buildWebhookRequest({ url: 'https://example.test/hook', method: 'POST' }, vars);
    expect(isJson(req.body ?? '')).toBe(true);
  });
});

describe('辅助函数', () => {
  it('isJson 判定', () => {
    expect(isJson('{"a":1}')).toBe(true);
    expect(isJson('[1,2]')).toBe(true);
    expect(isJson('not json')).toBe(false);
    expect(isJson('')).toBe(false);
  });

  it('flattenToQuery：对象/数组/标量', () => {
    expect(flattenToQuery({ a: 1, b: 'x' })).toEqual([
      ['a', '1'],
      ['b', 'x'],
    ]);
    expect(flattenToQuery({ a: [1, 2] })).toEqual([
      ['a', '1'],
      ['a', '2'],
    ]);
    expect(flattenToQuery({ a: { b: 1 } })).toEqual([['a[b]', '1']]);
    expect(flattenToQuery(null)).toEqual([]);
  });
});
