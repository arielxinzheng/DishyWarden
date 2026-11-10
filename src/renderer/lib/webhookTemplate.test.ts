import { describe, it, expect } from 'vitest';

import { DEFAULT_WEBHOOK_TEMPLATE } from '../../alerting/webhookTemplate';
import {
  DEFAULT_WEBHOOK_TIMEOUT_MS,
  WEBHOOK_TEMPLATE_VARIABLE_KEYS,
  formatWebhookHeaders,
  isValidWebhookTemplate,
  parseWebhookHeaders,
  parseWebhookTimeout,
} from './webhookTemplate';

describe('Webhook 请求头解析', () => {
  it('合法 JSON 对象解析出键值', () => {
    const r = parseWebhookHeaders('{"Authorization": "Bearer xxx"}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ Authorization: 'Bearer xxx' });
  });

  it('空串等于"不设置请求头"', () => {
    const r = parseWebhookHeaders('   ');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({});
  });

  it('非法 JSON 不通过，但落盘值是空对象', () => {
    const r = parseWebhookHeaders('{"Authorization": ');
    expect(r.ok).toBe(false);
    expect(r.value).toEqual({});
  });

  it('数组不是对象', () => {
    const r = parseWebhookHeaders('["a", "b"]');
    expect(r.ok).toBe(false);
    expect(r.value).toEqual({});
  });

  it('值必须是字符串', () => {
    const r = parseWebhookHeaders('{"X-Retry": 3}');
    expect(r.ok).toBe(false);
    expect(r.value).toEqual({});
  });
});

describe('Webhook 请求头回显', () => {
  it('未设置时回显空串', () => {
    expect(formatWebhookHeaders(undefined)).toBe('');
    expect(formatWebhookHeaders({})).toBe('');
  });

  it('有值时格式化成缩进 JSON', () => {
    expect(formatWebhookHeaders({ A: '1' })).toBe('{\n  "A": "1"\n}');
  });
});

describe('Webhook 模板校验', () => {
  it('默认模板本身合法（占位符在结构位置也要算合法）', () => {
    expect(isValidWebhookTemplate(DEFAULT_WEBHOOK_TEMPLATE)).toBe(true);
  });

  it('结构位置的占位符渲染后是合法 JSON', () => {
    expect(isValidWebhookTemplate('{"n": {{alert_count}}}')).toBe(true);
  });

  it('字符串位置的占位符渲染后是合法 JSON', () => {
    expect(isValidWebhookTemplate('{"t": "{{alert_title}}"}')).toBe(true);
  });

  it('缺引号等坏 JSON 不通过', () => {
    expect(isValidWebhookTemplate('{"t": "{{alert_title}"')).toBe(false);
    expect(isValidWebhookTemplate('not a json')).toBe(false);
    expect(isValidWebhookTemplate('')).toBe(false);
  });
});

describe('Webhook 超时解析', () => {
  it('正整数毫秒', () => {
    expect(parseWebhookTimeout('5000')).toBe(5000);
    expect(parseWebhookTimeout(' 1500 ')).toBe(1500);
  });

  it('空/非法/非正数一律回落到默认值（省略字段）', () => {
    expect(parseWebhookTimeout('')).toBeUndefined();
    expect(parseWebhookTimeout('abc')).toBeUndefined();
    expect(parseWebhookTimeout('0')).toBeUndefined();
    expect(parseWebhookTimeout('-100')).toBeUndefined();
    expect(DEFAULT_WEBHOOK_TIMEOUT_MS).toBe(5000);
  });
});

describe('可用变量清单', () => {
  it('是语言中立的英文标识符，不含中文描述', () => {
    expect(WEBHOOK_TEMPLATE_VARIABLE_KEYS.length).toBeGreaterThan(0);
    for (const key of WEBHOOK_TEMPLATE_VARIABLE_KEYS) {
      expect(key).toMatch(/^[a-z_]+$/);
    }
    expect(WEBHOOK_TEMPLATE_VARIABLE_KEYS).toContain('alert_title');
    expect(WEBHOOK_TEMPLATE_VARIABLE_KEYS).toContain('alert_evidence');
  });
});
