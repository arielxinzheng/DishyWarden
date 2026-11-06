import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { useHandoffs } from '../../hooks/useHandoffs';
import { useElementWidth } from '../../hooks/useElementWidth';
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
import { AlertDrawerContent } from './AlertDrawerContent';
import { RecentlyResolvedCard } from './RecentlyResolvedCard';
import { TopologyChain } from './TopologyChain';
import { useRecentlyResolved } from './useRecentlyResolved';
import { ObstructionHemisphere } from './ObstructionHemisphere';
import { MetricCard, CHART_HEIGHT } from './MetricCard';
import { StatusStrip, SLICE_PLANS, fitStatusSlots, STATUS_GAP } from './StatusStrip';
import { assessStaleness } from './dataGaps';
import { RouterStatusRow } from './RouterStatusRow';
import { buildMetricSeries, peakOf } from './metricSeries';
import { Drawer } from '../ui/drawer';
// 场景 A: 首次安装采集失败 → 全屏 Setup 引导页(拦截渲染, 见 firstInstall.ts 的判定)
import { isFirstInstallFailure, type ZeroDataStorageStats } from './firstInstall';
import SetupGuide from './SetupGuide';

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

/** 断流时长的人话表述 —— 「31 分钟」比「1860000 ms」有用得多 */
const formatSilentMs = (ms: number): string => {
  const sec = Math.round(ms / 1000);
  if (sec < 90) return `${sec} 秒`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min} 分钟`;
  return `${(min / 60).toFixed(1)} 小时`;
};

export default function Dashboard() {
  const navigate = useNavigate();
  const { telemetry, isConnected, isLoading, error, refresh, obstruction } = useDish();
  // 24h 统计摘要：来自 SQLite 历史库，替代此前的硬编码值
  const summary24h = useHistorySummary(86400);
  const [timeRange, setTimeRange] = useState<TimeRange>('1h');
  // 图表数据在这里取一次, 两个图表共用 —— 避免各自发起 IPC 查询
  const { history, isLoading: historyLoading } = useDishHistory(TIME_RANGE_SECONDS[timeRange]);
  // 卫星切换事件(★ 标记点) —— 来自 dishGetHistory 的 outages, 与 history 同一个时间窗
  const handoffs = useHandoffs(TIME_RANGE_SECONDS[timeRange]);
  // 六张指标卡的走势序列：和图表共用同一份 history, 各取一条指标
  const metricSeries = useMemo(() => buildMetricSeries(history), [history]);

  // 全局图表时间窗 —— 延迟折线、状态色块条、数据陈旧判定**共用同一个**。
  //
  // ⚠️ 为什么必须共用:
  //   ① 色块与折线要视觉对齐 —— 看到灰块, 往右看折线就应有断口
  //   ② "断流"判据基于时间, 两个组件各取一次 `Date.now()` 会差出几百毫秒,
  //      断流的灰带与灰块就会错位
  //   ③ 陈旧横幅说的分钟数, 与图上尾部灰带的宽度必须一致
  const chartWindow = useMemo(() => {
    const seconds = TIME_RANGE_SECONDS[timeRange];
    const to = Date.now();
    const from = to - seconds * 1000;
    const plan = SLICE_PLANS[timeRange];
    return {
      from,
      to,
      leftLabel: plan?.label ?? `${timeRange} ago`,
      maxSlots: plan?.slots ?? 30,
    };
  }, [timeRange, history]);

  /**
   * 数据陈旧状态 —— 采集器挂了多久。
   *
   * 这是仪表盘上**最容易被忽略又最危险**的信号: 采集器中断时,
   * 顶部那些大数字(延迟/丢包/速度)全都来自最后一次成功采集,
   * 看起来完全正常。不显式提示就是误导。
   */
  const staleness = useMemo(
    () => assessStaleness(history, chartWindow.to),
    [history, chartWindow.to],
  );

  // 状态色块条的可用宽度 —— 测**图表区基准层**, 不测条带自己。
  //
  // ⚠️ 为什么不能测条带自己: 条带宽度 = 块数 × (flex-1 分到的宽) + gap,
  //    而块数又由宽度决定 ⇒ **循环依赖**。ResizeObserver 观察条带时,
  //    块数一变条带宽度就变, 触发新一轮观察, 永远收敛不了。
  //    基准层的宽度与块数无关, 是稳定的测量基准。
  const [statusCardRef, statusStripWidth] = useElementWidth<HTMLDivElement>();

  // 屏幕变窄时**减少块数**(粒度变粗), 绝不压缩 Gap ——
  // Gap 一旦被压到 0, 分片感就消失, 那就退化成纯色条, 失去意义。
  const statusSlots = useMemo(() => {
    // 宽度还没测出来(首帧/极端窄屏)时用方案值。
    // ⚠️ 但宽度为 0 时 flex-1 的块会被压成 0 宽 —— 视觉上条带消失。
    //    所以宽度太小就退到最小块数, 保证每块至少有 1px 可见。
    if (statusStripWidth <= 0) return chartWindow.maxSlots;
    // 基准层含 p-4 的左右内边距(各 16px) ⇒ 减去 32 才是真正可画的宽
    const available = statusStripWidth - 32;
    if (available <= 0) return 1;
    return fitStatusSlots(available, STATUS_GAP, chartWindow.maxSlots, 6);
  }, [statusStripWidth, chartWindow.maxSlots]);

  const [refreshInterval, setRefreshInterval] = useState<RefreshInterval>('30s');
  const [showRefreshMenu, setShowRefreshMenu] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeAlerts, setActiveAlerts] = useState<any[]>([]);
  const [alertDrawerOpen, setAlertDrawerOpen] = useState(false);
  // 【刚刚恢复】数据源/定时器/已读偏好全封在 hook 里, 首页只消费结果
  const recentlyResolved = useRecentlyResolved();

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

      // 降噪操作改变的是主进程权威状态，本地数组无法推算，必须重拉
      const unsubscribeChanged = window.electronAPI.onAlertsChanged(() => {
        loadAlerts();
      });

      return () => {
        unsubscribeNew();
        unsubscribeResolved();
        unsubscribeChanged();
      };
    }
  }, []);

  // 过滤出未被忽略的告警 (用于横幅展示)
  // 注: 误报告警 status='false_positive'，getActiveAlerts() 已不返回，无需在此过滤
  const visibleAlerts = useMemo(() => {
    return activeAlerts.filter(alert => {
      // 本次忽略的不显示
      if (alert.snooze_type === 'until_resolved') return false;
      
      // 限时忽略且未过期的不显示
      if (alert.snooze_until) {
        const snoozeUntil = new Date(alert.snooze_until).getTime();
        if (Date.now() < snoozeUntil) return false;
      }
      
      return true;
    });
  }, [activeAlerts]);

  // ── 场景 A: 首次安装采集失败 ─────────────────────────────────────────
  // 历史库统计(判定 Day 0 需要 sampleCount) + 设备地址(引导页展示当前目标)
  const [storageStats, setStorageStats] = useState<ZeroDataStorageStats | null>(null);
  const [dishEndpoint, setDishEndpoint] = useState('192.168.100.1:9200');

  useEffect(() => {
    if (!window.electronAPI) return;
    let cancelled = false;
    (async () => {
      try {
        const [stats, cfg] = await Promise.all([
          window.electronAPI.getStorageStats(),
          window.electronAPI.getConfig(),
        ]);
        if (cancelled) return;
        if (stats) setStorageStats(stats);
        const addr = `${cfg.collector.dishAddress}:${cfg.collector.dishPort}`;
        setDishEndpoint(addr);
      } catch (err) {
        // 拿不到统计 ⇒ isFirstInstallFailure 返回 false, 走原有降级 UI
        console.warn('[Dashboard] 读取库统计/设备地址失败:', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 判定要拿到 storageStats 之后才有结论; 拿不到(仍为 null)按非首次安装降级
  const isFirstInstall = isFirstInstallFailure(
    !!error && !telemetry,
    storageStats
  );

  // 引导页期间的「正在重试」状态: useDish.isLoading 恰好表达这个
  const setupIsRetrying = isLoading;

  // 判断是否有严重告警 (基于可见告警)
  const hasCriticalAlerts = useMemo(() => {
    return visibleAlerts.some((alert) => alert.severity === 'critical');
  }, [visibleAlerts]);

  const hasAlerts = visibleAlerts.length > 0;

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

  // ── 场景 A 拦截渲染 ────────────────────────────────────────────────
  // 首次安装 + gRPC 连接失败 ⇒ 全屏 Setup 引导页, 绝不渲染
  // 全 0 的「残疾仪表盘」。必须放在 loading 分支**之后**: 首次尝试
  // 连接期间(isLoading && !telemetry)先走原有的「正在连接」转圈,
  // 失败落定后才进引导页 —— 否则页面会在加载瞬间闪引导页。
  //
  // 本分支 return 的位置在横幅渲染之前, 因此活跃告警横幅/陈旧横幅/
  // 刚恢复卡片在这里都不会出现 —— 系统还没跑起来, 没有告警概念。
  if (isFirstInstall) {
    const handleSetupRetry = async () => {
      // 先刷新本地状态(清 error 进入「正在重试」视觉), 再触发主进程立即采集
      await refresh();
      if (window.electronAPI?.retryDishConnection) {
        await window.electronAPI.retryDishConnection();
      }
      // 真实结果走 telemetry-update 事件: 成功 ⇒ telemetry 到达, 引导页自动消失;
      // 失败 ⇒ error 维持, 引导页仍在。这里不需要轮询。
    };
    return (
      <SetupGuide
        error={error}
        isRetrying={setupIsRetrying}
        connectTarget={dishEndpoint}
        onRetry={handleSetupRetry}
        onOpenSettings={() => navigate('/settings')}
      />
    );
  }

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

      {/* 活跃告警 - 聚合横幅 */}
      {hasAlerts && (
        <div 
          className={`
            rounded-lg border p-4 cursor-pointer transition-all duration-200
            ${hasCriticalAlerts 
              ? 'border-danger-red/50 bg-danger-red/10 hover:bg-danger-red/15 hover:border-danger-red' 
              : 'border-warning-orange/50 bg-warning-orange/5 hover:bg-warning-orange/10 hover:border-warning-orange'
            }
          `}
          onClick={() => setAlertDrawerOpen(true)}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <AlertCircle className={`w-5 h-5 ${hasCriticalAlerts ? 'text-danger-red' : 'text-warning-orange'}`} />
              <span className={`font-medium ${hasCriticalAlerts ? 'text-danger-red' : 'text-warning-orange'}`}>
                {hasCriticalAlerts ? '⚠️ 检测到严重告警' : '⚠️ 检测到网络环境异常'}
              </span>
              <Badge variant={hasCriticalAlerts ? 'destructive' : 'secondary'}>
                {visibleAlerts.length} 个
              </Badge>
            </div>
            <button 
              className={`
                px-4 py-1.5 rounded-md text-sm font-medium transition-colors
                ${hasCriticalAlerts 
                  ? 'bg-danger-red/20 text-danger-red hover:bg-danger-red/30' 
                  : 'bg-warning-orange/20 text-warning-orange hover:bg-warning-orange/30'
                }
              `}
            >
              查看详情
            </button>
          </div>
        </div>
      )}

      {/* 告警抽屉 */}
      <Drawer
        open={alertDrawerOpen}
        onClose={() => setAlertDrawerOpen(false)}
        title="活跃告警"
        width="md"
      >
        <AlertDrawerContent 
          alerts={activeAlerts}
          onAlertsChange={async () => {
            // 重新加载告警列表
            if (window.electronAPI) {
              const alerts = await window.electronAPI.getActiveAlerts();
              setActiveAlerts(alerts || []);
            }
          }}
        />
      </Drawer>

      {/* 刚刚恢复 - 短时留存。必须排在活跃告警横幅之后: 有活跃故障时,
          「已恢复」只是背景信息，不能抢在真正的告警上面。 */}
      <RecentlyResolvedCard
        alerts={recentlyResolved.alerts}
        now={recentlyResolved.now}
        onDismiss={recentlyResolved.dismiss}
        onOpenHistory={() => navigate('/alerts')}
      />

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

      {/* 数据陈旧横幅 —— 只在「尾部断流」超过阈值时出现。
          位置刻意选在总览带**之后、指标卡之前**:
          上面那句绿色「正常」、下面那些大数字, 全都来自最后一次成功采集,
          不先讲清"数据是旧的", 越是健康的数字越误导。 */}
      {staleness.isStale && (
        <div className="flex items-start gap-3 rounded-xl border border-warning-orange/40 bg-warning-orange/10 px-4 py-3">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning-orange" />
          <div className="text-sm leading-5">
            <span className="font-semibold text-warning-orange">
              数据已 {formatSilentMs(staleness.silentMs)} 未更新
            </span>
            <span className="text-muted-foreground">
              {' '}· 下方数值为最后一次成功采集的结果; 图表上的断口与状态条上的灰块即采集中断区间
            </span>
          </div>
        </div>
      )}

      {/* 全链路拓扑状态链 —— 位置在总览带/断流横幅之后、折线图卡之前。
          断流横幅排它上面是刻意的: 数据陈旧时「拓扑全绿」是最误导人的画面,
          先解释清楚"数据是旧的"再说链路状态。 */}
      <TopologyChain
        alerts={activeAlerts}
        onOpenAlerts={() => setAlertDrawerOpen(true)}
      />

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
          legendLeft={chartWindow.leftLabel}
          legendRight="Now"
          chartAreaRef={statusCardRef}
        >
          {/* 状态色块条 —— 取代折线。
              与下方「延迟」折线共用同一份 history 和同一个时间窗,
              所以 X 轴天然对齐: 看到红块, 往右看延迟折线就有对应尖刺;
              看到**灰块**, 折线在那里必然是**断开的**。 */}
          <StatusStrip
            history={history}
            fromMs={chartWindow.from}
            toMs={chartWindow.to}
            slots={statusSlots}
            height={CHART_HEIGHT}
          />
        </MetricCard>
        
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
              <LatencyChart
                height={260}
                history={history}
                isLoading={historyLoading}
                fromMs={chartWindow.from}
                toMs={chartWindow.to}
                handoffs={handoffs}
                timeRange={timeRange}
              />
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
              <ThroughputChart
                height={280}
                history={history}
                fromMs={chartWindow.from}
                toMs={chartWindow.to}
                isLoading={historyLoading}
              />
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
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{
    target: string;
    hops: Array<{ hop: number; ip: string | null; hostname: string; rtt: number | null }>;
    completed: boolean;
    duration: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 追踪目标来自设置页的「探针节点管理」(默认 example.com)。
  // 这里只读不改 —— 要改去设置页, 避免同一个配置有两个入口。
  const [target, setTarget] = useState<string>('');

  // 组件挂载时执行一次 traceroute
  useEffect(() => {
    loadTarget();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadTarget = async () => {
    let t = '';
    try {
      if (window.electronAPI?.getConfig) {
        const cfg = await window.electronAPI.getConfig();
        t = cfg.probe?.traceTarget ?? '';
      }
    } catch {
      // 配置读不到就用默认, 不阻塞卡片
    }
    const finalTarget = t || 'example.com';
    setTarget(finalTarget);
    runTrace(finalTarget);
  };

  const runTrace = async (targetOverride?: string) => {
    if (!window.electronAPI?.runTraceroute) {
      setError('Traceroute 仅在 Electron 环境可用');
      return;
    }

    const t = (targetOverride ?? target).trim() || 'example.com';
    setLoading(true);
    setError(null);

    try {
      const result = await window.electronAPI.runTraceroute(t);
      // 防御: IPC 返回的结构不可信(旧版本/异常路径), 缺 hops 会让
      // 下面的 data.hops.length 抛错 ⇒ 整个仪表盘被 ErrorBoundary 清空。
      if (!result || !Array.isArray(result.hops)) {
        setData(null);
        setError('路由跟踪返回了无法解析的结果');
        return;
      }
      setData(result);
    } catch (err: any) {
      setError(err.message || '执行失败');
    } finally {
      setLoading(false);
    }
  };

  const getLatencyColor = (ms: number | null) => {
    if (ms === null) return '#64748b'; // slate-500 (超时)
    if (ms > 30) return '#f59e0b'; // warning
    if (ms > 10) return '#38bdf8'; // sky-blue
    return '#4ade80'; // accent-green
  };

  const avgLatency = data?.hops && data.hops.length > 0
    ? data.hops
        .filter(h => h.rtt !== null)
        .reduce((sum, h) => sum + (h.rtt || 0), 0) / 
        (data.hops.filter(h => h.rtt !== null).length || 1)
    : 0;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3 gap-2">
          <h3 className="text-sm font-semibold text-slate-300 shrink-0">
            <Activity className="w-4 h-4 inline mr-2 text-accent-green" />
            路由跟踪
          </h3>
          <div className="flex items-center gap-2 flex-1 justify-end">
            {/* 目标只读显示 —— 编辑入口统一在设置页的「探针节点管理」,
                避免同一个配置有两个地方能改。 */}
            <span
              className="font-mono text-[11px] text-slate-400 truncate"
              title="路由跟踪目标(在设置页修改)"
            >
              {target || '—'}
            </span>
            <button
              onClick={() => runTrace()}
              disabled={loading}
              className="text-xs text-accent-green hover:text-accent-green/80 disabled:opacity-50 shrink-0"
            >
              {loading ? '执行中...' : '刷新'}
            </button>
          </div>
        </div>

        {error && (
          <div className="text-xs text-warning-orange mb-2">
            {error}
          </div>
        )}

        {loading && !data && (
          <div className="text-xs text-slate-400 py-8 text-center">
            正在追踪路由...
          </div>
        )}

        {data && data.hops.length > 0 && (
          <>
            <div className="space-y-0">
              {data.hops.map((hop, i) => (
                <div key={i} className="flex items-center gap-3 py-1.5">
                  <div className="relative flex flex-col items-center shrink-0" style={{ width: '14px' }}>
                    <span className="w-2.5 h-2.5 rounded-full bg-accent-green shadow-[0_0_8px_rgba(74,222,128,0.4)] z-10" />
                    {i < data.hops.length - 1 && (
                      <span className="absolute top-2.5 w-px h-full bg-accent-green/40" />
                    )}
                  </div>
                  <div className="w-6 text-[11px] font-mono text-slate-500 shrink-0">{hop.hop}</div>
                  <div className="w-28 shrink-0">
                    <div className="font-mono text-xs text-slate-200 truncate">
                      {hop.ip || '*'}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-slate-400 truncate">{hop.hostname}</div>
                    {hop.rtt !== null && (
                      <div className="mt-1 h-1 rounded-full bg-slate-800 overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, (hop.rtt / 40) * 100)}%`,
                            background: getLatencyColor(hop.rtt)
                          }}
                        />
                      </div>
                    )}
                  </div>
                  <div
                    className={`w-16 text-right font-mono text-xs shrink-0 ${
                      hop.rtt === null ? 'text-slate-500' : hop.rtt > 30 ? 'text-warning-orange' : 'text-slate-300'
                    }`}
                  >
                    {hop.rtt !== null ? `${hop.rtt.toFixed(1)} ms` : '* * *'}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-3 border-t border-slate-700/40 pt-2 text-[11px] text-slate-500 font-mono flex flex-wrap gap-x-4 gap-y-1">
              <span>目标: {data.target}</span>
              <span>跳数: {data.hops.length}</span>
              <span>平均延迟: {avgLatency.toFixed(1)} ms</span>
              <span className={data.completed ? 'text-accent-green' : 'text-warning-orange'}>
                {data.completed ? '已到达' : '未到达'}
              </span>
            </div>
          </>
        )}

        {data && data.hops.length === 0 && (
          <div className="text-xs text-slate-400 py-8 text-center">
            无法获取路由信息
          </div>
        )}
      </CardContent>
    </Card>
  );
}