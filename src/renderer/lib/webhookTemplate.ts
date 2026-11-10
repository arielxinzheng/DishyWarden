/**
 * Webhook 配置面板的辅助逻辑（渲染层专用）。
 *
 * ## 为什么要有这一层
 *
 * 配置里存的是**解析后的结果**（headers 是对象，模板是字符串），
 * 界面上显示的却是**用户手写的原文**。两者必须分开：
 *
 * - 原文用于回显 —— 用户可能正在写半截 JSON，输入框不能把他正在写的东西抹掉；
 * - 解析结果用于落盘 —— 坏数据（半截 JSON / 数组 / 非字符串值）绝不能发给主进程。
 *
 * 所以：解析成功就存解析结果，解析失败就存空对象，**但界面照旧显示用户原文**。
 *
 * ## 模板校验为什么要「先填变量再解析」
 *
 * 模板里的 `{{变量}}` 本身就不是合法 JSON：
 *
 * ```json
 * { "count": {{alert_count}} }   ← JSON.parse 直接抛错
 * ```
 *
 * 所以不能拿原始文本去 JSON.parse。正确做法是把所有变量替换成占位值
 * 渲染一遍，再看渲染结果是不是合法 JSON —— 这跟主进程真正发送时的
 * 行为是一致的（主进程同样先渲染再发送）。
 */

import {
  WEBHOOK_TEMPLATE_VARIABLES,
  renderWebhookTemplate,
  isJson,
  type WebhookVarValue,
} from '../../alerting/webhookTemplate';

/** 请求超时默认值（毫秒）—— 与主进程默认值保持一致 */
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 5000;

/**
 * 可用变量名列表（语言中立）。
 *
 * 界面上直接用它渲染 `{{变量}}` 芯片 —— 变量名是后端约定的英文标识符，
 * 不能翻译，所以这里刻意只用 `key`，不用 `WEBHOOK_TEMPLATE_VARIABLES` 里
 * 那句中文 `desc`（那会让英文界面漏中文）。
 */
export const WEBHOOK_TEMPLATE_VARIABLE_KEYS: readonly string[] =
  WEBHOOK_TEMPLATE_VARIABLES.map((v) => v.key);

/** 请求头解析结果 */
export interface WebhookHeadersParseResult {
  /** 是否是合法的 JSON 对象 */
  ok: boolean;
  /** 解析出来的请求头；不合法时为空对象（保证落盘的一定是对象） */
  value: Record<string, string>;
}

/**
 * 解析请求头 JSON。
 *
 * - 空串 → 空对象（合法，等价于「不设置请求头」）
 * - 非法 JSON / 数组 / 非对象 / 值不是字符串 → 不合法，落盘用空对象
 */
export function parseWebhookHeaders(text: string): WebhookHeadersParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, value: {} };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, value: {} };
  }

  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
    // HTTP 请求头的值必须是字符串；数字/布尔在 fetch 里会被隐式转换，
    // 但配置类型是 Record<string, string>，这里直接判为非法更诚实。
    if (typeof v !== 'string') return { ok: false, value: {} };
    out[key] = v;
  }
  return { ok: true, value: out };
}

/** 把配置里的请求头对象格式化成可回显的文本 */
export function formatWebhookHeaders(headers?: Record<string, string>): string {
  if (!headers || Object.keys(headers).length === 0) return '';
  return JSON.stringify(headers, null, 2);
}

/**
 * 校验模板能否渲染成合法 JSON。
 *
 * 把所有已知变量替换成占位值渲染一遍，再检查渲染结果 ——
 * 这样「结构位置」的变量（如 `{{alert_count}}`）也能得到合法 JSON。
 */
export function isValidWebhookTemplate(template: string): boolean {
  const trimmed = template.trim();
  if (!trimmed) return false;

  const vars: Record<string, WebhookVarValue> = {};
  for (const key of WEBHOOK_TEMPLATE_VARIABLE_KEYS) {
    // 用普通字符串做占位：字符串上下文里插进去是纯文本，
    // 结构上下文里 JSON.stringify 后是合法的字符串字面量，两边都合法。
    vars[key] = 'x';
  }

  const { text } = renderWebhookTemplate(trimmed, vars);
  return isJson(text);
}

/**
 * 解析超时输入。
 *
 * 空 / 非法 / 非正数 → undefined（落盘时省略该字段，由主进程用默认值）。
 */
export function parseWebhookTimeout(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}
