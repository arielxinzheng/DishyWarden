import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Alert, AlertDescription } from '../ui/alert';
import { 
  Activity, 
  AlertCircle,
  Loader2,
  WifiOff,
  RefreshCw,
  Clock,
  Globe,
  ChevronDown,
} from 'lucide-react';
import { useDish, useDishHistory, useHistorySummary, type ObstructionData } from '../../hooks/useDish';
import {
  analyzeObstructionMap,
  assessObstructionImpact,
  describeObstructionAge,
} from '../../lib/obstructionAnalysis';
import {
  formatLatency,
  formatBandwidth,
  formatPercentage,
  getSignalQuality,
  getSignalQualityLabel,
  getObstructionSeverity,
  getObstructionSeverityLabel,
} from '../../../core/telemetry';
import { LatencyChart } from './LatencyChart';
import { ThroughputChart } from './ThroughputChart';
import { AlertList } from './AlertList';
import { ObstructionHemisphere } from './ObstructionHemisphere';
import { MetricCard } from './MetricCard';
import { RouterStatusRow } from './RouterStatusRow';
import { buildMetricSeries, peakOf } from './metricSeries';

type TimeRange = '15m' | '1h' | '6h';
type RefreshInterval = '30s' | '1m' | 'manual';

/**
 * 时间范围 → 查询秒数。
 * 页面上的选择器和图表查询从这里派生, 不再各自写死时间窗。
 */
const TIME_RANGE_SECONDS: Record<TimeRange, number> = {
  '15m': 15 * 60,
  '1h': 60 * 60,
  '6h': 6 * 60 * 60,
};

// 字节 → GB 数值（保留 2 位），单位由 UI 单独渲染
const toGb = (bytes: number) => (bytes / 1024 ** 3).toFixed(2);

