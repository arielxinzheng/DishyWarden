/**
 * 通用 Webhook 的模板渲染与请求构造。
 *
 * ## 为什么是"模板 + 插值"而不是"固定 JSON"
 *
 * 外部系统（Home Assistant / Bark / 飞书 / n8n / 自建脚本…）要的 JSON 结构
 * 千差万别：有的要 `{"text": "..."}`，有的要 `{"title": "...", "body": "..."}`，
 * 有的要 `{"msgtype": "text", "text": {"content": "..."}}`。
 * 与其给每家写一套适配，不如让用户自己写模板 —— 这一个模板能覆盖数百种系统。
 *
 * ## 插值语法
 *
 * `{{变量名}}`。变量清单见 {@link WEBHOOK_TEMPLATE_VARIABLES}。
 *
 * 插值按**所在位置**区分处理：
 * - 出现在 JSON 字符串里 → 转义后插入（引号、反斜杠、换行都不会破坏 JSON）
 *   例：`{"content": "告警：{{alert_title}}"}`
 * - 出现在 JSON 结构位置（不在引号里）→ 插入原始 JSON 值
 *   例：`{"evidence": {{alert_evidence}}}``、`{"count": {{alert_count}}}`
 *
 * 这样一份模板既能传字符串，也能传对象/数组/数字。
 */

/** 可用变量清单（也用于设置页的说明文案） */
export const WEBHOOK_TEMPLATE_VARIABLES = [
  { key: 'alert_title', desc: '告警标题（规则名；无对应规则时为告警类型）' },
  { key: 'alert_detail', desc: '告警详情（description）' },
  { key: 'alert_summary', desc: '告警摘要（summary）' },
  { key: 'alert_type', desc: '告警类型标识，如 high_packet_loss' },
  { key: 'alert_key', desc: '告警键，如 high_packet_loss:starlink' },
  { key: 'alert_severity', desc: '严重级别：info / warning / critical' },
  { key: 'alert_status', desc: '状态：firing（触发中）/ resolved（已恢复）' },
  { key: 'alert_time', desc: '最近一次时间（ISO 8601）' },
  { key: 'alert_first_seen', desc: '首次出现时间（ISO 8601）' },
  { key: 'alert_count', desc: '累计触发次数' },
  { key: 'alert_duration', desc: '持续时长（仅已恢复的告警有值）' },
  { key: 'alert_recommendations', desc: '处理建议（数组）' },
  { key: 'alert_evidence', desc: '告警证据（对象）' },
] as const;

export type WebhookVariableKey = (typeof WEBHOOK_TEMPLATE_VARIABLES)[number]['key'];

/** 模板变量的值类型：字符串 / 数字 / 布尔 / 对象 / 数组 */
export type WebhookVarValue = string | number | boolean | Record<string, unknown> | unknown[] | null;

/** 模板渲染结果 */
export interface WebhookRenderResult {
  /** 渲染后的文本 */
  text: string;
  /** 模板里出现但没有对应值的变量名 */
  unknownVars: string[];
}

/**
 * 默认请求体模板。
 *
 * 刻意保留旧版 webhook 的字段名（alert_type / severity / status / summary /
 * description / evidence / recommendations / occurrence_count / first_seen /
 * last_seen / duration），这样老用户升级后不用改配置，接收端也不会因为
 * 字段改名而炸。
 */
export const DEFAULT_WEBHOOK_TEMPLATE = `{
  "title": "{{alert_title}}",
  "content": "{{alert_summary}}",
  "alert_type": "{{alert_type}}",
  "severity": "{{alert_severity}}",
  "status": "{{alert_status}}",
  "timestamp": "{{alert_time}}",
  "summary": "{{alert_summary}}",
  "description": "{{alert_detail}}",
  "occurrence_count": {{alert_count}},
  "first_seen": "{{alert_first_seen}}",
  "last_seen": "{{alert_time}}",
  "duration": "{{alert_duration}}",
  "recommendations": {{alert_recommendations}},
  "evidence": {{alert_evidence}}
}`;

/**
 * 把值转成"放进 JSON 字符串里"的形式（不含外层引号）。
 *
 * ⚠️ 必须转义：值里可能有引号、反斜杠、换行 —— 不转义就会把 JSON 撑破。
 * 例：值 `他说"坏了"` → `他说\"坏了\"`
 */
function toStringContext(value: WebhookVarValue): string {
  if (value === null || value === undefined) return '';
  const asText = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return JSON.stringify(asText).slice(1, -1);
}

/**
 * 把值转成"放在 JSON 结构位置"的形式。
 *
 * JSON 模板里要的是原始 JSON 值（对象/数组/数字/带引号的字符串）；
 * 纯文本模板里要的是**裸文本**（加了引号会变成 `hello "标题"` 这种怪东西）。
 */
