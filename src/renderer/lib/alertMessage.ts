import type { TFunction } from 'i18next';
import { parseEvidence, parseRecommendations } from './alertFormat';

/**
 * 告警文案的本地化层。
 *
 * ## 为什么不能直接用数据库里的 summary
 *
 * `alerting/manager.ts` 在主进程里生成中文文案（`summary` / `description` / `recommendations`）
 * 并随告警一起写进 SQLite。渲染层如果直接展示这些字段，界面切到英文/日文时
 * 告警内容仍然是中文 —— 国际化改造等于只做了一半。
 *
 * 所以这里按 `alert_type` 重新拼装文案：
 *   - 标题、摘要模板、建议列表都来自 `alerts` 命名空间；
 *   - 动态数值通过 `evidence` 注入（例如 `{{rate}}` = 丢包率百分比）；
 *   - 找不到对应类型时**降级**到数据库原文（历史数据里可能有已下线的规则类型）。
 *
 * ## 数值约定
 *
 * 规则里 `evidence` 字段是 snake_case（`pop_drop_rate` / `dish_temperature` …），
 * 这里统一归一化成模板参数（`rate` / `temp` / `latency` …），并把比率转成百分比、
 * 把 uptime 秒转成分钟，避免模板里再做运算。
 */

export interface AlertRecordLike {
  alert_type: string;
  severity: 'critical' | 'warning' | 'info';
  status: string;
  summary?: string | null;
  description?: string | null;
  evidence?: string | null;
  recommendations?: string | null;
}

export interface LocalizedAlert {
  title: string;
  summary: string;
  recommendations: string[];
  severityLabel: string;
  statusLabel: string;
}

/** 安全取数字（缺省给 0，模板里不会残留 `{{x}}`） */
function num(value: unknown, digits = 0): string {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '0';
}

/** 比率（0..1）→ 百分比字符串 */
function pct(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? (n * 100).toFixed(1) : '0.0';
}

/**
 * 由 evidence 生成模板参数。
 *
 * ⚠️ 所有模板用到的参数都必须在这里给出（含默认值），否则 i18next 会把
 * `{{rate}}` 原样留在页面上 —— 这正是需求里禁止的"暴露未解析内容"。
 */
export function buildAlertParams(evidence: Record<string, unknown> | null): Record<string, string> {
  const e = evidence ?? {};
  return {
    state: typeof e.state === 'string' && e.state ? e.state : '—',
    service: typeof e.class_of_service === 'string' && e.class_of_service ? e.class_of_service : '—',
    rate: pct(e.pop_drop_rate),
    latency: num(e.pop_latency_ms),
    snr: num(e.snr, 1),
    frac: num(e.obstruction_percentage, 1),
    temp: num(e.dish_temperature),
    temp2: num(e.psu_temperature),
    err: num(e.attitude_uncertainty_deg, 1),
    sats: num(e.gps_sats),
    speed: num(e.eth_speed_mbps),
    down: num(e.downlink_mbps, 1),
    rssi: num(e.wifi_rssi),
    count: num(e.change_count ?? e.flip_count ?? e.connected_router_count),
    // 探针类告警：节点 id 与底层错误码（如 ECONNREFUSED）
    node: typeof e.node_id === 'string' && e.node_id ? e.node_id : '—',
    errcode: typeof e.error === 'string' && e.error ? e.error : '—',
    minutes: num(
      typeof e.uptime_seconds === 'number' ? (e.uptime_seconds as number) / 60 : e.uptime_s
    ),
  };
}

/**
 * `dns_failure` 的归因分支：
 * 探针给的是「用户态 DNS」与「基准态 DNS」两个结果，文案要能解释是谁坏了。
 */
function dnsFailureCaseKey(evidence: Record<string, unknown> | null): string {
  const user = (evidence?.user_dns ?? null) as { ok?: boolean; rtt_ms?: number | null } | null;
  const baseline = (evidence?.baseline_dns ?? null) as { ok?: boolean; rtt_ms?: number | null } | null;

  if (!user || !baseline) return 'types.dns_failure.case_generic';
  if (!user.ok && baseline.ok) return 'types.dns_failure.case_user_only';
  if (!user.ok && !baseline.ok) return 'types.dns_failure.case_both';
  // 两边都成功但用户态明显更慢
  const u = user.rtt_ms ?? 0;
  const b = baseline.rtt_ms ?? 0;
  if (user.ok && baseline.ok && u - b > 100) return 'types.dns_failure.case_slow';
  return 'types.dns_failure.case_generic';
}

/**
 * 把一条告警记录翻译成当前语言。
 *
 * 缺词时 i18next 会自动 fallback 到英文；连英文也没有的旧类型，退回数据库原文，
 * 页面至少不会出现空白或键名。
 */
export function localizeAlert(alert: AlertRecordLike, t: TFunction): LocalizedAlert {
  const params = buildAlertParams(parseEvidence(alert.evidence));

  const severityLabel = t(`alerts:severity.${alert.severity}`, {
    defaultValue: t('alerts:severity.info'),
  });
  const statusLabel = t(`alerts:status.${alert.status}`, {
    defaultValue: t('alerts:status.ongoing'),
  });

  const typeKey = `alerts:types.${alert.alert_type}`;
  const title = t(`${typeKey}.title`, { defaultValue: '' });

  // ⚠️ 摘要必须**一次 t() 调用**完成"取模板 + 插值"。
  // 曾经写成两段：先 t(键) 得到已翻译的字符串，再把这串字符当**键**传给第二次 t() ——
  // 第二次必然查不到，而 parseMissingKeyHandler 返回空串，于是所有告警的摘要都是空的。
  const summary =
    alert.alert_type === 'dns_failure'
      ? t(`alerts:${dnsFailureCaseKey(parseEvidence(alert.evidence))}`, {
          ...params,
          defaultValue: '',
        })
      : t(`${typeKey}.summary`, { ...params, defaultValue: '' });

  const rawRecommendations = t(`${typeKey}.recommendations`, {
    returnObjects: true,
    defaultValue: [],
  });
  const recommendations = Array.isArray(rawRecommendations)
    ? rawRecommendations.filter((r): r is string => typeof r === 'string' && r !== '')
    : [];

  // 三处兜底：模板缺失 ⇒ 用数据库原文（老类型 / 未翻译的新类型）
  return {
    title: title || alert.alert_type,
    summary: summary || alert.summary || '',
    recommendations: recommendations.length > 0 ? recommendations : parseRecommendations(alert.recommendations),
    severityLabel,
    statusLabel,
  };
}

/** 供告警列表排序/分组用：类型 → 本地化标题（无 t 上下文时的简化版本） */
export function alertTitleKey(alertType: string): string {
  return `alerts:types.${alertType}.title`;
}
