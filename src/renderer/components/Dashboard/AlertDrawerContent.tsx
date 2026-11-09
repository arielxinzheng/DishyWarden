/**
 * 告警抽屉内容组件
 * 按严重程度排序展示活跃告警
 */

import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Badge } from '../ui/badge';
import { AlertTriangle, Info, AlertCircle, BellOff, MoreVertical, Bell } from 'lucide-react';
import type { AlertRecord } from '../../../alerting/database';
import { parseEvidence } from '../../lib/alertFormat';
import { localizeAlert } from '../../lib/alertMessage';
import { DnsAlertDetail } from './DnsAlertDetail';
import { AlertSnoozeMenu } from './AlertSnoozeMenu';

interface AlertDrawerContentProps {
  alerts: AlertRecord[];
  onAlertsChange?: () => void;
}

export function AlertDrawerContent({ alerts, onAlertsChange }: AlertDrawerContentProps) {
  const { t, i18n } = useTranslation();
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);

  // 忽略状态唯一来源：主进程写入数据库后经 props 回传的字段。
  // 不在组件内维护本地副本，否则「取消忽略」后本地 Set 仍会把它判为已忽略。
  const isAlertSnoozed = (alert: AlertRecord): boolean => {
    if (alert.snooze_type === 'until_resolved') return true;
    if (alert.snooze_until) {
      const snoozeUntil = new Date(alert.snooze_until).getTime();
      if (Date.now() < snoozeUntil) return true;
    }
    return false;
  };

  /**
   * 剩余忽略时间 → **语义码**（渲染时再套字典模板）。
   * 单位词不写死在逻辑里, 英文界面才不会出现「剩余 / 小时」这种中英混排。
   */
  const snoozeRemaining = (
    alert: AlertRecord,
  ):
    | { kind: 'until_resolved' }
    | { kind: 'hours'; hours: number; minutes: number }
    | { kind: 'minutes'; minutes: number }
    | null => {
    if (alert.snooze_type === 'until_resolved') return { kind: 'until_resolved' };
    if (!alert.snooze_until) return null;

    const snoozeUntil = new Date(alert.snooze_until).getTime();
    const now = Date.now();
    if (now >= snoozeUntil) return null;

    const remainingMs = snoozeUntil - now;
    const hours = Math.floor(remainingMs / (60 * 60 * 1000));
    const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));

    return hours > 0
      ? { kind: 'hours', hours, minutes }
      : { kind: 'minutes', minutes };
  };

  /** 语义码 → 本地化文案 */
  const snoozeRemainingText = (
    remaining: Exclude<ReturnType<typeof snoozeRemaining>, null>,
  ): string => {
    if (remaining.kind === 'until_resolved') {
      return t('dashboard:alert_drawer.snoozed_until_resolved');
    }
    if (remaining.kind === 'hours') {
      return t('dashboard:alert_drawer.snoozed_remaining_hours', {
        hours: remaining.hours,
        minutes: remaining.minutes,
      });
    }
    return t('dashboard:alert_drawer.snoozed_remaining_minutes', {
      minutes: remaining.minutes,
    });
  };

  // 分离已忽略和未忽略的告警
  const { snoozedList, activeList } = useMemo(() => {
    const snoozed: AlertRecord[] = [];
    const active: AlertRecord[] = [];
    
    alerts.forEach(alert => {
      if (isAlertSnoozed(alert)) {
        snoozed.push(alert);
      } else {
        active.push(alert);
      }
    });
    
    // 按严重程度排序
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    const sortFn = (a: AlertRecord, b: AlertRecord) =>
      (severityOrder[a.severity as keyof typeof severityOrder] ?? 99) - 
      (severityOrder[b.severity as keyof typeof severityOrder] ?? 99);
    
    return {
      snoozedList: snoozed.sort(sortFn),
      activeList: active.sort(sortFn),
    };
  }, [alerts]);

  const handleSnooze = async (alertKey: string, type: 'temporary' | 'until_resolved', durationMs?: number) => {
    if (!window.electronAPI?.snoozeAlert) return;
    
    const result = await window.electronAPI.snoozeAlert({ alertKey, snoozeType: type, durationMs });
    if (result.success) {
      // 状态由主进程广播 → 父组件重拉，这里不写本地副本
      onAlertsChange?.();
    }
  };

  const handleUnsnooze = async (alertKey: string) => {
    if (!window.electronAPI?.unsnoozeAlert) return;
    
    const result = await window.electronAPI.unsnoozeAlert(alertKey);
    if (result.success) {
      onAlertsChange?.();
    }
  };

  const handleMarkFalsePositive = async (alertKey: string) => {
    if (!window.electronAPI?.markFalsePositive) return;
    
    const result = await window.electronAPI.markFalsePositive({ alertKey });
    if (result.success) {
      onAlertsChange?.();
      
      // 显示 Toast 提示
      if (typeof window !== 'undefined' && 'toast' in window) {
        // @ts-ignore
        window.toast?.success(t('dashboard:alert_drawer.toast_false_positive'));
      }
    }
  };

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClick = () => setOpenMenuId(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  if (activeList.length === 0 && snoozedList.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-12">
        <AlertCircle className="w-12 h-12 mx-auto mb-4 opacity-50" />
        <p>{t('dashboard:alert_drawer.empty')}</p>
      </div>
    );
  }

  const renderAlert = (alert: AlertRecord, isSnoozed: boolean) => {
    // 告警标题 / 摘要 / 建议 / 严重度统一由 localizeAlert 按当前语言重拼,
    // 不直接展示主进程写进库里的中文原文。
    const localized = localizeAlert(alert, t);
    const remaining = snoozeRemaining(alert);

    return (
      <Alert
        key={alert.id}
        className={`
          ${isSnoozed 
            ? 'opacity-50 border-border/30 bg-muted/20' 
            : alert.severity === 'critical' 
              ? 'border-danger-red bg-danger-red/10 shadow-[0_0_20px_rgba(239,68,68,0.2)]' 
              : alert.severity === 'warning'
                ? 'border-warning-orange/50 bg-warning-orange/5'
                : 'border-sky-blue/50 bg-sky-blue/5'
          }
        `}
      >
        <div className="flex items-start gap-4">
          {/* 图标 */}
          <div className="mt-1 shrink-0">
            {isSnoozed ? (
              <BellOff className="h-6 w-6 text-muted-foreground" />
            ) : alert.severity === 'critical' ? (
              <AlertTriangle className="h-6 w-6 text-danger-red" />
            ) : alert.severity === 'warning' ? (
              <AlertTriangle className="h-6 w-6 text-warning-orange" />
            ) : (
              <Info className="h-6 w-6 text-sky-blue" />
            )}
          </div>

          {/* 内容 */}
          <div className="flex-1 space-y-3 min-w-0">
            {/* 标题与操作按钮 */}
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <AlertTitle className="mb-0 text-lg">{localized.title}</AlertTitle>
                <Badge 
                  variant={alert.severity === 'critical' ? 'destructive' : 'secondary'}
                  className="shrink-0"
                >
                  {localized.severityLabel}
                </Badge>
              </div>
              
              {/* 操作按钮 */}
              <div className="relative shrink-0">
                {isSnoozed ? (
                  <button
                    onClick={() => handleUnsnooze(alert.alert_key)}
                    className="p-2 rounded-md hover:bg-accent-green/10 text-accent-green transition-colors"
                    title={t('dashboard:alert_drawer.unsnooze')}
                  >
                    <Bell className="w-4 h-4" />
                  </button>
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuId(openMenuId === alert.id ? null : alert.id ?? null);
                    }}
                    className="p-2 rounded-md hover:bg-muted transition-colors"
                    title={t('dashboard:alert_drawer.snooze_menu')}
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>
                )}
                
                {/* 降噪菜单 */}
                {openMenuId === alert.id && !isSnoozed && (
                  <AlertSnoozeMenu
                    onSnooze={(type, durationMs) => handleSnooze(alert.alert_key, type, durationMs)}
                    onMarkFalsePositive={() => handleMarkFalsePositive(alert.alert_key)}
                    onClose={() => setOpenMenuId(null)}
                  />
                )}
              </div>
            </div>

            {/* 忽略状态提示 */}
            {isSnoozed && remaining && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 border border-border/50 rounded px-3 py-2">
                <BellOff className="w-4 h-4 shrink-0" />
                <span>{snoozeRemainingText(remaining)}</span>
              </div>
            )}

            {/* 描述 */}
            {!isSnoozed && (
              <AlertDescription className="text-base leading-relaxed">
                {localized.summary}
              </AlertDescription>
            )}

            {/* DNS 告警详情 */}
            {!isSnoozed && alert.alert_key.startsWith('dns_') && alert.evidence && (() => {
              const evidence = parseEvidence(alert.evidence);
              if (!evidence) return null;
              return (
                <div className="mt-4">
                  <DnsAlertDetail evidence={evidence as any} />
                </div>
              );
            })()}

            {/* 建议处理 */}
            {!isSnoozed && (() => {
              const recs = localized.recommendations;
              if (recs.length === 0) return null;
              return (
                <div className="mt-4 pt-4 border-t border-border/50">
                  <div className="text-sm font-semibold mb-3 text-foreground">
                    {t('dashboard:alert_drawer.recommendations')}
                  </div>
                  <ul className="space-y-2">
                    {recs.map((rec, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm leading-relaxed">
                        <span className="text-accent-green shrink-0 mt-1">•</span>
                        <span className="text-muted-foreground">{rec}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}

            {/* 时间戳与计数 */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground pt-2 border-t border-border/30">
              <span>
                {t('dashboard:alert_drawer.first_seen', {
                  time: new Date(alert.first_seen).toLocaleString(i18n.language, {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                })}
              </span>
              <span>
                {t('dashboard:alert_drawer.occurrences', { count: alert.occurrence_count })}
              </span>
              {alert.status === 'ongoing' && !isSnoozed && (
                <span className="text-warning-orange font-semibold">
                  {t('dashboard:alert_drawer.ongoing')}
                </span>
              )}
            </div>
          </div>
        </div>
      </Alert>
    );
  };

  return (
    <div className="space-y-4">
      {/* 活跃告警 */}
      {activeList.map(alert => renderAlert(alert, false))}
      
      {/* 已忽略告警 - 沉底展示 */}
      {snoozedList.length > 0 && (
        <>
          {activeList.length > 0 && (
            <div className="flex items-center gap-3 my-6">
              <div className="flex-1 h-px bg-border/30" />
              <span className="text-xs text-muted-foreground">
                {t('dashboard:alert_drawer.snoozed_section')}
              </span>
              <div className="flex-1 h-px bg-border/30" />
            </div>
          )}
          {snoozedList.map(alert => renderAlert(alert, true))}
        </>
      )}
    </div>
  );
}