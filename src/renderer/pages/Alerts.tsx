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

type Severity = AlertRecord['severity'];
type Status = AlertRecord['status'];

type Filter = 'all' | Severity;

const SEVERITY_META: Record<Severity, { label: string; icon: typeof AlertTriangle; className: string }> = {
  critical: { label: '严重', icon: AlertTriangle, className: 'text-red-500' },
  warning: { label: '警告', icon: AlertTriangle, className: 'text-yellow-500' },
  info: { label: '提示', icon: Info, className: 'text-blue-500' },
};

const STATUS_LABEL: Record<Status, string> = {
  new: '新建',
  ongoing: '持续中',
  resolved: '已恢复',
};

const STATUS_CLASS: Record<Status, string> = {
  new: 'text-red-400',
  ongoing: 'text-orange-400',
  resolved: 'text-green-400',
};

function AlertCard({ alert }: { alert: AlertRecord }) {
  const meta = SEVERITY_META[alert.severity] ?? SEVERITY_META.info;
  const Icon = meta.icon;

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

  return (
    <Alert
      className={cn(
        'border-l-4',
        alert.severity === 'critical' && 'border-l-red-500 bg-red-500/5',
        alert.severity === 'warning' && 'border-l-yellow-500 bg-yellow-500/5',
        alert.severity === 'info' && 'border-l-blue-500 bg-blue-500/5',
        alert.status === 'resolved' && 'opacity-70'
      )}
    >
      <div className="flex items-start gap-3 pl-7">
        <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', meta.className)} />

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <AlertTitle className="mb-0 text-base">{alert.summary}</AlertTitle>
            <div className="flex items-center gap-1.5">
              <Badge variant={alert.severity === 'critical' ? 'destructive' : 'secondary'}>
                {SEVERITY_META[alert.severity]?.label ?? alert.severity}
              </Badge>
              <span className={cn('text-xs font-medium', STATUS_CLASS[alert.status])}>
                {STATUS_LABEL[alert.status] ?? alert.status}
              </span>
            </div>
          </div>

          {alert.description && (
            <AlertDescription>{alert.description}</AlertDescription>
          )}

          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground">
            <span>首次 {new Date(alert.first_seen).toLocaleString('zh-CN')}</span>
            <span>最近 {new Date(alert.last_seen).toLocaleString('zh-CN')}</span>
            <span>触发 {alert.occurrence_count} 次</span>
            {duration && <span>持续 {duration}</span>}
            <span className="font-mono">{alert.alert_type}</span>
          </div>

          {evidence && Object.keys(evidence).length > 0 && (
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

          {recommendations.length > 0 && (
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
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

  const load = useCallback(async () => {
    if (!isElectron) {
      setError('告警数据由主进程采集，需要在 Electron 环境中查看');
      setIsLoading(false);
      return;
    }
    try {
      setError(null);
      const data = await window.electronAPI.getActiveAlerts();
      setAlerts(data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载告警失败');
    } finally {
      setIsLoading(false);
    }
  }, [isElectron]);

  useEffect(() => {
    load();

    if (!isElectron) return;

    // 实时跟随: 新告警插入, 恢复后移除
    const unsubNew = window.electronAPI.onAlertNew((alert) => {
      setAlerts((prev) => [alert, ...prev.filter((a) => a.alert_key !== alert.alert_key)]);
    });
    const unsubResolved = window.electronAPI.onAlertResolved((alert) => {
      setAlerts((prev) => prev.filter((a) => a.alert_key !== alert.alert_key));
    });

    return () => {
      unsubNew();
      unsubResolved();
    };
  }, [load, isElectron]);

  const filtered = useMemo(
    () => (filter === 'all' ? alerts : alerts.filter((a) => a.severity === filter)),
    [alerts, filter]
  );

  const counts = useMemo(
    () => ({
      all: alerts.length,
      critical: alerts.filter((a) => a.severity === 'critical').length,
      warning: alerts.filter((a) => a.severity === 'warning').length,
      info: alerts.filter((a) => a.severity === 'info').length,
    }),
    [alerts]
  );

  const FILTERS: { key: Filter; label: string }[] = [
    { key: 'all', label: `全部 ${counts.all}` },
    { key: 'critical', label: `严重 ${counts.critical}` },
    { key: 'warning', label: `警告 ${counts.warning}` },
    { key: 'info', label: `提示 ${counts.info}` },
  ];

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">告警</h1>
          <p className="text-sm text-muted-foreground">
            天线异常与网络质量告警，实时更新
          </p>
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

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
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
        <div className="space-y-3">
          {filtered.map((alert) => (
            <AlertCard key={alert.id ?? alert.alert_key} alert={alert} />
          ))}
        </div>
      )}
    </div>
  );
}