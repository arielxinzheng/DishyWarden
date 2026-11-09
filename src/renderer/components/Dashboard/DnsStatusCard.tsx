/**
 * DNS 监控状态卡片
 * 展示双轨 DNS 探测的健康状态
 *
 * 文案走 `dashboard:dns.*`；相对时间复用 `common:*_ago`。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '../ui/card';
import { CheckCircle, XCircle, AlertTriangle, Wifi } from 'lucide-react';
import { cn } from '../../lib/utils';

interface DnsProbeResult {
  ok: boolean;
  rtt_ms: number | null;
  error?: string;
  resolved_ip?: string;
}

interface DnsProbeData {
  node_id: string;
  timestamp: number;
  user_dns: DnsProbeResult;
  baseline_dns: DnsProbeResult;
}

export function DnsStatusCard() {
  const { t } = useTranslation();
  const [latestProbe, setLatestProbe] = useState<DnsProbeData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // 初始加载
    loadLatestProbe();

    // 每 30 秒刷新一次
    const timer = setInterval(loadLatestProbe, 30000);
    return () => clearInterval(timer);
  }, []);

  const loadLatestProbe = async () => {
    if (!window.electronAPI?.getLatestDnsProbe) {
      setIsLoading(false);
      return;
    }

    try {
      const probe = await window.electronAPI.getLatestDnsProbe();
      setLatestProbe(probe);
    } catch (err) {
      console.error('Failed to load DNS probe:', err);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-200 mb-3">
            <Wifi className="w-4 h-4" />
            {t('dashboard:dns.card_title')}
          </div>
          <div className="text-center text-muted-foreground py-4">
            <div className="w-5 h-5 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin mx-auto mb-2" />
            <p className="text-xs">{t('common:loading')}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!latestProbe) {
    return (
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-200 mb-3">
            <Wifi className="w-4 h-4" />
            {t('dashboard:dns.card_title')}
          </div>
          <div className="text-center text-muted-foreground py-4">
            <p className="text-xs">{t('dashboard:dns.no_probe')}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const { user_dns, baseline_dns } = latestProbe;

  // 判断整体健康状态
  const getOverallStatus = () => {
    if (user_dns.ok && baseline_dns.ok) {
      return { label: t('dashboard:dns.status_ok'), color: 'text-accent-green', icon: CheckCircle };
    }
    if (!user_dns.ok && !baseline_dns.ok) {
      return {
        label: t('dashboard:dns.status_critical'),
        color: 'text-danger-red',
        icon: XCircle,
      };
    }
    return {
      label: t('dashboard:dns.status_degraded'),
      color: 'text-warning-orange',
      icon: AlertTriangle,
    };
  };

  const status = getOverallStatus();
  const StatusIcon = status.icon;

  // 延迟差异分析
  const latencyDelta =
    user_dns.ok && baseline_dns.ok && user_dns.rtt_ms && baseline_dns.rtt_ms
      ? user_dns.rtt_ms - baseline_dns.rtt_ms
      : null;

  // 相对时间: 复用 common 命名空间的 *_ago, 单位词不写死在组件里
  const age = Date.now() - latestProbe.timestamp;
  const ageText =
    age < 60000
      ? t('common:just_now')
      : age < 3600000
        ? t('common:minutes_ago', { count: Math.floor(age / 60000) })
        : t('common:hours_ago', { count: Math.floor(age / 3600000) });

  return (
    <Card>
      <CardContent className="p-5">
        {/* 标题 */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Wifi className="w-4 h-4" />
            {t('dashboard:dns.card_title')}
          </div>
          <StatusIcon className={cn('w-5 h-5', status.color)} />
        </div>

        {/* 主状态 */}
        <div className="mb-4">
          <div className={cn('text-2xl font-bold', status.color)}>{status.label}</div>
          <div className="text-xs text-muted-foreground mt-1">
            {t('dashboard:dns.updated', { time: ageText })}
          </div>
        </div>

        {/* 双轨对比 */}
        <div className="space-y-2">
          <div
            className={cn(
              'flex items-center justify-between p-2 rounded-md border',
              user_dns.ok
                ? 'bg-accent-green/5 border-accent-green/20'
                : 'bg-danger-red/5 border-danger-red/20',
            )}
          >
            <span className="text-xs text-muted-foreground">{t('dashboard:dns.user_dns')}</span>
            <span
              className={cn(
                'text-xs font-mono font-semibold',
                user_dns.ok ? 'text-accent-green' : 'text-danger-red',
              )}
            >
              {user_dns.ok ? `${user_dns.rtt_ms?.toFixed(0) ?? '?'} ms` : t('dashboard:dns.failed')}
            </span>
          </div>

          <div
            className={cn(
              'flex items-center justify-between p-2 rounded-md border',
              baseline_dns.ok
                ? 'bg-sky-blue/5 border-sky-blue/20'
                : 'bg-danger-red/5 border-danger-red/20',
            )}
          >
            <span className="text-xs text-muted-foreground">{t('dashboard:dns.baseline_dns')}</span>
            <span
              className={cn(
                'text-xs font-mono font-semibold',
                baseline_dns.ok ? 'text-sky-blue' : 'text-danger-red',
              )}
            >
              {baseline_dns.ok
                ? `${baseline_dns.rtt_ms?.toFixed(0) ?? '?'} ms`
                : t('dashboard:dns.failed')}
            </span>
          </div>
        </div>

        {/* 延迟差异提示 */}
        {latencyDelta !== null && Math.abs(latencyDelta) > 10 && (
          <div className="mt-3 p-2 rounded-md bg-warning-orange/5 border border-warning-orange/20">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-3 h-3 text-warning-orange" />
              <span className="text-xs text-warning-orange">
                {t('dashboard:dns.high_latency', { delta: latencyDelta.toFixed(0) })}
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