function toRawContext(value: WebhookVarValue, jsonLike: boolean): string {
  if (value === null || value === undefined) return jsonLike ? 'null' : '';
  if (!jsonLike) return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return JSON.stringify(value) ?? 'null';
}

/** 模板整体是不是 JSON（决定结构位置按 JSON 还是裸文本处理） */
function looksLikeJson(template: string): boolean {
  return /^\s*[{[]/.test(template);
}

/**
 * 渲染模板。
 *
 * 扫描模板文本，跟踪当前是否在 JSON 字符串内，据此决定插值要不要转义。
 * 未定义的变量会被替换成空串（并记进 `unknownVars`）—— 宁可少一个字段，
 * 也不要往接收端发一个带 `{{xxx}}` 的半成品。
 */
export function renderWebhookTemplate(
  template: string,
  vars: Record<string, WebhookVarValue | undefined>,
): WebhookRenderResult {
  const unknownVars: string[] = [];
  if (!template) return { text: '', unknownVars };

  const jsonLike = looksLikeJson(template);

  let out = '';
  let inString = false;
  let i = 0;

  while (i < template.length) {
    const ch = template[i]!;

    if (inString) {
      if (ch === '\\') {
        out += ch + (template[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        i += 1;
        continue;
      }
    } else if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '{' && template[i + 1] === '{') {
      const end = template.indexOf('}}', i + 2);
      if (end === -1) {
        // 没闭合的 {{ —— 原样输出
        out += ch;
        i += 1;
        continue;
      }
      const name = template.slice(i + 2, end).trim();
      const value = vars[name];

      if (value === undefined) {
        if (!unknownVars.includes(name)) unknownVars.push(name);
        out += inString || !jsonLike ? '' : 'null';
      } else {
        out += inString ? toStringContext(value) : toRawContext(value, jsonLike);
      }
      i = end + 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  return { text: out, unknownVars };
}

/** 判断一段文本是不是合法 JSON */
export function isJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把对象摊平成查询参数。
 *
 * - 标量 → `key=value`
 * - 数组 → 重复同名参数（`k=1&k=2`）
 * - 对象 → `key` 取 JSON 字符串形式
 */
export function flattenToQuery(value: unknown, prefix = ''): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];

  if (value === null || value === undefined) {
    return pairs;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      pairs.push(...flattenToQuery(item, prefix));
    }
    return pairs;
  }

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const name = prefix ? `${prefix}[${key}]` : key;
      pairs.push(...flattenToQuery(child, name));
    }
    return pairs;
  }

  if (prefix) {
    pairs.push([prefix, String(value)]);
  }
  return pairs;
}

/** Webhook 请求参数 */
export interface WebhookRequestConfig {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  payloadTemplate?: string;
  timeoutMs?: number;
}

/** 构造好的请求 */
export interface WebhookRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  /** POST 时为请求体；GET 时为 undefined */
  body?: string;
  /** 本次渲染用到的未知变量（便于记日志） */
  unknownVars: string[];
}

/**
 * 根据配置与变量构造最终请求。
 *
 * - POST：渲染后的文本作为请求体；能解析成 JSON 时 Content-Type 用
 *   application/json，否则用 text/plain（允许用户写纯文本负载）。
 * - GET：渲染后的文本若能解析成 JSON，则摊平成查询参数追加到 URL；
 *   否则整段作为一个 `payload` 参数追加。
 */
export function buildWebhookRequest(
  config: WebhookRequestConfig,
  vars: Record<string, WebhookVarValue | undefined>,
): WebhookRequest {
  const method: 'GET' | 'POST' = config.method === 'GET' ? 'GET' : 'POST';
  const headers = { ...(config.headers ?? {}) };
  const template = config.payloadTemplate ?? DEFAULT_WEBHOOK_TEMPLATE;

  const { text, unknownVars } = renderWebhookTemplate(template, vars);

  if (method === 'POST') {
    const json = isJson(text);
    return {
      url: config.url,
      method,
      headers: {
        'Content-Type': json ? 'application/json' : 'text/plain; charset=utf-8',
        ...headers,
      },
      body: text,
      unknownVars,
    };
  }

  // GET：把负载摊到查询串里
  const base = config.url || '';
  const [basePath, existingQuery = ''] = base.split('?');
  const search = new URLSearchParams(existingQuery);

  if (isJson(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    for (const [key, value] of flattenToQuery(parsed)) {
      search.append(key, value);
    }
  } else {
    search.append('payload', text);
  }

  const query = search.toString();
  return {
    url: query ? `${basePath}?${query}` : basePath,
    method,
    headers,
    unknownVars,
  };
}
