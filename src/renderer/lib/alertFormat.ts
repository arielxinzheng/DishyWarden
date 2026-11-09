/**
 * 告警 JSON 字段的安全解析。
 *
 * 数据库里 evidence / recommendations 存的是 JSON 字符串, 由
 * alerting/manager 通过 JSON.stringify 写入。但历史数据、手工导入或
 * 其他写入路径可能留下裸文本 —— 直接 JSON.parse 会在渲染期抛异常,
 * 导致整个组件树被 React 卸载 (整页白屏)。
 *
 * 这里统一做降级: 解析不出结构就返回 null / [], 由 UI 决定怎么展示。
 */

/** 解析 recommendations: 正常是 string[], 异常数据返回 [] */
export function parseRecommendations(raw: string | null | undefined): string[] {
  if (!raw) return [];

  // 兼容已经存成数组的形态
  if (Array.isArray(raw)) return raw.map(String);

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (typeof parsed === 'string') return [parsed];
    return [];
  } catch {
    // 不是合法 JSON —— 当作纯文本单条建议展示, 而不是丢弃或崩溃
    return [String(raw)];
  }
}

/** 解析 evidence: 正常是对象, 异常数据返回 null */
export function parseEvidence(
  raw: string | null | undefined
): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 告警持续时长的**语义描述**。
 *
 * 这里刻意不返回任何成句的字符串：同一个时长在中/英文里的语序、单位、
 * 复数形态都不同（`2 小时 35 分钟` / `2 h 35 min`），拼在一层逻辑里必然
 * 出现某一语言硬编码。只给出"多长"的结构，具体文案由视图层用 i18n 渲染。
 */
export type AlertDuration =
  | { kind: 'under_minute' }
  | { kind: 'minutes'; minutes: number }
  | { kind: 'hours_minutes'; hours: number; minutes: number }
  | { kind: 'days'; days: number };

/** 计算告警持续时长, 无法解析返回 null */
export function formatAlertDuration(
  firstSeen: string,
  lastSeen: string
): AlertDuration | null {
  const start = new Date(firstSeen).getTime();
  const end = new Date(lastSeen).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;

  const mins = Math.round((end - start) / 60000);
  if (mins < 1) return { kind: 'under_minute' };
  if (mins < 60) return { kind: 'minutes', minutes: mins };

  const hours = Math.floor(mins / 60);
  if (hours < 24) return { kind: 'hours_minutes', hours, minutes: mins % 60 };
  return { kind: 'days', days: Math.floor(hours / 24) };
}