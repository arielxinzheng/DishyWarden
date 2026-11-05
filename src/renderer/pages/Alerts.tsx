/**
 * 告警页面
 *
 * 数据来自主进程 AlertManager(通过 window.electronAPI)。
 * 浏览器环境下无 IPC, 会明确提示而不是静默显示空列表。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  Info,
  RefreshCw,
  ShieldAlert,
  ChevronLeft,
  ChevronRight,
  BellOff,
  MoreVertical,
  Bell,
  Ban,
  Undo2,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { cn } from '../lib/utils';
import {
  parseEvidence,
  parseRecommendations,
  formatAlertDuration,
} from '../lib/alertFormat';
import type { AlertRecord } from '../../alerting/database';
import { AlertSnoozeMenu } from '../components/Dashboard/AlertSnoozeMenu';

type Severity = AlertRecord['severity'];
type Status = AlertRecord['status'];

type Filter = 'all' | Severity;
type ViewMode = 'active' | 'history';

const SEVERITY_META: Record<Severity, { label: string; icon: typeof AlertTriangle; className: string }> = {
  critical: { label: '严重', icon: AlertTriangle, className: 'text-red-500' },
  warning: { label: '警告', icon: AlertTriangle, className: 'text-yellow-500' },
  info: { label: '提示', icon: Info, className: 'text-blue-500' },
};

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

function AlertCard({ 
  alert, 
  onSnooze,
  onUnsnooze,
  onMarkFalsePositive,
  onUnmarkFalsePositive,
}: { 
  alert: AlertRecord;
  onSnooze: (alertKey: string, type: 'temporary' | 'until_resolved', durationMs?: number) => Promise<void>;
  onUnsnooze: (alertKey: string) => Promise<void>;
  onMarkFalsePositive: (alertKey: string) => Promise<void>;
  onUnmarkFalsePositive: (alertKey: string) => Promise<void>;
}) {
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

  const evidence = useMemo(
    () => parseEvidence(alert.evidence),
    [alert.evidence]
  );

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

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('active');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // 历史视图分页
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const pageSize = 50;

  const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

  const load = useCallback(async () => {
    if (!isElectron) {
      setError('告警数据由主进程采集，需要在 Electron 环境中查看');
      setIsLoading(false);
      return;
    }
    try {
      setError(null);
      if (viewMode === 'active') {
        const data = await window.electronAPI.getActiveAlerts();
        setAlerts(data ?? []);
        setTotal(data?.length ?? 0);
      } else {
        const severityFilter = filter === 'all' ? undefined : filter;
        const result = await window.electronAPI.getAlertHistory({
          limit: pageSize,
          offset: page * pageSize,
          severity: severityFilter,
        });
        setAlerts(result.alerts ?? []);
        setTotal(result.total ?? 0);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载告警失败');
    } finally {
      setIsLoading(false);
    }
  }, [isElectron, viewMode, filter, page]);

  useEffect(() => {
    setIsLoading(true);
    load();

    // 只在活跃视图时监听实时更新
    if (!isElectron || viewMode !== 'active') return;

    // 实时跟随: 新告警插入, 恢复后移除
    const unsubNew = window.electronAPI.onAlertNew((alert) => {
      setAlerts((prev) => [alert, ...prev.filter((a) => a.alert_key !== alert.alert_key)]);
    });
    const unsubResolved = window.electronAPI.onAlertResolved((alert) => {
      setAlerts((prev) => prev.filter((a) => a.alert_key !== alert.alert_key));
    });
    // 降噪状态由主进程持有，本地无法推算，收到广播后整体重拉
    const unsubChanged = window.electronAPI.onAlertsChanged(() => {
      load();
    });

    return () => {
      unsubNew();
      unsubResolved();
      unsubChanged();
    };
  }, [load, isElectron, viewMode]);

  // 历史视图时不需要客户端筛选，已在服务端完成
  const filtered = viewMode === 'active'
    ? (filter === 'all' ? alerts : alerts.filter((a) => a.severity === filter))
    : alerts;

  // 按忽略状态和严重程度排序: 未忽略的置顶, 已忽略的沉底
  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      // 判断忽略状态（误报已不在活跃列表，这里只需处理限时/本次忽略）
      const aIsSnoozed =
        a.snooze_type === 'until_resolved' ||
        (a.snooze_until && new Date(a.snooze_until).getTime() > Date.now());
      const bIsSnoozed =
        b.snooze_type === 'until_resolved' ||
        (b.snooze_until && new Date(b.snooze_until).getTime() > Date.now());
      
      // 未忽略的优先
      if (aIsSnoozed !== bIsSnoozed) {
        return aIsSnoozed ? 1 : -1;
      }
      
      // 同状态下按严重程度排序
      const severityOrder = { critical: 0, warning: 1, info: 2 };
      return (severityOrder[a.severity as keyof typeof severityOrder] ?? 99) - 
             (severityOrder[b.severity as keyof typeof severityOrder] ?? 99);
    });
  }, [filtered]);

  const handleSnooze = async (alertKey: string, type: 'temporary' | 'until_resolved', durationMs?: number) => {
    if (!window.electronAPI?.snoozeAlert) return;

    // 成功后由主进程广播 alerts-changed 触发重拉，本组件不自行改本地状态
    await window.electronAPI.snoozeAlert({ alertKey, snoozeType: type, durationMs });
  };

  const handleUnsnooze = async (alertKey: string) => {
    if (!window.electronAPI?.unsnoozeAlert) return;

    await window.electronAPI.unsnoozeAlert(alertKey);
  };

  const handleMarkFalsePositive = async (alertKey: string) => {
    if (!window.electronAPI?.markFalsePositive) return;

    // 成功后主进程广播 alerts-changed，本页重拉；
    // 该告警会从活跃列表消失，出现在历史记录的「已标记误报」里
    const result = await window.electronAPI.markFalsePositive({ alertKey });
    if (result.success) {
      // TODO: 显示 Toast 提示
      console.log('感谢反馈，已为您清除该提示，我们将持续优化检测算法。');
    }
  };

  const handleUnmarkFalsePositive = async (alertKey: string) => {
    if (!window.electronAPI?.unmarkFalsePositive) return;
    await window.electronAPI.unmarkFalsePositive(alertKey);
  };

  const counts = useMemo(
    () => ({
      all: viewMode === 'active' ? alerts.length : total,
      critical: alerts.filter((a) => a.severity === 'critical').length,
      warning: alerts.filter((a) => a.severity === 'warning').length,
      info: alerts.filter((a) => a.severity === 'info').length,
    }),
    [alerts, total, viewMode]
  );

  const FILTERS: { key: Filter; label: string }[] = [
    { key: 'all', label: `全部 ${counts.all}` },
    { key: 'critical', label: `严重 ${counts.critical}` },
    { key: 'warning', label: `警告 ${counts.warning}` },
    { key: 'info', label: `提示 ${counts.info}` },
  ];

  const totalPages = Math.ceil(total / pageSize);
  const hasNextPage = page < totalPages - 1;
  const hasPrevPage = page > 0;

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">告警</h1>
          <p className="text-sm text-muted-foreground">
            天线异常与网络质量告警
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* 视图切换 */}
          <div className="flex rounded-md border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => { setViewMode('active'); setPage(0); setFilter('all'); }}
              className={cn(
                'px-3 py-1.5 text-sm transition-colors',
                viewMode === 'active'
                  ? 'bg-accent-green/10 text-accent-green'
                  : 'text-muted-foreground hover:bg-ink-800'
              )}
            >
              活跃告警
            </button>
            <button
              type="button"
              onClick={() => { setViewMode('history'); setPage(0); setFilter('all'); }}
              className={cn(
                'px-3 py-1.5 text-sm transition-colors border-l border-border',
                viewMode === 'history'
                  ? 'bg-accent-green/10 text-accent-green'
                  : 'text-muted-foreground hover:bg-ink-800'
              )}
            >
              历史记录
            </button>
          </div>

          <button
            type="button"
            onClick={() => { setIsLoading(true); load(); }}
            disabled={isLoading || !isElectron}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-ink-800 disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
            刷新
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => { setFilter(f.key); setPage(0); }}
            className={cn(
              'rounded-full border px-3 py-1 text-xs transition-colors',
              filter === f.key
                ? 'border-accent-green bg-accent-green/10 text-accent-green'
                : 'border-border text-muted-foreground hover:bg-ink-800'
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <Alert className="border-yellow-500/50 bg-yellow-500/10">
          <div className="flex items-start gap-3 pl-7">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-yellow-500" />
            <AlertDescription>{error}</AlertDescription>
          </div>
        </Alert>
      )}

      {!error && isLoading && alerts.length === 0 && (
        <Card className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin" />
          加载中…
        </Card>
      )}

      {!error && !isLoading && filtered.length === 0 && (
        <Card className="flex items-center justify-center gap-2 p-8 text-sm text-green-500">
          <CheckCircle className="h-5 w-5" />
          {alerts.length === 0 ? '无活跃告警' : '该分类下没有告警'}
        </Card>
      )}

      {filtered.length > 0 && (
        <>
          <div className="space-y-3">
            {sorted.map((alert) => (
              <AlertCard 
                key={alert.id ?? alert.alert_key} 
                alert={alert}
                onSnooze={handleSnooze}
                onUnsnooze={handleUnsnooze}
                onMarkFalsePositive={handleMarkFalsePositive}
                onUnmarkFalsePositive={handleUnmarkFalsePositive}
              />
            ))}
          </div>

          {/* 历史视图分页 */}
          {viewMode === 'history' && totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-border pt-4">
              <div className="text-sm text-muted-foreground">
                第 {page + 1} / {totalPages} 页，共 {total} 条
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={!hasPrevPage}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-ink-800 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="h-4 w-4" />
                  上一页
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={!hasNextPage}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-ink-800 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  下一页
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}