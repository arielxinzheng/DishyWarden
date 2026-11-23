import { useRef, useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
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
  ExternalLink,
  ChevronDown,
} from 'lucide-react';
import { useDish, useDishHistory, useHistorySummary, type ObstructionData } from '../../hooks/useDish';
import { useHandoffs } from '../../hooks/useHandoffs';
import { useElementWidth } from '../../hooks/useElementWidth';
import {
  TIME_RANGE_OPTIONS,
  TIME_RANGE_SECONDS,
  usePersistentTimeRange,
} from '../../hooks/usePersistentTimeRange';
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
  getObstructionSeverity,
} from '../../../core/telemetry';
import { LatencyChart } from './LatencyChart';
import { ThroughputChart } from './ThroughputChart';
import { AlertDrawerContent } from './AlertDrawerContent';
import { RecentlyResolvedCard } from './RecentlyResolvedCard';
import { TopologyChain } from './TopologyChain';
import { RouteTraceEmpty } from './RouteTraceEmpty';
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
import { LanguageSwitcher } from '../../components/LanguageSwitcher';

type RefreshInterval = '30s' | '1m' | 'manual';

// 字节 → GB 数值（保留 2 位），单位由 UI 单独渲染
const toGb = (bytes: number) => (bytes / 1024 ** 3).toFixed(2);

/**
 * 断流时长 → 语义码 + 插值参数。
 *
 * 逻辑层只给数值, 句子由字典模板拼（`数据已 {{count}} 分钟未更新`）——
 * 中文的「分钟」/ 英文的 "min" 才能各归各的语言。
 */
const staleBannerOf = (
  ms: number,
): { key: string; params: Record<string, number> } => {
  const sec = Math.round(ms / 1000);
  if (sec < 90) {
    return { key: 'dashboard:stale.banner_seconds', params: { count: sec } };
  }
  const min = Math.round(sec / 60);
  if (min < 90) {
    return { key: 'dashboard:stale.banner_minutes', params: { count: min } };
  }
  return { key: 'dashboard:stale.banner_hours', params: { hours: Number((min / 60).toFixed(1)) } };
};

/** 信号质量语义码 → 字典键 */
const SIGNAL_QUALITY_KEY: Record<string, string> = {
  excellent: 'dashboard:metric.quality_excellent',
  good: 'dashboard:metric.quality_good',
  fair: 'dashboard:metric.quality_fair',
  poor: 'dashboard:metric.quality_poor',
  no_signal: 'dashboard:metric.quality_none',
};

/** 累计遮挡严重度语义码 → 字典键 */
const OBSTRUCTION_SEVERITY_KEY: Record<string, string> = {
  none: 'dashboard:obstruction.level_none',
  minor: 'dashboard:obstruction.level_light',
  moderate: 'dashboard:obstruction.level_moderate',
  severe: 'dashboard:obstruction.level_severe',
};

