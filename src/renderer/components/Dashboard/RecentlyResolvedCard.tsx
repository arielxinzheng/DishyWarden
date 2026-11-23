/**
 * 【刚刚恢复】留存卡片 —— 纯展示
 *
 * 约束:
 *   - 不拉数据、不读 storage、不做过滤。列表由父组件用
 *     selectRecentlyResolved 算好后传进来。
 *   - 视觉上必须和活跃告警横幅明显不同: 活跃 = 红/橙危险色, 这里 = 绿色
 *     安全色或中性灰。严禁红黄。
 *   - 层级: 活跃横幅永远在上, 本卡片在下。
 *   - 所有可见文案走 `dashboard:recently_resolved.*`; 场景/时长只消费
 *     `recentlyResolved.ts` 返回的语义码, 不在组件里推断。
 */

import { useTranslation } from 'react-i18next';
import { CheckCircle2, ShieldCheck, X } from 'lucide-react';
import {
  VISIBLE_LIMIT,
  describeDuration,
  dismissKeyOf,
  formatSpan,
  recoveredAt,
  relativeAge,
  scenarioOf,
  type DurationDescriptor,
  type ResolvedAlertLike,
} from './recentlyResolved';

interface RecentlyResolvedCardProps {
  /** 已按恢复时间倒序、已过滤的完整列表 */
  alerts: readonly ResolvedAlertLike[];
  /** 由父组件统一取的「现在」, 保证同一次渲染里所有相对时间口径一致 */
  now: number;
  onDismiss: (alert: ResolvedAlertLike) => void;
  onOpenHistory: () => void;
}

const parseTs = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
};

export function RecentlyResolvedCard({
  alerts,
  now,
  onDismiss,
  onOpenHistory,
}: RecentlyResolvedCardProps) {
  const { t } = useTranslation();

  /** 时长语义码 → 本地化片段（`5 分钟` / `5 min`） */
  const durationText = (d: DurationDescriptor): string => {
    switch (d.kind) {
      case 'below_minute':
        return t('dashboard:recently_resolved.duration_lt_minute');
      case 'minutes':
        return t('dashboard:recently_resolved.duration_minutes', { count: d.minutes });
      case 'hours':
        return t('dashboard:recently_resolved.duration_hours', { count: d.hours });
      case 'hours_minutes':
        return t('dashboard:recently_resolved.duration_hours_minutes', {
          hours: d.hours,
          minutes: d.minutes,
        });
    }
  };

  /**
   * 场景名。已知规则用字典里的短场景名；其余规则用**本地化的告警类型标题**。
   *
   * ⚠️ 不要再回退到 `alert.summary` —— 那是主进程写进数据库的中文原文
   * （例如「丢包率 5.0%」），会让英文界面里混进中文。
   * 类型标题在 `alerts:types.<alert_type>.title`，与规则 id 一一对应。
   */
  const scenarioText = (alert: ResolvedAlertLike): string => {
    const code = scenarioOf(alert);
    if (code) return t(`dashboard:recently_resolved.scenario_${code}`);
    const typeTitle = t(`alerts:types.${alert.alert_type}.title`, { defaultValue: '' });
    if (typeTitle) return typeTitle;
    return t('dashboard:recently_resolved.scenario_unknown');
  };

  /** `刚才经历了一次网络中断（14:05 - 14:10，持续 5 分钟），现已自动恢复正常` */
  const outageLine = (alert: ResolvedAlertLike): string => {
    const span = formatSpan(alert.first_seen, alert.last_seen);
    const duration = describeDuration(recoveredAt(alert) - parseTs(alert.first_seen));
    const scenario = scenarioText(alert);
    const lasted = duration ? durationText(duration) : '';

    if (span && lasted) {
      return t('dashboard:recently_resolved.line_full', {
        scenario,
        span,
        duration: lasted,
      });
    }
    if (span) {
      return t('dashboard:recently_resolved.line_with_span', { scenario, span });
    }
    if (lasted) {
      return t('dashboard:recently_resolved.line_with_duration', {
        scenario,
        duration: lasted,
      });
    }
    return t('dashboard:recently_resolved.line_plain', { scenario });
  };

  /** 相对恢复时间（`刚刚恢复` / `12 分钟前恢复`） */
  const agoText = (ms: number): string => {
    const age = relativeAge(ms);
    if (age.unit === 'just_now') {
      return t('dashboard:recently_resolved.recovered_just_now');
    }
    return t(`dashboard:recently_resolved.recovered_${age.unit}`, { count: age.count });
  };

  if (alerts.length === 0) return null;

  const shown = alerts.slice(0, VISIBLE_LIMIT);
  const remaining = alerts.length - shown.length;

  return (
    <section
      // 不用 <Alert>: 那个组件带 role="alert", 会把「已恢复」当成新的紧急消息
      // 播报给屏幕阅读器, 语义正好相反。
      aria-label={t('dashboard:recently_resolved.aria')}
      className="rounded-lg border border-accent-green/30 bg-accent-green/5 p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 shrink-0 text-accent-green" />
          <span className="text-sm font-medium text-accent-green">
            {t('dashboard:recently_resolved.title')}
          </span>
          <span className="text-xs text-muted-foreground">
            {t('dashboard:recently_resolved.subtitle')}
          </span>
        </div>
        <button
          type="button"
          onClick={onOpenHistory}
          className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('dashboard:recently_resolved.view_history')}
        </button>
      </div>

      <ul className="space-y-2">
        {shown.map((alert) => (
          <li
            key={dismissKeyOf(alert)}
            className="flex items-start justify-between gap-3 rounded-md bg-accent-green/10 px-3 py-2"
          >
            <div className="flex min-w-0 items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent-green" />
              <div className="min-w-0">
                <p className="text-sm text-foreground/90">{outageLine(alert)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {agoText(now - recoveredAt(alert))}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onDismiss(alert)}
              aria-label={t('dashboard:recently_resolved.dismiss_aria')}
              title={t('dashboard:recently_resolved.dismiss')}
              className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent-green/15 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>

      {remaining > 0 && (
        <button
          type="button"
          onClick={onOpenHistory}
          className="mt-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('dashboard:recently_resolved.more', { count: remaining })}
        </button>
      )}
    </section>
  );
}
