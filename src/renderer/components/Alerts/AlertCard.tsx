/**
 * 单条告警卡片
 *
 * 从 Alerts 页面里拆出来的：页面要管查询条件、时间窗口、分页和分组，
 * 再塞三百行卡片渲染就彻底没法读了。
 *
 * 这里只管「一条告警长什么样」和它自己的降噪操作，不拉数据、不关心列表。
 *
 * ## 文案来源
 *
 * 标题 / 摘要 / 建议一律来自 `localizeAlert(alert, t)`：
 * 主进程写进数据库的 `summary` / `description` / `recommendations` 是中文原文，
 * 直接展示会让切到英文的界面里混进中文，所以按 `alert_type` 重新组句。
 * 只有字典里没有的旧类型才退回数据库原文（那是 `localizeAlert` 内部的兜底）。
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  AlertTriangle,
  Info,
  BellOff,
  MoreVertical,
  Bell,
  Ban,
  Undo2,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import {
  parseEvidence,
  formatAlertDuration,
  type AlertDuration,
} from '../../lib/alertFormat';
import { localizeAlert } from '../../lib/alertMessage';
import { formatLocaleOf } from './historyWindow';
import type { AlertRecord } from '../../../alerting/database';
import { AlertSnoozeMenu } from '../Dashboard/AlertSnoozeMenu';

export type Severity = AlertRecord['severity'];
export type Status = AlertRecord['status'];

/**
 * 严重度只留图标与配色：文案统一由 `alerts:severity.*` 提供
 * （`localizeAlert` 已经按当前语言解析好，避免出现第二份文案表）。
 */
const SEVERITY_META: Record<Severity, { icon: typeof AlertTriangle; className: string }> = {
  critical: { icon: AlertTriangle, className: 'text-red-500' },
  warning: { icon: AlertTriangle, className: 'text-yellow-500' },
  info: { icon: Info, className: 'text-blue-500' },
};

/**
 * 状态配色按 `AlertStatus` **全集**维护。
 *
 * 历史页实际只会拿到终态（resolved / false_positive），
 * `new` / `ongoing` 目前是兜底项 —— 保留它们是因为这两张表的类型就是
 * `Record<Status, …>`，删掉会连带丢失 `Status` 的类型完整性；
 * 而且一旦数据源变化，缺项会渲染成空白标签，比多一行文案难查得多。
 *
 * 文案不在这里：`new` / `ongoing` / `resolved` 走 `alerts:status.*`，
 * `false_positive` 是告警状态枚举之外的用户操作（标记误报），单独一条 `card.*`。
 */
const STATUS_CLASS: Record<Status, string> = {
  new: 'text-red-400',
  ongoing: 'text-orange-400',
  resolved: 'text-green-400',
  // 误报用中性灰：这是"作废"，不是"出过故障"，不该用告警色
  false_positive: 'text-slate-400',
};

/** 忽略剩余时长的语义描述，成句文案在渲染时按当前语言拼 */
type SnoozeRemaining =
  | { kind: 'until_resolved' }
  | { kind: 'remaining'; hours: number; minutes: number };

/** 剩余忽略时长 → 当前语言文案 */
function snoozeText(remaining: SnoozeRemaining, t: TFunction): string {
  if (remaining.kind === 'until_resolved') return t('alerts:card.snooze_until_resolved');
  if (remaining.hours > 0) {
    return remaining.minutes > 0
      ? t('alerts:card.snooze_remaining_hours_minutes', {
          hours: remaining.hours,
          minutes: remaining.minutes,
        })
      : t('alerts:card.snooze_remaining_hours', { count: remaining.hours });
  }
  return t('alerts:card.snooze_remaining_minutes', { count: remaining.minutes });
}

/** 告警持续时长 → 当前语言文案（分钟 / 小时复用 common 里的单位键） */
function durationText(duration: AlertDuration, t: TFunction): string {
  switch (duration.kind) {
    case 'under_minute':
      return t('alerts:card.duration_under_minute');
    case 'minutes':
      return t('common:min', { count: duration.minutes });
    case 'hours_minutes':
      return duration.minutes === 0
        ? t('common:hour', { count: duration.hours })
        : t('alerts:card.duration_hours_minutes', {
            hours: duration.hours,
            minutes: duration.minutes,
          });
    case 'days':
      return t('alerts:card.duration_days', { count: duration.days });
  }
}