export default function Dashboard() {
  const { telemetry, isConnected, isLoading, error, refresh, obstruction } = useDish();
  // 24h 统计摘要：来自 SQLite 历史库，替代此前的硬编码值
  const summary24h = useHistorySummary(86400);
  const [timeRange, setTimeRange] = useState<TimeRange>('1h');
  // 图表数据在这里取一次, 两个图表共用 —— 避免各自发起 IPC 查询
  const { history, isLoading: historyLoading } = useDishHistory(TIME_RANGE_SECONDS[timeRange]);
  // 六张指标卡的走势序列：和图表共用同一份 history, 各取一条指标
  const metricSeries = useMemo(() => buildMetricSeries(history), [history]);
  const [refreshInterval, setRefreshInterval] = useState<RefreshInterval>('30s');
  const [showRefreshMenu, setShowRefreshMenu] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeAlerts, setActiveAlerts] = useState<any[]>([]);

  // 监听活跃告警
  useEffect(() => {
    // 初始加载
    const loadAlerts = async () => {
      if (window.electronAPI) {
        const alerts = await window.electronAPI.getActiveAlerts();
        setActiveAlerts(alerts || []);
      }
    };

    loadAlerts();

    // 监听告警变化
    if (window.electronAPI) {
      const unsubscribeNew = window.electronAPI.onAlertNew((alert: any) => {
        setActiveAlerts((prev) => [alert, ...prev]);
      });

      const unsubscribeResolved = window.electronAPI.onAlertResolved((alert: any) => {
        setActiveAlerts((prev) => prev.filter((a) => a.alert_key !== alert.alert_key));
      });

      return () => {
        unsubscribeNew();
        unsubscribeResolved();
      };
    }
  }, []);

  // 判断是否有严重告警
  const hasCriticalAlerts = useMemo(() => {
    return activeAlerts.some((alert) => alert.severity === 'critical');
  }, [activeAlerts]);

  const hasAlerts = activeAlerts.length > 0;

  // 自动刷新逻辑
  useEffect(() => {
    if (refreshInterval === 'manual') return;
    
    const ms = refreshInterval === '30s' ? 30000 : 60000;
    const timer = setInterval(() => {
      refresh();
    }, ms);
    
    return () => clearInterval(timer);
  }, [refreshInterval, refresh]);

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    await refresh();
    setTimeout(() => setIsRefreshing(false), 500);
  };

  if (isLoading && !telemetry) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin mx-auto mb-4 text-accent-green" />
          <p className="text-muted-foreground">正在连接 Starlink 设备...</p>
          <p className="text-xs text-muted-foreground mt-2">请确保设备已接入网络</p>
        </div>
      </div>
    );
  }

  if (error && !telemetry) {
    return (
      <div className="p-8 max-w-2xl mx-auto mt-20">
        <Alert className="border-danger-red/50 bg-danger-red/10">
          <WifiOff className="h-4 w-4 text-danger-red" />
          <AlertDescription className="ml-7">
            <div className="space-y-4">
              <div>
                <p className="font-semibold mb-1">无法连接到 Starlink 设备</p>
                <p className="text-sm">{error}</p>
              </div>
              <div className="text-sm space-y-1">
                <p className="font-semibold">请检查：</p>
                <ul className="list-disc ml-4 space-y-1">
                  <li>Starlink 终端是否已通电并启动完成</li>
                  <li>本机是否已连接到 Starlink 网络（通常是 192.168.100.x）</li>
                  <li>防火墙或网络安全软件是否阻止了连接</li>
                  <li>Starlink 设备地址是否正确（默认: 192.168.100.1:9200）</li>
                </ul>
              </div>
              <button
                onClick={() => refresh()}
                disabled={isLoading}
                className="px-4 py-2 bg-accent-green/20 hover:bg-accent-green/30 text-accent-green rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? '重试中...' : '重试连接'}
              </button>
            </div>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!telemetry) {
    return null;
  }

  // 概览带取值：有历史数据用真实统计，没有则显示占位
  const hasHistory = (summary24h?.sampleCount ?? 0) > 0;
  const availability = summary24h?.availability ?? 0;
  const availabilityText = hasHistory ? `${(availability * 100).toFixed(1)}%` : '—';
  const usageTotalGb = hasHistory
    ? toGb(summary24h!.estimatedDownBytes + summary24h!.estimatedUpBytes)
    : '—';
  const usageDownGb = hasHistory ? toGb(summary24h!.estimatedDownBytes) : '—';
  const usageUpGb = hasHistory ? toGb(summary24h!.estimatedUpBytes) : '—';
  const outageCount = hasHistory ? summary24h!.outageCount : null;
  const availabilityColor = !hasHistory
    ? 'text-muted-foreground'
    : availability >= 0.99
      ? 'text-accent-green'
      : availability >= 0.95
        ? 'text-warning-orange'
        : 'text-danger-red';

  // 指标卡的副标题统一用「所选时间范围的峰值」, 与迷你图同源。
  // 当前采样也要计入: 历史查询最多滞后 60s, 否则会出现「峰值 33.5 ms」小于主数值 35.5 ms 的矛盾
  const peakInRange = (series: number[], current: number) => peakOf([...series, current]);
  const latencyPeak = peakInRange(metricSeries.latency, telemetry.popPingLatencyMs);
  const dropPeak = peakInRange(metricSeries.drop, telemetry.popPingDropRate);
  const downPeak = peakInRange(metricSeries.down, telemetry.downlinkThroughputBps);
  const upPeak = peakInRange(metricSeries.up, telemetry.uplinkThroughputBps);

  // 对准判定：姿态不确定度 ≤ 2° 视为已对准；字段缺失时不算对准
  const alignmentUncertainty = telemetry.alignmentStats?.attitudeUncertaintyDeg;
  const isAligned = alignmentUncertainty !== undefined && alignmentUncertainty <= 2;
  const alignmentUncertaintyText =
    alignmentUncertainty !== undefined ? `${alignmentUncertainty.toFixed(1)}°` : '—';

  return (
    <div className="p-8 space-y-8">
      {/* Header with controls */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold">仪表盘</h1>
          <p className="text-muted-foreground mt-1">实时监控星链终端状态</p>
        </div>
        
        {/* Right controls area */}
        <div className="flex items-center gap-2">
          {/* Connection status badge */}
          <Badge 
            variant="outline" 
            className={isConnected ? 'text-accent-green border-accent-green px-4 py-2' : 'text-muted-foreground px-4 py-2'}
          >
            <span className={`w-2 h-2 rounded-full mr-2 ${isConnected ? 'bg-accent-green animate-pulse' : 'bg-muted-foreground'}`}></span>
            {isConnected ? '实时监控中' : '连接断开'}
          </Badge>

          {/* Time range selector */}
          <div className="hidden sm:flex items-center gap-1 bg-muted/40 border border-border rounded-md p-1">
            {(['15m', '1h', '6h'] as TimeRange[]).map((range) => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  timeRange === range
                    ? 'bg-accent-green/20 text-accent-green'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {range.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Auto-refresh interval */}
          <div className="relative hidden md:block">
            <button
              onClick={() => setShowRefreshMenu(!showRefreshMenu)}
              className="flex items-center gap-2 px-3 py-2 rounded-md border border-border hover:border-sky-blue/50 hover:bg-muted/60 transition-colors text-sm"
            >
              <Clock className={`w-4 h-4 text-sky-blue ${refreshInterval !== 'manual' ? '' : 'opacity-60'}`} />
              <span className="font-mono text-xs">
                {refreshInterval === 'manual' ? '手动' : refreshInterval}
              </span>
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            </button>
            
            {showRefreshMenu && (
              <div className="absolute right-0 mt-1 w-28 rounded-md border border-border bg-background shadow-lg py-1 z-50">
                {(['30s', '1m', 'manual'] as RefreshInterval[]).map((interval) => (
                  <button
                    key={interval}
                    onClick={() => {
                      setRefreshInterval(interval);
                      setShowRefreshMenu(false);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-muted flex items-center gap-2 ${
                      refreshInterval === interval ? 'text-accent-green' : 'text-foreground'
                    }`}
                  >
                    {refreshInterval === interval && <span className="w-3">✓</span>}
                    {refreshInterval !== interval && <span className="w-3"></span>}
                    <span>{interval === 'manual' ? '手动' : interval}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Manual refresh button */}
          <button
            onClick={handleManualRefresh}
            disabled={isRefreshing}
            className="w-9 h-9 flex items-center justify-center rounded-md border border-border hover:border-accent-green/50 hover:bg-muted/60 transition-colors disabled:opacity-50"
            title="立即刷新"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-accent-green' : 'text-muted-foreground'}`} />
          </button>

          {/* Official site link */}
          <a
            href="https://www.starlink.com"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden lg:flex items-center gap-2 px-3 py-2 rounded-md border border-sky-blue/40 bg-sky-blue/10 text-sky-blue hover:bg-sky-blue/20 transition-colors text-sm"
          >
            <Globe className="w-4 h-4" />
            <span className="font-medium">官网</span>
          </a>
        </div>
      </div>

      {/* 活跃告警 - 战时动态推展，平时隐藏 */}
      {hasAlerts && (
        <div 
          className={`overflow-hidden transition-all duration-300 ${
            hasCriticalAlerts ? 'animate-pulse-slow' : ''
          }`}
          style={{
            animation: hasCriticalAlerts ? 'pulse-glow 2s ease-in-out infinite' : 'none'
          }}
        >
          <div 
            className={`rounded-2xl border p-6 ${
              hasCriticalAlerts 
                ? 'border-danger-red bg-danger-red/10 shadow-[0_0_20px_rgba(239,68,68,0.3)]' 
                : 'border-warning-orange/50 bg-warning-orange/5'
            }`}
          >
            <div className="flex items-center gap-3 mb-4">
              <AlertCircle className={`w-6 h-6 ${hasCriticalAlerts ? 'text-danger-red' : 'text-warning-orange'}`} />
              <h2 className={`text-xl font-semibold ${hasCriticalAlerts ? 'text-danger-red' : 'text-warning-orange'}`}>
                活跃告警 {hasCriticalAlerts && '- 严重'}
              </h2>
              <Badge 
                variant={hasCriticalAlerts ? 'destructive' : 'secondary'}
                className="ml-auto"
              >
                {activeAlerts.length} 个告警
              </Badge>
            </div>
            <AlertList />
          </div>
        </div>
      )}

      {/* System overview band - 5 status blocks */}
      <div className="relative overflow-hidden rounded-2xl border border-border">
        <div 
          className="absolute inset-0 opacity-[.06] pointer-events-none"
          style={{
            backgroundImage: 'linear-gradient(rgba(148,163,184,.6) 1px,transparent 1px),linear-gradient(90deg,rgba(148,163,184,.6) 1px,transparent 1px)',
            backgroundSize: '38px 38px'
          }}
        />
        <div 
          className="relative"
          style={{
            background: isConnected 
              ? 'radial-gradient(900px 300px at 12% -40%, rgba(74,222,128,.14), transparent 60%), linear-gradient(120deg,#08120d,#0a0c10)'
              : 'radial-gradient(900px 300px at 12% -40%, rgba(239,68,68,.16), transparent 60%), linear-gradient(120deg,#12080a,#0a0c10)'
          }}
        >
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 divide-x divide-border/30">
            {/* 1. Overall status */}
            <div className="p-5">
              <div className="flex items-center gap-2 text-sm uppercase tracking-[0.12em] font-semibold text-slate-200">
                状态
              </div>
              <div className={`mt-2 flex items-center gap-2 text-xl font-bold ${isConnected ? 'text-accent-green' : 'text-danger-red'}`}>
                <span className={`w-2.5 h-2.5 rounded-full ${isConnected ? 'bg-accent-green animate-pulse' : 'bg-danger-red animate-pulse'}`}></span>
                <span>{isConnected ? '正常' : '离线'}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                24h 可用率{' '}
                <span className={`font-mono ${availabilityColor}`}>{availabilityText}</span>
              </div>
            </div>

            {/* 2. Today's data usage */}
            <div className="p-5">
              <div className="flex items-center gap-2 text-sm uppercase tracking-[0.12em] font-semibold text-slate-200">
                24h 用量
              </div>
              <div className="mt-2 text-2xl font-extrabold text-slate-100 font-mono">
                <span>{usageTotalGb}</span>
                <span className="text-sm text-muted-foreground ml-1">GB</span>
              </div>
              <div className="text-xs text-muted-foreground mt-1 font-mono">
                <span className="text-sky-blue">↓ {usageDownGb} GB</span> /{' '}
                <span className="text-accent-green">↑ {usageUpGb} GB</span>
              </div>
            </div>

            {/* 3. Anomalies & outages */}
            <div className="p-5">
              <div className="flex items-center gap-2 text-sm uppercase tracking-[0.12em] font-semibold text-slate-200">
                中断次数
              </div>
              <div
                className={`mt-2 text-2xl font-extrabold font-mono ${
                  outageCount === null
                    ? 'text-muted-foreground'
                    : outageCount === 0
                      ? 'text-accent-green'
                      : 'text-warning-orange'
                }`}
              >
                {outageCount === null ? (
                  <span>—</span>
                ) : outageCount === 0 ? (
                  <span>无中断</span>
                ) : (
                  <>
                    <span>{outageCount}</span>
                    <span className="text-sm text-muted-foreground ml-1">次</span>
                  </>
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {outageCount === null ? '暂无历史样本' : '近 24h 统计'}
              </div>
            </div>

            {/* 4. Alignment status — 取自 alignmentStats，无数据时显示占位 */}
            <div className="p-5">
              <div className="flex items-center gap-2 text-sm uppercase tracking-[0.12em] font-semibold text-slate-200">
                对准状态
              </div>
              <div className={`mt-2 text-2xl font-extrabold font-mono ${isAligned ? 'text-accent-green' : 'text-warning-orange'}`}>
                {isAligned ? '已对准' : '校准中'}
              </div>
              <div className="text-xs text-muted-foreground mt-1 font-mono">
                误差 {alignmentUncertaintyText} · 锁星{' '}
                {telemetry.secondsToFirstNonemptySlot > 0
                  ? `${telemetry.secondsToFirstNonemptySlot}s`
                  : '—'}
              </div>
            </div>

            {/* 5. Uptime */}
            <div className="p-5 col-span-2 md:col-span-3 lg:col-span-1">
              <div className="flex items-center gap-2 text-sm uppercase tracking-[0.12em] font-semibold text-slate-200">
                运行时间
              </div>
              <div className="mt-2 text-2xl font-extrabold text-slate-100 font-mono">
                {telemetry.uptime > 0 ? formatUptime(telemetry.uptime) : '—'}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                固件 {telemetry.softwareVersion || '—'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 6 metric cards row with mini charts */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <MetricCard
          title="连接状态"
          value={telemetry.state === 'ONLINE' ? '在线' : telemetry.state || '—'}
          subtitle={`信号${getSignalQualityLabel(getSignalQuality(telemetry.snr))}`}
          dotColor={telemetry.state === 'ONLINE' ? '#4ade80' : '#94a3b8'}
          series={metricSeries.availability}
          chartType="line"
          domain={[0, 1]}
        />
        
        <MetricCard
          title="延迟"
          value={formatLatency(telemetry.popPingLatencyMs)}
          subtitle={latencyPeak === null ? '暂无历史样本' : `峰值 ${formatLatency(latencyPeak)}`}
          dotColor="#4ade80"
          series={metricSeries.latency}
          chartType="area"
        />
        
        <MetricCard
          title="丢包率"
          value={formatPercentage(telemetry.popPingDropRate)}
          subtitle={dropPeak === null ? '暂无历史样本' : `峰值 ${formatPercentage(dropPeak)}`}
          dotColor={telemetry.popPingDropRate > 0.05 ? '#ef4444' : '#4ade80'}
          series={metricSeries.drop}
          chartType="line"
        />
        
        <MetricCard
          title="下载速度"
          value={formatBandwidth(telemetry.downlinkThroughputBps)}
          subtitle={downPeak === null ? '暂无历史样本' : `峰值 ${formatBandwidth(downPeak)}`}
          dotColor="#38bdf8"
          series={metricSeries.down}
          chartType="bars"
        />
        
        <MetricCard
          title="上传速度"
          value={formatBandwidth(telemetry.uplinkThroughputBps)}
          subtitle={upPeak === null ? '暂无历史样本' : `峰值 ${formatBandwidth(upPeak)}`}
          dotColor="#a78bfa"
          series={metricSeries.up}
          chartType="bars"
        />
        
        <MetricCard
          title="累计遮挡率"
          value={formatPercentage(telemetry.fractionObstructed)}
          subtitle={getObstructionSeverityLabel(getObstructionSeverity(telemetry.fractionObstructed))}
          dotColor={getDotColorFromSeverity(getObstructionSeverity(telemetry.fractionObstructed))}
          series={metricSeries.obstruction}
          chartType="area"
        />
      </div>

      {/* 实时图表 - 新布局: 延迟(宽) + 吞吐量(宽) | 遮挡(窄) + 路由(窄) */}
      <div className="grid grid-cols-1 lg:grid-cols-10 gap-6">
        {/* 左侧：延迟与丢包走势 - 占 7/10 宽度 */}
        <div className="lg:col-span-7">
          <Card>
            <CardContent className="p-4">
              <LatencyChart height={260} history={history} isLoading={historyLoading} />
            </CardContent>
          </Card>
        </div>
        
        {/* 右侧：遮挡概览 - 占 3/10 宽度 */}
        <div className="lg:col-span-3">
          <ObstructionInsightCard telemetry={telemetry} obstruction={obstruction} />
        </div>
      </div>

      {/* 第二行：吞吐量和路由跟踪 */}
      <div className="grid grid-cols-1 lg:grid-cols-10 gap-6">
        {/* 左侧：吞吐量 - 占 7/10 宽度 */}
        <div className="lg:col-span-7">
          <Card>
            <CardHeader>
              <CardTitle>吞吐量</CardTitle>
            </CardHeader>
            <CardContent>
              <ThroughputChart height={280} history={history} isLoading={historyLoading} />
            </CardContent>
          </Card>
        </div>
        
        {/* 右侧：路由器状态 + 路由跟踪 - 占 3/10 宽度 */}
        <div className="lg:col-span-3 space-y-3">
          {/* 路由器状态行 —— 需求文档 2.1.2 的数据出口, 放在路由跟踪上方 */}
          <RouterStatusRow />
          <RouteTraceCard />
        </div>
      </div>
    </div>
  );
}

// 格式化运行时间
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  
  if (days > 0) {
    return `${days}d ${hours}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else {
    return `${minutes}m`;
  }
}

// 将严重程度转换为颜色
function getDotColorFromSeverity(severity: string): string {
  switch (severity) {
    case 'none':
      return '#4ade80'; // accent-green
    case 'low':
      return '#f59e0b'; // warning-orange
    case 'medium':
      return '#f97316'; // orange
    case 'high':
      return '#ef4444'; // danger-red
    default:
      return '#94a3b8'; // slate
  }
}

// 遮挡概览卡片
interface ObstructionInsightCardProps {
  telemetry: any;
  /** 真实遮挡图(含来源与采集时刻); 没有时降级用 mock */
  obstruction: ObstructionData | null;
}

function ObstructionInsightCard({ telemetry, obstruction }: ObstructionInsightCardProps) {
  // 数据来源决定一切:
  //   real -> 设备实测, 可以给方向/影响/视野遮挡占比
  //   mock -> 本地模拟, 只能画个样子, 且必须明确标出来
  //
  // 关键: 没有数据时**不生成随机 mock 顶替** —— 那样用户会把随机噪声
  // 当成设备实测的视野图。宁可显示"暂无数据"。
  const isReal = obstruction?.source === 'real';
  const obstructionMapData = obstruction?.data ?? null;

  // 统计只在有图时算
  const stats = useMemo(
    () => (obstructionMapData ? analyzeObstructionMap(obstructionMapData) : null),
    [obstructionMapData]
  );

  // 遮挡指标：两个口径，优先级不同
  //   1. obstructionPercentage（从图计算）→ 视野遮挡占比，瞬时精确
  //   2. fractionObstructed（实时遥测）→ 累计遮挡率，设备统计
  // 有图时用图，没图回退到实时值。
  const obstructionRate = stats
    ? stats.obstructionPercentage
    : (telemetry?.fractionObstructed || 0);
  const obstructionPct = stats
    ? (obstructionRate * 100).toFixed(1)
    : null;

  // 根据遮挡比例确定严重程度
  const getSeverityInfo = (rate: number) => {
    if (rate < 0.02) return { label: '无遮挡', color: 'text-accent-green' };
    if (rate < 0.05) return { label: '轻度遮挡', color: 'text-warning-orange' };
    if (rate < 0.10) return { label: '中度遮挡', color: 'text-orange-500' };
    return { label: '严重遮挡', color: 'text-danger-red' };
  };

  const severity = getSeverityInfo(obstructionRate);
  const impact = assessObstructionImpact(obstructionRate);

  // 方向只在真实数据上给 —— mock 图的方向是随机生成的, 展示它就是误导
  const showDirection = isReal && stats?.dominantDirection;
  const ageText = obstruction ? describeObstructionAge(obstruction.timestamp) : null;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-slate-300">
            遮挡概览
          </h3>
        </div>

        {/* 3D 半球形天空遮挡图 —— 没有数据时不画随机图顶替 */}
        {obstructionMapData ? (
          <div className="relative mx-auto mt-1">
            <ObstructionHemisphere
              data={obstructionMapData}
              width={360}
              height={280}
            />
          </div>
        ) : (
          <div className="mx-auto mt-1 flex items-center justify-center rounded border border-dashed border-slate-700 text-xs text-muted-foreground"
               style={{ width: 360, height: 280 }}>
            暂无遮挡图数据
          </div>
        )}

        {obstructionPct !== null ? (
          <div className="mt-2 text-center">
            <span className={`font-mono text-2xl font-bold ${severity.color}`}>{obstructionPct}%</span>
            <span className="text-sm text-slate-400 ml-1">{severity.label}</span>
          </div>
        ) : (
          <div className="mt-2 text-center text-sm text-muted-foreground">—</div>
        )}

        <div className="my-3 border-t border-slate-700/40" />

        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-slate-400">主遮挡方向</span>
            <span className="text-slate-200">
              {showDirection ? (
                <>
                  <Activity className="w-3 h-3 inline mr-1 text-sky-blue" />
                  {stats?.dominantDirection}
                  {stats?.dominantAzimuth != null && (
                    <span className="text-xs text-muted-foreground ml-1 font-mono">
                      {stats.dominantAzimuth.toFixed(0)}°
                    </span>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground text-xs">无实测数据</span>
              )}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-400">影响</span>
            <span className={impact.color}>{impact.label}</span>
          </div>
          {ageText && (
            <div className="flex items-center justify-between">
              <span className="text-slate-400">数据时间</span>
              <span className="text-xs text-muted-foreground">{ageText}</span>
            </div>
          )}
          {obstruction && !isReal && (
            <div className="text-xs text-warning-orange bg-warning-orange/10 border border-warning-orange/30 rounded px-2 py-1">
              当前显示模拟数据（非设备实测）。设备返回遮挡图后会自动切换。
            </div>
          )}
          {!obstruction && (
            <div className="text-xs text-muted-foreground bg-ink-800/50 border border-border/50 rounded px-2 py-1">
              设备尚未返回视野遮挡图。
            </div>
          )}
          <div className="text-xs text-center text-slate-500 mt-2 cursor-pointer hover:text-sky-blue transition-colors">
            点击可查看详细障碍图
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// 路由跟踪卡片
function RouteTraceCard() {
  // 模拟路由跳数据
  const routeHops = [
    { ip: '192.168.100.1', name: '本地网关 · Local gateway', ms: 1.2 },
    { ip: '100.64.0.1', name: 'CGNAT 网关 · CGNAT gateway', ms: 2.1 },
    { ip: '100.64.1.1', name: 'Carrier 级 NAT · Carrier NAT', ms: 2.8 },
    { ip: '172.16.0.1', name: 'Starlink POP - Los Angeles, US', ms: 12.3 },
    { ip: '198.51.100.1', name: 'Starlink 骨干网络 - US', ms: 28.1 },
    { ip: '203.0.113.5', name: 'Telia 骨干 - Frankfurt, DE', ms: 36.4 },
    { ip: '93.184.216.34', name: '目标服务器 - example.com', ms: 36.5 },
  ];

  const getLatencyColor = (ms: number) => {
    if (ms > 30) return '#f59e0b'; // warning
    if (ms > 10) return '#38bdf8'; // sky-blue
    return '#4ade80'; // accent-green
  };

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-300">
            <Activity className="w-4 h-4 inline mr-2 text-accent-green" />
            路由跟踪
          </h3>
        </div>

        <div className="space-y-0">
          {routeHops.map((hop, i) => (
            <div key={i} className="flex items-center gap-3 py-1.5">
              <div className="relative flex flex-col items-center shrink-0" style={{ width: '14px' }}>
                <span className="w-2.5 h-2.5 rounded-full bg-accent-green shadow-[0_0_8px_rgba(74,222,128,0.4)] z-10" />
                {i < routeHops.length - 1 && (
                  <span className="absolute top-2.5 w-px h-full bg-accent-green/40" />
                )}
              </div>
              <div className="w-6 text-[11px] font-mono text-slate-500 shrink-0">{i + 1}</div>
              <div className="w-28 shrink-0">
                <div className="font-mono text-xs text-slate-200 truncate">{hop.ip}</div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-slate-400 truncate">{hop.name}</div>
                <div className="mt-1 h-1 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, (hop.ms / 40) * 100)}%`,
                      background: getLatencyColor(hop.ms)
                    }}
                  />
                </div>
              </div>
              <div
                className={`w-16 text-right font-mono text-xs shrink-0 ${
                  hop.ms > 30 ? 'text-warning-orange' : 'text-slate-300'
                }`}
              >
                {hop.ms} ms
              </div>
            </div>
          ))}
        </div>

        <div className="mt-3 border-t border-slate-700/40 pt-2 text-[11px] text-slate-500 font-mono flex flex-wrap gap-x-4 gap-y-1">
          <span>目标: example.com (93.184.216.34)</span>
          <span>跳数: 7</span>
          <span>平均延迟: 19.2 ms</span>
        </div>
      </CardContent>
    </Card>
  );
}