export default function Dashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { telemetry, isConnected, isLoading, error, refresh, obstruction } = useDish();
  // 24h 统计摘要：来自 SQLite 历史库，替代此前的硬编码值
  const summary24h = useHistorySummary(86400);
  // 周期选择是**用户偏好**：切页往返、重启应用后都要保持不变（#12）。
  // 读写与非法值回落收在 usePersistentTimeRange 里，组件只消费。
  const [timeRange, setTimeRange] = usePersistentTimeRange();
  // 路由跟踪卡片的折叠/展开 —— 提升到外层：折叠时右列整体要与
  // 左侧「吞吐量」卡片等高，这个约束在下面的 grid 容器上。
  const [traceExpanded, setTraceExpanded] = useState(false);
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
        console.warn('[Dashboard] failed to read storage stats / dish address:', err);
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
          <p className="text-muted-foreground">{t('dashboard:app.connecting')}</p>
          <p className="text-xs text-muted-foreground mt-2">
            {t('dashboard:app.ensure_network')}
          </p>
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
                <p className="font-semibold mb-1">{t('dashboard:app.connect_failed')}</p>
                <p className="text-sm">{error}</p>
              </div>
              <div className="text-sm space-y-1">
                <p className="font-semibold">{t('dashboard:app.check_list')}</p>
                <ul className="list-disc ml-4 space-y-1">
                  <li>{t('dashboard:app.check_power')}</li>
                  <li>{t('dashboard:app.check_network')}</li>
                  <li>{t('dashboard:app.check_firewall')}</li>
                  <li>{t('dashboard:app.check_address')}</li>
                </ul>
              </div>
              <button
                onClick={() => refresh()}
                disabled={isLoading}
                className="px-4 py-2 bg-accent-green/20 hover:bg-accent-green/30 text-accent-green rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? t('dashboard:app.retrying') : t('dashboard:app.retry')}
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

  // 断流时长 → 语义码，句子由字典模板拼（不在这里写「分钟」/「秒」）
  const staleBanner = staleBannerOf(staleness.silentMs);

  return (
    <div className="p-8 space-y-8">
      {/* Header with controls */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold">{t('dashboard:app.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('dashboard:app.subtitle')}</p>
        </div>
        
        {/* Right controls area */}
        <div className="flex items-center gap-2">
          {/* Connection status badge */}
          <Badge 
            variant="outline" 
            className={isConnected ? 'text-accent-green border-accent-green px-4 py-2' : 'text-muted-foreground px-4 py-2'}
          >
            <span className={`w-2 h-2 rounded-full mr-2 ${isConnected ? 'bg-accent-green animate-pulse' : 'bg-muted-foreground'}`}></span>
            {isConnected ? t('dashboard:status.live') : t('dashboard:status.disconnected')}
          </Badge>

          {/* Time range selector */}
          <div className="hidden sm:flex items-center gap-1 bg-muted/40 border border-border rounded-md p-1">
            {TIME_RANGE_OPTIONS.map((range) => (
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
                {refreshInterval === 'manual' ? t('dashboard:app.manual') : refreshInterval}
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
                    <span>{interval === 'manual' ? t('dashboard:app.manual') : interval}</span>
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
            title={t('dashboard:app.refresh_now')}
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-accent-green' : 'text-muted-foreground'}`} />
          </button>

          {/* Official site link */}
          <a
            href="https://www.starlink.com"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden lg:flex items-center gap-2 px-3 py-2 rounded-md border border-sky-blue/40 bg-sky-blue/10 text-sky-blue hover:bg-sky-blue/20 transition-colors text-sm"
            title={t('dashboard:app.official_site_hint')}
          >
            {/* 🌐 是语言切换器的图标，这里用"外链"语义 —— 点它会离开仪表盘、在新标签页打开官网 */}
            <ExternalLink className="w-4 h-4" />
            <span className="font-medium">{t('dashboard:app.official_site')}</span>
          </a>

          {/* 全局语言切换（需求指定的「右上角」位置） */}
          <LanguageSwitcher variant="icon" />
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
                {hasCriticalAlerts
                  ? t('dashboard:alert_drawer.critical_banner')
                  : t('dashboard:alert_drawer.warning_banner')}
              </span>
              <Badge variant={hasCriticalAlerts ? 'destructive' : 'secondary'}>
                {t('dashboard:alert_drawer.count', { count: visibleAlerts.length })}
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
              {t('dashboard:alert_drawer.open_detail')}
            </button>
          </div>
        </div>
      )}

      {/* 告警抽屉 */}
      <Drawer
        open={alertDrawerOpen}
        onClose={() => setAlertDrawerOpen(false)}
        title={t('dashboard:alert_drawer.title')}
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

      {/* ===== 总体状态组：5 块总览带 + 断流横幅 + 全链路拓扑 =====
          三者合成一个视觉单元（拓扑读作大盘的注脚），组内间距显式控制：
          带→横幅 32px（横幅是告警，要独立成行），带/横幅→拓扑 12px（贴近）。
          组与下方指标矩阵之间保留 32px+ 的呼吸。 */}
      <div>
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
                  {t('dashboard:overview.status')}
                </div>
                <div className={`mt-2 flex items-center gap-2 text-xl font-bold ${isConnected ? 'text-accent-green' : 'text-danger-red'}`}>
                  <span className={`w-2.5 h-2.5 rounded-full ${isConnected ? 'bg-accent-green animate-pulse' : 'bg-danger-red animate-pulse'}`}></span>
                  <span>{isConnected ? t('dashboard:overview.ok') : t('dashboard:overview.offline')}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {t('dashboard:overview.availability_24h')}{' '}
                  <span className={`font-mono ${availabilityColor}`}>{availabilityText}</span>
                </div>
              </div>

              {/* 2. Today's data usage */}
              <div className="p-5">
                <div className="flex items-center gap-2 text-sm uppercase tracking-[0.12em] font-semibold text-slate-200">
                  {t('dashboard:overview.usage_24h')}
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
                  {t('dashboard:overview.outages')}
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
                    <span>{t('dashboard:overview.no_outage')}</span>
                  ) : (
                    <>
                      <span>{outageCount}</span>
                      <span className="text-sm text-muted-foreground ml-1">
                        {t('dashboard:overview.outage_unit')}
                      </span>
                    </>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {outageCount === null
                    ? t('dashboard:overview.no_samples')
                    : t('dashboard:overview.history_24h')}
                </div>
              </div>

              {/* 4. Alignment status — 取自 alignmentStats，无数据时显示占位 */}
              <div className="p-5">
                <div className="flex items-center gap-2 text-sm uppercase tracking-[0.12em] font-semibold text-slate-200">
                  {t('dashboard:overview.alignment')}
                </div>
                <div className={`mt-2 text-2xl font-extrabold font-mono ${isAligned ? 'text-accent-green' : 'text-warning-orange'}`}>
                  {isAligned ? t('dashboard:overview.aligned') : t('dashboard:overview.aligning')}
                </div>
                <div className="text-xs text-muted-foreground mt-1 font-mono">
                  {t('dashboard:overview.uncertainty', { value: alignmentUncertaintyText })}
                  {' · '}
                  {t('dashboard:overview.first_fix', {
                    value:
                      telemetry.secondsToFirstNonemptySlot > 0
                        ? `${telemetry.secondsToFirstNonemptySlot}s`
                        : '—',
                  })}
                </div>
              </div>

              {/* 5. Uptime */}
              <div className="p-5 col-span-2 md:col-span-3 lg:col-span-1">
                <div className="flex items-center gap-2 text-sm uppercase tracking-[0.12em] font-semibold text-slate-200">
                  {t('dashboard:overview.uptime')}
                </div>
                <div className="mt-2 text-2xl font-extrabold text-slate-100 font-mono">
                  {telemetry.uptime > 0 ? formatUptime(telemetry.uptime) : '—'}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {t('dashboard:overview.firmware', { version: telemetry.softwareVersion || '—' })}
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
          <div className="mt-8 flex items-start gap-3 rounded-xl border border-warning-orange/40 bg-warning-orange/10 px-4 py-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning-orange" />
            <div className="text-sm leading-5">
              <span className="font-semibold text-warning-orange">
                {t(staleBanner.key, staleBanner.params)}
              </span>
              <span className="text-muted-foreground"> {t('dashboard:stale.banner_detail')}</span>
            </div>
          </div>
        )}

        {/* 全链路拓扑状态链 —— 位置在总览带/断流横幅之后、折线图卡之前。
            断流横幅排它上面是刻意的: 数据陈旧时「拓扑全绿」是最误导人的画面,
            先解释清楚"数据是旧的"再说链路状态。

            间距刻意不对称: 距上方大盘 mt-3（读作"总体状态的延伸/注脚"），
            距下方指标卡矩阵留足 32px+（那是另一组信息，需要呼吸感）。 */}
        <div className="mt-3">
          <TopologyChain
            alerts={activeAlerts}
            onOpenAlerts={() => setAlertDrawerOpen(true)}
          />
        </div>
      </div>

      {/* 6 metric cards row with mini charts —— pt-3 让拓扑与矩阵之间的呼吸更足 */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4 pt-3">
        <MetricCard
          title={t('dashboard:metric.connection')}
          value={
            telemetry.state === 'ONLINE' ? t('dashboard:metric.online') : telemetry.state || '—'
          }
          subtitle={t('dashboard:metric.signal', {
            quality: t(
              SIGNAL_QUALITY_KEY[getSignalQuality(telemetry.snr)] ?? 'dashboard:metric.quality_none',
            ),
          })}
          dotColor={telemetry.state === 'ONLINE' ? '#4ade80' : '#94a3b8'}
          series={metricSeries.availability}
          chartType="line"
          domain={[0, 1]}
          legendLeft={t(`dashboard:metric.range_${timeRange}`)}
          legendRight={t('dashboard:metric.now')}
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
          title={t('dashboard:metric.latency')}
          value={formatLatency(telemetry.popPingLatencyMs)}
          subtitle={
            latencyPeak === null
              ? t('dashboard:metric.no_history')
              : t('dashboard:metric.peak', { value: formatLatency(latencyPeak) })
          }
          dotColor="#4ade80"
          series={metricSeries.latency}
          chartType="area"
        />
        
        <MetricCard
          title={t('dashboard:metric.packet_loss')}
          value={formatPercentage(telemetry.popPingDropRate)}
          subtitle={
            dropPeak === null
              ? t('dashboard:metric.no_history')
              : t('dashboard:metric.peak', { value: formatPercentage(dropPeak) })
          }
          dotColor={telemetry.popPingDropRate > 0.05 ? '#ef4444' : '#4ade80'}
          series={metricSeries.drop}
          chartType="line"
        />
        
        <MetricCard
          title={t('dashboard:metric.downlink')}
          value={formatBandwidth(telemetry.downlinkThroughputBps)}
          subtitle={
            downPeak === null
              ? t('dashboard:metric.no_history')
              : t('dashboard:metric.peak', { value: formatBandwidth(downPeak) })
          }
          dotColor="#38bdf8"
          series={metricSeries.down}
          chartType="bars"
        />
        
        <MetricCard
          title={t('dashboard:metric.uplink')}
          value={formatBandwidth(telemetry.uplinkThroughputBps)}
          subtitle={
            upPeak === null
              ? t('dashboard:metric.no_history')
              : t('dashboard:metric.peak', { value: formatBandwidth(upPeak) })
          }
          dotColor="#a78bfa"
          series={metricSeries.up}
          chartType="bars"
        />
        
        <MetricCard
          title={t('dashboard:metric.obstruction')}
          value={formatPercentage(telemetry.fractionObstructed)}
          subtitle={t(
            OBSTRUCTION_SEVERITY_KEY[getObstructionSeverity(telemetry.fractionObstructed)] ??
              'dashboard:obstruction.level_none',
          )}
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
      {/*
        右列高度收敛到与左「吞吐量」卡片一致（lg:items-stretch + 右列 lg:h-[378px]）。
        378 = ThroughputChart 的 height(280) + 卡片标题栏与内边距(98)，实测值；
        ⚠️ 改 ThroughputChart 的 height 时要同步这里，否则两卡底边会错开。
      */}
      <div className="grid grid-cols-1 lg:grid-cols-10 gap-6 lg:items-stretch">
        {/* 左侧：吞吐量 - 占 7/10 宽度 */}
        <div className="lg:col-span-7">
          <Card>
            <CardHeader>
              <CardTitle>{t('dashboard:chart.throughput_title')}</CardTitle>
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
        {/* 折叠态固定 378px（= 左卡），路由跟踪卡片吃掉剩余高度并在内部滚动；
            展开态去掉高度上限，让它自然撑开、由页面滚动。 */}
        <div
          className={`lg:col-span-3 flex flex-col gap-3 min-h-0 ${
            traceExpanded ? '' : 'lg:h-[378px]'
          }`}
        >
          {/* 路由器状态行 —— 需求文档 2.1.2 的数据出口, 放在路由跟踪上方 */}
          <div className="shrink-0">
            <RouterStatusRow />
          </div>
          <RouteTraceCard
            expanded={traceExpanded}
            onToggle={() => setTraceExpanded((v) => !v)}
          />
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
  const { t } = useTranslation();
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

  // 根据遮挡比例确定严重程度（阈值不变，文案走字典）
  const getSeverityInfo = (rate: number) => {
    if (rate < 0.02) {
      return { label: t('dashboard:obstruction.level_none'), color: 'text-accent-green' };
    }
    if (rate < 0.05) {
      return { label: t('dashboard:obstruction.level_light'), color: 'text-warning-orange' };
    }
    if (rate < 0.10) {
      return { label: t('dashboard:obstruction.level_moderate'), color: 'text-orange-500' };
    }
    return { label: t('dashboard:obstruction.level_severe'), color: 'text-danger-red' };
  };

  const severity = getSeverityInfo(obstructionRate);
  const impact = assessObstructionImpact(obstructionRate);
  const impactLabel = t(impact.labelKey);

  // 方向只在真实数据上给 —— mock 图的方向是随机生成的, 展示它就是误导。
  // 方位码（N/NE/…）来自 lib 的语义层, 文案在 dashboard 字典里。
  const directionLabel =
    isReal && stats?.dominantDirection
      ? t(`dashboard:direction.${stats.dominantDirection.toLowerCase()}`)
      : null;

  // 采集时刻 → 语义码 + 可选 count（labelKey 在 obstruction 命名空间）
  const age = obstruction ? describeObstructionAge(obstruction.timestamp) : null;
  const ageText = age
    ? t(age.labelKey, age.count !== undefined ? { count: age.count } : undefined)
    : null;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-slate-300">
            {t('dashboard:obstruction.card_title')}
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
            {t('dashboard:obstruction.no_map')}
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
            <span className="text-slate-400">{t('dashboard:obstruction.direction')}</span>
            <span className="text-slate-200">
              {directionLabel ? (
                <>
                  <Activity className="w-3 h-3 inline mr-1 text-sky-blue" />
                  {directionLabel}
                  {stats?.dominantAzimuth != null && (
                    <span className="text-xs text-muted-foreground ml-1 font-mono">
                      {stats.dominantAzimuth.toFixed(0)}°
                    </span>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground text-xs">
                  {t('dashboard:obstruction.no_measured')}
                </span>
              )}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-400">{t('dashboard:obstruction.impact')}</span>
            <span className={impact.color}>{impactLabel}</span>
          </div>
          {ageText && (
            <div className="flex items-center justify-between">
              <span className="text-slate-400">{t('dashboard:obstruction.data_time')}</span>
              <span className="text-xs text-muted-foreground">{ageText}</span>
            </div>
          )}
          {obstruction && !isReal && (
            <div className="text-xs text-warning-orange bg-warning-orange/10 border border-warning-orange/30 rounded px-2 py-1">
              {t('dashboard:obstruction.mock_banner')}
            </div>
          )}
          {!obstruction && (
            <div className="text-xs text-muted-foreground bg-ink-800/50 border border-border/50 rounded px-2 py-1">
              {t('dashboard:obstruction.no_map_banner')}
            </div>
          )}
          <div className="text-xs text-center text-slate-500 mt-2 cursor-pointer hover:text-sky-blue transition-colors">
            {t('dashboard:obstruction.view_detail')}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// 路由跟踪卡片
//
// 高度策略：折叠态与左侧「吞吐量」卡片等高（见上方 grid 注释），hop 列表内部
// 滚动 + 底部渐变遮罩提示「还有更多」；展开态自然撑开，由页面滚动。
// 折叠/展开状态由 Dashboard 持有 —— 外层容器的等高约束依赖它。
function RouteTraceCard({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{
    target: string;
    hops: Array<{ hop: number; ip: string | null; hostname: string; rtt: number | null }>;
    completed: boolean;
    duration: number;
    /** 失败原因（主进程带出来的）—— 用来告诉用户到底卡在哪 */
    error?: string;
    /** tracert 原始输出（截断 4KB）—— 0 跳时折叠展示 */
    raw?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 追踪目标来自设置页的「探针节点管理」(默认 example.com)。
  // 这里只读不改 —— 要改去设置页, 避免同一个配置有两个入口。
  const [target, setTarget] = useState<string>('');

  // 折叠时 hop 列表在内部滚动 —— 要知道"是否还有内容没露出来"，才能决定
  // 是否显示底部渐变遮罩、是否给「展开全部」按钮。
  const hopsRef = useRef<HTMLDivElement>(null);
  const [overflowState, setOverflowState] = useState({
    hasMore: false,
    atBottom: false,
  });

  // 组件挂载时执行一次 traceroute
  useEffect(() => {
    loadTarget();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadTarget = async () => {
    // ⚠️ 变量名不能叫 `t` —— 会遮蔽上面的翻译函数
    let configured = '';
    try {
      if (window.electronAPI?.getConfig) {
        const cfg = await window.electronAPI.getConfig();
        configured = cfg.probe?.traceTarget ?? '';
      }
    } catch {
      // 配置读不到就用默认, 不阻塞卡片
    }
    const finalTarget = configured || 'example.com';
    setTarget(finalTarget);
    runTrace(finalTarget);
  };

  const runTrace = async (targetOverride?: string) => {
    if (!window.electronAPI?.runTraceroute) {
      setError(t('dashboard:route.only_electron'));
      return;
    }

    const traceTarget = (targetOverride ?? target).trim() || 'example.com';
    setLoading(true);
    setError(null);

    try {
      const result = await window.electronAPI.runTraceroute(traceTarget);
      // 防御: IPC 返回的结构不可信(旧版本/异常路径), 缺 hops 会让
      // 下面的 data.hops.length 抛错 ⇒ 整个仪表盘被 ErrorBoundary 清空。
      if (!result || !Array.isArray(result.hops)) {
        setData(null);
        setError(t('dashboard:route.unparseable'));
        return;
      }
      setData(result);
    } catch (err: any) {
      setError(err.message || t('dashboard:route.exec_failed'));
    } finally {
      setLoading(false);
    }
  };

  // 溢出检测 —— 折叠态才需要：内容超出可视区时显示底部渐变遮罩。
  // ResizeObserver 一起监听：窗口缩放 / 展开收起都会改变可视高度。
  useEffect(() => {
    const el = hopsRef.current;
    if (!el) return;

    const measure = () => {
      const hasMore = el.scrollHeight - el.clientHeight > 2;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      setOverflowState((prev) =>
        prev.hasMore === hasMore && prev.atBottom === atBottom
          ? prev
          : { hasMore, atBottom },
      );
    };

    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      resizeObserver.disconnect();
    };
  }, [data, expanded]);

  const avgLatency = data?.hops && data.hops.length > 0
    ? data.hops
        .filter(h => h.rtt !== null)
        .reduce((sum, h) => sum + (h.rtt || 0), 0) / 
        (data.hops.filter(h => h.rtt !== null).length || 1)
    : 0;

  // 折叠态、且确实还有 hop 没露出来、且没滚到底 —— 才盖渐变遮罩
  const showFade = !expanded && overflowState.hasMore && !overflowState.atBottom;
  // 有内容被藏住才给「展开全部」；已展开则给「收起」
  const canToggle = expanded || overflowState.hasMore;

  // 卡片用 flex-1 而不是 h-full：父容器里还有「路由器状态行 + gap」，
  // h-full(100%) 会让卡片超出行高把父容器撑破；flex-1 吃掉剩余高度才对。
  return (
    <Card className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <CardContent className="flex-1 flex flex-col min-h-0 p-4">
        <div className="flex items-center justify-between mb-2 gap-2 shrink-0">
          <h3 className="text-sm font-semibold text-slate-300 shrink-0">
            <Activity className="w-4 h-4 inline mr-2 text-accent-green" />
            {t('dashboard:route.title')}
          </h3>
          <div className="flex items-center gap-2 flex-1 justify-end">
            {/* 目标只读显示 —— 编辑入口统一在设置页的「探针节点管理」,
                避免同一个配置有两个地方能改。 */}
            <span
              className="font-mono text-[11px] text-slate-400 truncate"
              title={t('dashboard:route.target_title')}
            >
              {target || '—'}
            </span>
            <button
              onClick={() => runTrace()}
              disabled={loading}
              className="text-xs text-accent-green hover:text-accent-green/80 disabled:opacity-50 shrink-0"
            >
              {loading ? t('dashboard:route.running') : t('dashboard:route.refresh')}
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
            {t('dashboard:route.tracing')}
          </div>
        )}

        {data && data.hops.length > 0 && (
          <>
            {/* hop 列表：折叠态内部滚动（可视高度由右列 378px 约束决定），
                展开态去掉滚动、自然撑开 */}
            <div className="relative flex-1 min-h-0 flex flex-col">
              <div
                ref={hopsRef}
                className={`min-h-0 flex-1 pr-1 ${
                  expanded ? 'overflow-visible' : 'overflow-y-auto'
                }`}
              >
                {data.hops.map((hop, i) => (
                  // 单行式：序号 | IP | 主机名 | RTT
                  // 原来每跳两行（主机名 + 迷你延迟条）占 36px，同样高度只能看 5 跳；
                  // 压成单行 24px 后能看 8 跳，颜色已经由 RTT 文字承担。
                  <div key={i} className="flex items-center gap-2 py-1 text-[11px]">
                    <div className="relative flex items-center shrink-0" style={{ width: '10px' }}>
                      <span className="w-1.5 h-1.5 rounded-full bg-accent-green shrink-0" />
                      {i < data.hops.length - 1 && (
                        <span className="absolute top-1 left-0 w-px h-[15px] bg-accent-green/40" />
                      )}
                    </div>
                    <span className="w-5 text-right font-mono text-slate-500 shrink-0">
                      {hop.hop}
                    </span>
                    {/* IP 与主机名放在**同一列的上下两行**：
                        卡片行宽只有 ~280px，四列平铺时主机名列只分到 ~47px，
                        "xe-0-1-0.gw8.sjc7.alter.net" 会被截成 "xe-0-1…"（等于没显示）。
                        上下两行后两者各得 ~150px，IP 完整、主机名可读；
                        只有「有名字的跳」才多占一行，无名字/超时跳仍是单行。 */}
                    <div className="flex-1 min-w-0">
                      <div
                        className="font-mono text-slate-200 truncate"
                        title={hop.ip ?? undefined}
                      >
                        {hop.ip || '*'}
                      </div>
                      {/* 反查失败时 hostname 就是 IP 本身；超时跳的第二行与右侧超时标记重复，都不显示 */}
                      {hop.ip !== null && hop.hostname !== hop.ip && (
                        <div className="text-slate-400 truncate" title={hop.hostname}>
                          {hop.hostname}
                        </div>
                      )}
                    </div>
                    <span
                      className={`w-14 text-right font-mono shrink-0 ${
                        hop.rtt === null
                          ? 'text-slate-500'
                          : hop.rtt > 30
                            ? 'text-warning-orange'
                            : 'text-slate-300'
                      }`}
                    >
                      {hop.rtt !== null ? `${hop.rtt.toFixed(1)}ms` : '* * *'}
                    </span>
                  </div>
                ))}
              </div>
              {/* 底部渐变遮罩：暗示下方还有 hop 没露出来（滚到底自动收掉） */}
              {showFade && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-card to-transparent" />
              )}
            </div>

            {/* 汇总 + 展开/收起 */}
            <div className="shrink-0 mt-auto border-t border-slate-700/40 pt-2 text-[11px] text-slate-500 font-mono flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>{t('dashboard:route.target', { target: data.target })}</span>
              <span>{t('dashboard:route.hops', { count: data.hops.length })}</span>
              <span>{t('dashboard:route.avg_latency', { value: avgLatency.toFixed(1) })}</span>
              <span className={data.completed ? 'text-accent-green' : 'text-warning-orange'}>
                {data.completed ? t('dashboard:route.reached') : t('dashboard:route.not_reached')}
              </span>
              {canToggle && (
                <button
                  onClick={onToggle}
                  aria-expanded={expanded}
                  className="ml-auto text-accent-green hover:text-accent-green/80 shrink-0"
                >
                  {expanded ? t('dashboard:route.collapse') : t('dashboard:route.expand_all')}
                </button>
              )}
            </div>
          </>
        )}

        {/* 失败原因由主进程带出来 —— 之前只写日志，界面无从判断 */}
        {data && data.hops.length === 0 && (
          <RouteTraceEmpty error={data.error} raw={data.raw} t={t} />
        )}
      </CardContent>
    </Card>
  );
}