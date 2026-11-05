/**
 * 单条告警卡片
 *
 * 从 Alerts 页面里拆出来的：页面要管查询条件、时间窗口、分页和分组，
 * 再塞三百行卡片渲染就彻底没法读了。
 *
 * 这里只管「一条告警长什么样」和它自己的降噪操作，不拉数据、不关心列表。
 */

import { useEffect, useMemo, useState } from 'react';
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
import { parseEvidence, parseRecommendations, formatAlertDuration } from '../../lib/alertFormat';
import type { AlertRecord } from '../../../alerting/database';
import { AlertSnoozeMenu } from '../Dashboard/AlertSnoozeMenu';

export type Severity = AlertRecord['severity'];
export type Status = AlertRecord['status'];

const SEVERITY_META: Record<Severity, { label: string; icon: typeof AlertTriangle; className: string }> = {
  critical: { label: '严重', icon: AlertTriangle, className: 'text-red-500' },
  warning: { label: '警告', icon: AlertTriangle, className: 'text-yellow-500' },
  info: { label: '提示', icon: Info, className: 'text-blue-500' },
};

/**
 * 状态文案 / 配色按 `AlertStatus` **全集**维护。
 *
 * 历史页实际只会拿到终态（resolved / false_positive），
 * `new` / `ongoing` 目前是兜底项 —— 保留它们是因为这两张表的类型就是
 * `Record<Status, …>`，删掉会连带丢失 `Status` 的类型完整性；
 * 而且一旦数据源变化，缺项会渲染成空白标签，比多一行文案难查得多。
 */
const STATUS_LABEL: Record<Status, string> = {
  new: '新建',
  ongoing: '持续中',
  resolved: '已恢复',
  false_positive: '🚫 已标记误报',
};

const STATUS_CLASS: Record<Status, string> = {
  new: 'text-red-400',
  ongoing: 'text-orange-400',
  resolved: 'text-green-400',
  // 误报用中性灰：这是"作废"，不是"出过故障"，不该用告警色
  false_positive: 'text-slate-400',
};

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
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const meta = SEVERITY_META[alert.severity] ?? SEVERITY_META.info;
  const Icon = meta.icon;

  // 误报终态：整卡作废化。它不再是"故障"，而是一条被用户否定的记录，
  // 因此不参与忽略/恢复等任何生命周期语义。
  const isVoided = alert.status === 'false_positive';

  const recommendations = useMemo(
    () => parseRecommendations(alert.recommendations),
    [alert.recommendations]
  );

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

  // 计算剩余忽略时间
  const snoozeRemaining = useMemo(() => {
    if (alert.snooze_type === 'until_resolved') return '本次已忽略';
    if (!alert.snooze_until) return null;

    const snoozeUntil = new Date(alert.snooze_until).getTime();
    const now = Date.now();
    if (now >= snoozeUntil) return null;

    const remainingMs = snoozeUntil - now;
    const hours = Math.floor(remainingMs / (60 * 60 * 1000));
    const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));

    if (hours > 0) return `剩余 ${hours} 小时 ${minutes} 分钟`;
    return `剩余 ${minutes} 分钟`;
  }, [alert]);

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClick = () => setOpenMenuId(null);
    if (openMenuId) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [openMenuId]);

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
              {alert.summary}
            </AlertTitle>
            <div className="flex items-center gap-1.5">
              <Badge variant={alert.severity === 'critical' ? 'destructive' : 'secondary'}>
                {SEVERITY_META[alert.severity]?.label ?? alert.severity}
              </Badge>
              <span className={cn('text-xs font-medium', STATUS_CLASS[alert.status])}>
                {STATUS_LABEL[alert.status] ?? alert.status}
              </span>

              {/* 操作按钮：终态（已恢复 / 已标记误报）不参与降噪操作 */}
              {alert.status !== 'resolved' && !isVoided && (
                <div className="relative">
                  {isSnoozed ? (
                    <button
                      onClick={() => onUnsnooze(alert.alert_key)}
                      className="p-1.5 rounded hover:bg-accent-green/10 text-accent-green transition-colors"
                      title="恢复提醒"
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
                      title="忽略选项"
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
                  title="撤销误报标记，退回活跃告警"
                >
                  <Undo2 className="w-3.5 h-3.5" />
                  撤销
                </button>
              )}
            </div>
          </div>

          {/* 忽略状态提示 */}
          {isSnoozed && snoozeRemaining && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 border border-border/50 rounded px-3 py-1.5">
              <BellOff className="w-4 h-4 shrink-0" />
              <span>{snoozeRemaining}</span>
            </div>
          )}

          {alert.description && !isSnoozed && (
            <AlertDescription>{alert.description}</AlertDescription>
          )}

          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground">
            <span>首次 {new Date(alert.first_seen).toLocaleString('zh-CN')}</span>
            {/* 误报没有物理故障的时间线：恢复时刻与持续时长都无意义，显示占位符 */}
            <span>最近 {isVoided ? '-' : new Date(alert.last_seen).toLocaleString('zh-CN')}</span>
            <span>触发 {alert.occurrence_count} 次</span>
            {isVoided ? <span>持续 -</span> : duration && <span>持续 {duration}</span>}
            <span className="font-mono">{alert.alert_type}</span>
          </div>

          {!isSnoozed && evidence && Object.keys(evidence).length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer select-none text-muted-foreground">
                证据数据
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

          {!isSnoozed && recommendations.length > 0 && (
            <div className="mt-2 border-t border-border/40 pt-2">
              <div className="mb-1 text-xs font-medium">建议处理</div>
              <ul className="list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
                {recommendations.map((rec, i) => (
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