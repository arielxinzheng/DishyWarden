/**
 * 告警页面
 *
 * 数据来自主进程 AlertManager(通过 window.electronAPI)。
 * 浏览器环境下无 IPC, 会明确提示而不是静默显示空列表。
 *
 * 本页只负责「列表状态」：视图切换、筛选、分页、分组。
 * 单条告警的渲染与降噪操作在 components/Alerts/AlertCard.tsx。
 *
 * 两个视图的语义不同，别混：
 * - 活跃：主进程返回全量，前端按「未忽略优先 + 严重度」排序，条件是客户端过滤
 * - 历史：主进程按 last_seen DESC 排好并分页，条件全部下发（默认最近 7 天）
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle,
  RefreshCw,
  ShieldAlert,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Card } from '../components/ui/card';
import { cn } from '../lib/utils';
import type { AlertRecord } from '../../alerting/database';
import { AlertCard, type Severity } from '../components/Alerts/AlertCard';
import { HistoryFilterBar } from '../components/Alerts/HistoryFilterBar';
import {
  DEFAULT_HISTORY_FILTERS,
  isDefaultWindow,
  toHistoryQuery,
  type HistoryFilters,
} from '../components/Alerts/historyFilters';
import { groupByDay } from '../components/Alerts/historyWindow';

type Filter = 'all' | Severity;
type ViewMode = 'active' | 'history';

const PAGE_SIZE = 50;

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('active');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 历史视图分页 + 条件
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<HistoryFilters>(DEFAULT_HISTORY_FILTERS);
  const [rangeOpen, setRangeOpen] = useState(false);

  // 条件变了旧页码可能已经越界（比如 20 页缩到 2 页），必须回到第一页
  const updateFilters = useCallback((patch: Partial<HistoryFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(0);
  }, []);

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
        // 时间窗口语义全部收在 historyFilters.toHistoryQuery：
        // 未选范围就是「最近 7 天」，页面上不出现第二份判断
        const result = await window.electronAPI.getAlertHistory(
          toHistoryQuery(filters, page, PAGE_SIZE, Date.now())
        );
        setAlerts(result.alerts ?? []);
        setTotal(result.total ?? 0);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载告警失败');
    } finally {
      setIsLoading(false);
    }
  }, [isElectron, viewMode, filters, page]);

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

  // 活跃列表是「待处理队列」：未忽略的置顶，同级按严重度。
  // 历史列表不在这里排 —— 后端已按 last_seen DESC 排好，前端再排就是第二份判据。
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

  // 历史按 last_seen 的本地日历日切段，只做相邻聚合（不重排，顺序即后端顺序）
  const groups = useMemo(
    () => (viewMode === 'history' ? groupByDay(alerts, Date.now()) : []),
    [viewMode, alerts]
  );

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

  // 历史视图的每档数量要各查一次 COUNT 才准确，为一行数字打四次 IPC 不值得 ——
  // 只显示当前页能算出来的总数，其余不带计数
  const FILTERS: { key: Filter; label: string }[] =
    viewMode === 'active'
      ? [
          { key: 'all', label: `全部 ${counts.all}` },
          { key: 'critical', label: `严重 ${counts.critical}` },
          { key: 'warning', label: `警告 ${counts.warning}` },
          { key: 'info', label: `提示 ${counts.info}` },
        ]
      : [
          { key: 'all', label: `全部 ${counts.all}` },
          { key: 'critical', label: '严重' },
          { key: 'warning', label: '警告' },
          { key: 'info', label: '提示' },
        ];

  const totalPages = Math.ceil(total / PAGE_SIZE);
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

      {viewMode === 'history' && (
        <HistoryFilterBar
          filters={filters}
          onChange={updateFilters}
          rangeOpen={rangeOpen}
          onRangeOpenChange={setRangeOpen}
        />
      )}

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
          {viewMode === 'active'
            ? (alerts.length === 0 ? '无活跃告警' : '该分类下没有告警')
            : '该时间范围内没有告警记录'}
        </Card>
      )}

      {/* 活跃视图：待处理队列 */}
      {viewMode === 'active' && filtered.length > 0 && (
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
      )}

      {/* 历史视图：按日分段，段间一条轻分割线 */}
      {viewMode === 'history' && groups.length > 0 && (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.dayKey} className="space-y-3">
              <DayHeader label={group.label} count={group.items.length} />
              {group.items.map((alert) => (
                <AlertCard
                  key={alert.id ?? alert.alert_key}
                  alert={alert}
                  onSnooze={handleSnooze}
                  onUnsnooze={handleUnsnooze}
                  onMarkFalsePositive={handleMarkFalsePositive}
                  onUnmarkFalsePositive={handleUnmarkFalsePositive}
                />
              ))}
            </section>
          ))}
        </div>
      )}

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

      {/* 用户没选范围时说清楚"看不到更早"不是数据丢了 */}
      {viewMode === 'history' && isDefaultWindow(filters) && total > 0 && (
        <p className="text-center text-xs text-muted-foreground">
          默认仅显示最近 7 天的记录，可选择日期范围查看更早历史
        </p>
      )}
    </div>
  );
}

/**
 * 日期分割线：轻到不抢卡片的存在感，只用来切段
 *
 * 颜色必须用 Tailwind 内置色（slate-*），不能用 `border` / `muted-foreground`
 * 这类语义 token —— 本项目的 @theme 里只声明了 ink-* / accent-* / danger-red，
 * tailwind.config.js 里的 theme 扩展在 v4 下**完全不加载**，所以
 * `bg-border/70` 的实际计算值是 rgba(0,0,0,0)：线是透明的，分割线根本看不见。
 * `text-muted-foreground` 同理会退回继承色 rgb(248,250,252)，日期标题与正文同色。
 */
function DayHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <span className="text-xs font-medium text-slate-400">{label}</span>
      <span className="text-xs text-slate-500">{count} 条</span>
      <div className="h-px flex-1 bg-slate-700/60" />
    </div>
  );
}