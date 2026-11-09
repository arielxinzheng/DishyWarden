/**
 * DNS 告警详情组件
 * 展示双轨探测对比数据和归因分析
 *
 * 文案全部来自 `dashboard:dns.*` —— 这里只做渲染。
 */

import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import { cn } from '../../lib/utils';

interface DnsProbeData {
  ok: boolean;
  rtt_ms: number | null;
  error?: string;
  resolved_ip?: string;
}

interface DnsAlertDetailProps {
  evidence: {
    node_id?: string;
    consecutive_failures?: number;
    user_dns?: DnsProbeData;
    baseline_dns?: DnsProbeData;
  };
}

export function DnsAlertDetail({ evidence }: DnsAlertDetailProps) {
  const { t } = useTranslation();
  const { user_dns, baseline_dns } = evidence;

  if (!user_dns || !baseline_dns) {
    return null;
  }

  const renderProbeStatus = (label: string, probe: DnsProbeData) => {
    const StatusIcon = probe.ok ? CheckCircle : XCircle;
    const statusColor = probe.ok ? 'text-accent-green' : 'text-danger-red';
    const bgColor = probe.ok
      ? 'bg-accent-green/10 border-accent-green/30'
      : 'bg-danger-red/10 border-danger-red/30';

    return (
      <div className={cn('rounded-lg border p-4', bgColor)}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <StatusIcon className={cn('h-5 w-5', statusColor)} />
            <span className="font-semibold">{label}</span>
          </div>
          <span className={cn('text-xs font-medium', statusColor)}>
            {probe.ok ? t('dashboard:dns.probe_ok') : t('dashboard:dns.probe_failed')}
          </span>
        </div>

        <div className="space-y-2 text-sm">
          {probe.ok ? (
            <>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('dashboard:dns.delay')}</span>
                <span className="font-mono font-semibold">
                  {probe.rtt_ms?.toFixed(1) ?? '?'} ms
                </span>
              </div>
              {probe.resolved_ip && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('dashboard:dns.resolved_ip')}</span>
                  <span className="font-mono text-xs">{probe.resolved_ip}</span>
                </div>
              )}
            </>
          ) : (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('dashboard:dns.error_info')}</span>
              <span className="font-mono text-xs text-danger-red">
                {probe.error || t('dashboard:dns.resolve_failed')}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  };

  // 延迟对比分析
  const renderLatencyComparison = () => {
    if (!user_dns.ok || !baseline_dns.ok) return null;

    const userLatency = user_dns.rtt_ms || 0;
    const baselineLatency = baseline_dns.rtt_ms || 0;
    const delta = userLatency - baselineLatency;

    if (Math.abs(delta) < 10) return null; // 差异小于 10ms 不显示

    return (
      <div className="mt-4 rounded-lg border border-warning-orange/30 bg-warning-orange/5 p-3">
        <div className="flex items-center gap-2 text-sm">
          <AlertCircle className="h-4 w-4 text-warning-orange" />
          <span className="text-muted-foreground">
            {t('dashboard:dns.latency_delta', { delta: delta.toFixed(0) })}
            {delta > 100 && (
              <span className="ml-1 text-xs">{t('dashboard:dns.latency_delta_hint')}</span>
            )}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="text-sm font-semibold text-foreground mb-2">
        {t('dashboard:dns.alert_title')}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {renderProbeStatus(t('dashboard:dns.user_dns'), user_dns)}
        {renderProbeStatus(t('dashboard:dns.baseline_dns'), baseline_dns)}
      </div>

      {renderLatencyComparison()}

      {evidence.consecutive_failures && evidence.consecutive_failures > 0 && (
        <div className="text-xs text-muted-foreground">
          {t('dashboard:dns.consecutive_failures', { count: evidence.consecutive_failures })}
        </div>
      )}
    </div>
  );
}