/** ISO 时间戳 → 当前语言的本地时间；脏数据不显示 "Invalid Date" */
function timestampText(iso: string, locale: string, t: TFunction): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return t('common:unknown');
  return new Date(ms).toLocaleString(locale);
}

export interface AlertCardProps {
  alert: AlertRecord;
  onSnooze: (alertKey: string, type: 'temporary' | 'until_resolved', durationMs?: number) => Promise<void>;
  onUnsnooze: (alertKey: string) => Promise<void>;
  onMarkFalsePositive: (alertKey: string) => Promise<void>;
  onUnmarkFalsePositive: (alertKey: string) => Promise<void>;
}

export function AlertCard({
  alert,
  onSnooze,
  onUnsnooze,
  onMarkFalsePositive,
  onUnmarkFalsePositive,
}: AlertCardProps) {
  // 默认命名空间 common；所有文案都显式带命名空间前缀，避免 t 的类型被收窄
  const { t, i18n } = useTranslation();
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const meta = SEVERITY_META[alert.severity] ?? SEVERITY_META.info;
  const Icon = meta.icon;

  // 标题 / 摘要 / 建议 / 严重度标签 / 状态标签：全部来自告警字典
  const localized = useMemo(() => localizeAlert(alert, t), [alert, t]);

  // 误报终态：整卡作废化。它不再是"故障"，而是一条被用户否定的记录，
  // 因此不参与忽略/恢复等任何生命周期语义。
  const isVoided = alert.status === 'false_positive';

  const evidence = useMemo(() => parseEvidence(alert.evidence), [alert.evidence]);

  const duration = useMemo(
    () => formatAlertDuration(alert.first_seen, alert.last_seen),
    [alert.first_seen, alert.last_seen]
  );

  // 检查是否被忽略（误报已由 isVoided 单独处理，不在此列）
  const isSnoozed = useMemo(() => {
    if (alert.snooze_type === 'until_resolved') return true;
    if (alert.snooze_until) {
      const snoozeUntil = new Date(alert.snooze_until).getTime();
      if (Date.now() < snoozeUntil) return true;
    }
    return false;
  }, [alert]);

  // 计算剩余忽略时间（语义结构，渲染时才翻译）
  const snoozeRemaining = useMemo<SnoozeRemaining | null>(() => {
    if (alert.snooze_type === 'until_resolved') return { kind: 'until_resolved' };
    if (!alert.snooze_until) return null;

    const snoozeUntil = new Date(alert.snooze_until).getTime();
    const now = Date.now();
    if (!Number.isFinite(snoozeUntil) || now >= snoozeUntil) return null;

    const remainingMs = snoozeUntil - now;
    const hours = Math.floor(remainingMs / (60 * 60 * 1000));
    const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
    return { kind: 'remaining', hours, minutes };
  }, [alert]);

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClick = () => setOpenMenuId(null);
    if (openMenuId) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [openMenuId]);

  // 误报没有物理故障的时间线：状态文案来自字典，false_positive 单独一条
  const statusLabel =
    alert.status === 'false_positive'
      ? t('alerts:card.status_false_positive')
      : localized.statusLabel;

  return (
    <Alert
      className={cn(
        'border-l-4 transition-all',
        // 误报：作废化 —— 整体降到 40% 不透明度，灰色左边框，不参与严重度配色
        isVoided && 'opacity-40 border-l-slate-600 bg-slate-600/5',
        !isVoided && isSnoozed && 'opacity-50 border-l-slate-500 bg-slate-500/5',
        !isVoided && !isSnoozed && alert.severity === 'critical' && 'border-l-red-500 bg-red-500/5',
        !isVoided && !isSnoozed && alert.severity === 'warning' && 'border-l-yellow-500 bg-yellow-500/5',
        !isVoided && !isSnoozed && alert.severity === 'info' && 'border-l-blue-500 bg-blue-500/5',
        !isVoided && alert.status === 'resolved' && 'opacity-70'
      )}
    >
      <div className="flex items-start gap-3 pl-7">
        {isVoided ? (
          <Ban className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" />
        ) : isSnoozed ? (
          <BellOff className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        ) : (
          <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', meta.className)} />
        )}

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <AlertTitle
              className={cn(
                'mb-0 text-base',
                // 误报标题加删除线：这条告警已被用户否认
                isVoided && 'line-through text-muted-foreground'
              )}
            >
              {localized.title}
            </AlertTitle>
            <div className="flex items-center gap-1.5">
              <Badge variant={alert.severity === 'critical' ? 'destructive' : 'secondary'}>
                {localized.severityLabel}
              </Badge>
              <span className={cn('text-xs font-medium', STATUS_CLASS[alert.status])}>
                {statusLabel}
              </span>

              {/* 操作按钮：终态（已恢复 / 已标记误报）不参与降噪操作 */}
              {alert.status !== 'resolved' && !isVoided && (
                <div className="relative">
                  {isSnoozed ? (
                    <button
                      onClick={() => onUnsnooze(alert.alert_key)}
                      className="p-1.5 rounded hover:bg-accent-green/10 text-accent-green transition-colors"
                      title={t('alerts:card.unsnooze_tooltip')}
                    >
                      <Bell className="w-4 h-4" />
                    </button>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenuId(openMenuId === alert.alert_key ? null : alert.alert_key);
                      }}
                      className="p-1.5 rounded hover:bg-muted transition-colors"
                      title={t('alerts:card.snooze_menu_tooltip')}
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>
                  )}

                  {openMenuId === alert.alert_key && !isSnoozed && (
                    <AlertSnoozeMenu
                      onSnooze={(type, durationMs) => onSnooze(alert.alert_key, type, durationMs)}
                      onMarkFalsePositive={() => onMarkFalsePositive(alert.alert_key)}
                      onClose={() => setOpenMenuId(null)}
                    />
                  )}
                </div>
              )}

              {/* 误报终态的唯一出口：误点后可撤销，否则该规则永久失效 */}
              {isVoided && (
                <button
                  onClick={() => onUnmarkFalsePositive(alert.alert_key)}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  title={t('alerts:card.undo_false_positive_tooltip')}
                >
                  <Undo2 className="w-3.5 h-3.5" />
                  {t('alerts:card.undo')}
                </button>
              )}
            </div>
          </div>

          {/* 忽略状态提示 */}
          {isSnoozed && snoozeRemaining && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 border border-border/50 rounded px-3 py-1.5">
              <BellOff className="w-4 h-4 shrink-0" />
              <span>{snoozeText(snoozeRemaining, t)}</span>
            </div>
          )}

          {localized.summary && !isSnoozed && (
            <AlertDescription>{localized.summary}</AlertDescription>
          )}

          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground">
            <span>
              {t('alerts:card.first_seen', {
                time: timestampText(alert.first_seen, formatLocaleOf(i18n.language), t),
              })}
            </span>
            {/* 误报没有物理故障的时间线：恢复时刻与持续时长都无意义，显示占位符 */}
            <span>
              {t('alerts:card.last_seen', {
                time: isVoided
                  ? t('common:na')
                  : timestampText(alert.last_seen, formatLocaleOf(i18n.language), t),
              })}
            </span>
            <span>{t('alerts:card.occurrences', { count: alert.occurrence_count })}</span>
            {isVoided ? (
              <span>{t('alerts:card.duration', { duration: t('common:na') })}</span>
            ) : (
              duration && (
                <span>{t('alerts:card.duration', { duration: durationText(duration, t) })}</span>
              )
            )}
            <span className="font-mono">{alert.alert_type}</span>
          </div>

          {!isSnoozed && evidence && Object.keys(evidence).length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer select-none text-muted-foreground">
                {t('alerts:card.evidence')}
              </summary>
              <dl className="mt-1.5 space-y-1 rounded bg-black/25 p-2 font-mono">
                {Object.entries(evidence).map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <dt className="shrink-0 text-muted-foreground">{k}</dt>
                    <dd className="min-w-0 break-all">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}

          {!isSnoozed && localized.recommendations.length > 0 && (
            <div className="mt-2 border-t border-border/40 pt-2">
              <div className="mb-1 text-xs font-medium">
                {t('alerts:card.recommendations')}
              </div>
              <ul className="list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
                {localized.recommendations.map((rec, i) => (
                  <li key={i}>{rec}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </Alert>
  );
}
