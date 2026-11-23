/**
 * 卫星雷达页面
 * 显示天空中可见的 Starlink 卫星位置
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as echarts from 'echarts';
import { useDish } from '../hooks/useDish';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Alert, AlertDescription } from '../components/ui/alert';
import { RefreshCw, MapPin, AlertCircle, Loader2 } from 'lucide-react';
import {
  getTLEData,
  describeFreshness,
  clearTLECache,
  getCacheInfo,
  TLEFetchError,
  type TLEFreshness,
} from '../utils/tleService';
import {
  calculateMultipleSatellites,
  filterVisibleSatellites,
  getObserverLocation,
  calculateAngularSeparation,
  type SatellitePosition,
} from '../utils/satelliteCalculator';
import {
  estimateServingSatellite,
  MAX_PLAUSIBLE_RANGE_KM,
  type EstimateConfidence,
  type ServingReason,
  type ServingSatelliteEstimate,
} from '../utils/servingSatellite';
import { LanguageSwitcher } from '../components/LanguageSwitcher';

/** 页面级错误语义码（文案由 ERROR_KEYS 取字典，错误详情只进控制台） */
type RadarErrorCode = 'no_location' | 'no_tle' | 'no_visible' | 'tle_fetch_failed' | 'load_failed';

const ERROR_KEYS: Record<RadarErrorCode, string> = {
  no_location: 'satellite:error.no_location',
  no_tle: 'satellite:error.no_tle',
  no_visible: 'satellite:error.no_visible',
  tle_fetch_failed: 'satellite:error.tle_fetch',
  load_failed: 'satellite:error.load_failed',
};

/**
 * 与服务卫星夹角小于这个值的算「候选卫星」(橙色)。
 * 之前是硬编码的 25, 提到常量是为了让分层规则只有一处。
 */
const RUNNER_SEPARATION_DEG = 25;

/** 估算原因语义码 → 字典键（数值由页面从 estimate 里取，不在逻辑模块里拼） */
const ESTIMATE_REASON_KEYS: Record<ServingReason | 'device_id', string> = {
  no_boresight: 'satellite:est.no_boresight',
  no_visible: 'satellite:est.no_visible',
  abnormal_orbits: 'satellite:est.abnormal_orbits',
  tight_fit_unique: 'satellite:est.tight_unique',
  tight_fit_unique_margin: 'satellite:est.tight_unique_margin',
  tight_fit_continuous: 'satellite:est.tight_continuous',
  tight_fit_ambiguous: 'satellite:est.tight_ambiguous',
  margin_high_offset: 'satellite:est.margin_high_offset',
  margin_low_offset: 'satellite:est.margin_low_offset',
  continuous_ambiguous: 'satellite:est.continuous_ambiguous',
  margin_ambiguous: 'satellite:est.margin_ambiguous',
  outside_window: 'satellite:est.outside_window',
  device_id: 'satellite:est.device_id',
};

const CONFIDENCE_LABEL_KEYS: Record<EstimateConfidence, string> = {
  high: 'satellite:serving.confidence_high',
  medium: 'satellite:serving.confidence_medium',
  low: 'satellite:serving.confidence_low',
  none: 'satellite:serving.confidence_low',
};

// 卫星数据类型
interface SatelliteData {
  name: string;
  norad: string;
  azimuth: number; // 方位角 0-360°
  elevation: number; // 仰角 0-90°
  separation: string; // 与当前服务卫星的角距离
  range: string; // 距离 (km)
  firstSeen: string;
  lastSeen: string;
  minutes: number; // 持续时间(分钟)
  serving?: boolean; // 是否为当前服务卫星
}

export default function SatelliteRadar() {
  const { t, i18n } = useTranslation('satellite');
  const { telemetry } = useDish();
  const radarRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const loadingRef = useRef(false); // 使用 ref 跟踪加载状态，避免闭包问题

  const [satellites, setSatellites] = useState<SatelliteData[]>([]);
  const [servingSat, setServingSat] = useState<SatelliteData | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<RadarErrorCode | null>(null);
  const [locationError, setLocationError] = useState(false);
  const [cacheInfo, setCacheInfo] = useState({ hasCached: false, age: null as number | null, count: null as number | null });
  // 星历来源与新鲜度: 离线兜底时需要告诉用户数据有多旧
  const [tleInfo, setTleInfo] = useState<{ source: string; freshness: TLEFreshness; degraded: boolean } | null>(null);
  // 服务卫星估算结果 (含置信度与原因)
  const [estimate, setEstimate] = useState<ServingSatelliteEstimate | null>(null);
  // 估算原因的语义码（'device_id' = 设备真上报了 ID，不是估算）
  const [estimateReason, setEstimateReason] = useState<ServingReason | 'device_id' | null>(null);
  // 上一帧的服务卫星, 用于时间连续性判断 (交接瞬间相邻候选难分, 连续性可破)
  const servingSatRef = useRef<{ norad: string; name: string } | null>(null);
  // 设备波束指向 —— 提到组件层, chart effect 与重算 effect 都要依赖它
  // (telemetry 每次 refresh 都是新对象, 所以取具体字段值而非对象)
  const bsAz = telemetry?.boresightAzimuthDeg;
  const bsEl = telemetry?.boresightElevationDeg;

  /** 星历新鲜度语义码 → 当前语言文案 */
  const freshnessText = (freshness: TLEFreshness): string => {
    switch (freshness.kind) {
      case 'network':
        return t('satellite:tle.freshness_network');
      case 'cache_under_hour':
        return t('satellite:tle.freshness_cache_under_hour');
      case 'cache_hours':
        return t('satellite:tle.freshness_cache_hours', { count: freshness.count });
      case 'stale_cache':
        return freshness.age.unit === 'hours'
          ? t('satellite:tle.freshness_stale_cache_hours', { count: freshness.age.count })
          : t('satellite:tle.freshness_stale_cache_days', { count: freshness.age.count });
      case 'seed':
        return freshness.age.unit === 'hours'
          ? t('satellite:tle.freshness_seed_hours', { count: freshness.age.count })
          : t('satellite:tle.freshness_seed_days', { count: freshness.age.count });
    }
  };

  /** 估算原因语义码 → 当前语言文案（把 estimate 里的数值作为插值传入） */
  const estimateReasonText = (
    reason: ServingReason | 'device_id',
    current: ServingSatelliteEstimate | null
  ): string => {
    const sep = Number.isFinite(current?.separationDeg) ? current!.separationDeg.toFixed(2) : '—';
    const margin = current?.marginDeg !== null && current?.marginDeg !== undefined
      ? current.marginDeg.toFixed(1)
      : '0';
    return t(ESTIMATE_REASON_KEYS[reason], { sep, margin });
  };

  // 转换 SatellitePosition 为 SatelliteData
  const convertToSatelliteData = (
    pos: SatellitePosition,
    serving: SatellitePosition | null
  ): SatelliteData => {
    // ⚠️ 没有服务卫星时 separation 必须留空 —— 写成 0 会让**每一颗**卫星
    // 都满足「与波束夹角 < 25°」, 于是候选卫星层会塞满整片天空,
    // 而真正贴着波束的那几颗反而淹没在里面。
    const separation =
      serving === null ? '' : `${calculateAngularSeparation(pos, serving).toFixed(1)}°`;

    return {
      name: pos.name,
      norad: pos.noradId,
      azimuth: pos.azimuth,
      elevation: pos.elevation,
      separation,
      range: `${Math.round(pos.range)} km`,
      // 时间格式跟随当前语言（原来固定 zh-CN，英文界面会出现中文日期顺序）
      firstSeen: new Date().toLocaleTimeString(i18n.language, { hour12: false }),
      lastSeen: new Date().toLocaleTimeString(i18n.language, { hour12: false }),
      minutes: 0, // 暂时设为 0，需要历史跟踪
      serving: pos.noradId === serving?.noradId,
    };
  };

  // 加载卫星数据
  const loadSatelliteData = async (forceRefresh: boolean = false) => {
    // 防止重复加载
    if (loadingRef.current) {
      console.log('Already loading, skipping...');
      return;
    }

    loadingRef.current = true;
    setLoading(true);
    setErrorCode(null);
    setLocationError(false);

    try {
      // 检查观测者位置
      const observer = getObserverLocation();
      if (!observer) {
        setLocationError(true);
        setErrorCode('no_location');
        loadingRef.current = false;
        setLoading(false);
        return;
      }

      // 获取 TLE 数据 (自带回退链: 缓存 → 过期缓存 → 网络 → 内置种子)
      const tleResult = await getTLEData(forceRefresh);
      const tles = tleResult.data;

      setTleInfo({
        source: tleResult.source,
        freshness: describeFreshness(tleResult),
        degraded: tleResult.source === 'seed' || tleResult.source === 'stale-cache',
      });

      if (tles.length === 0) {
        setErrorCode('no_tle');
        loadingRef.current = false;
        setLoading(false);
        return;
      }

      // 计算所有卫星位置（包含 DTC 卫星 - 支持手机和普通终端）
      const allPositions = calculateMultipleSatellites(tles, observer);

      // 只保留地平线以上的卫星
      const visiblePositions = filterVisibleSatellites(allPositions, 0);

      // 剔除轨道距离异常的解轨残留 (实测见过 150636km / 20076020km)。
      // 它们仰角算得"正常", 混在列表里会误导用户, 也可能被选成服务卫星。
      const plausiblePositions = visiblePositions.filter((pos) => pos.range <= MAX_PLAUSIBLE_RANGE_KM);
      if (plausiblePositions.length < visiblePositions.length) {
        console.log(
          `[SatelliteRadar] dropped ${visiblePositions.length - plausiblePositions.length} satellites with implausible orbital range`
        );
      }

      if (plausiblePositions.length === 0) {
        setErrorCode('no_visible');
        loadingRef.current = false;
        setLoading(false);
        return;
      }

      // 确定服务卫星
      //
      // dish 的 gRPC 协议里没有 satelliteId 字段，拿不到设备上报的 ID。
      // 但 dish 给了波束指向（boresightAzimuthDeg / boresightElevationDeg），
      // 可以据此反推 —— 这正是 SatelliteTracker 一类工具的做法。
      //
      // 旧实现回退到「仰角最高」，实测不可靠：Starlink 密度高时仰角前几名
      // 互相差不到 2°，第 3 名甚至可能在正南方，与波束毫无关系。
      let servingPosition: SatellitePosition | null = null;
      let estimate: ServingSatelliteEstimate | null = null;
      let reasonCode: ServingReason | 'device_id' | null = null;

      // 优先用设备上报的 ID（协议目前没有，但留好口子）
      if (telemetry?.satelliteId) {
        const servingSatId = String(telemetry.satelliteId);
        const matchedPosition = plausiblePositions.find((pos) => pos.noradId === servingSatId);
        if (matchedPosition) {
          servingPosition = matchedPosition;
          reasonCode = 'device_id';
        } else {
          console.warn(
            `Service satellite ${servingSatId} not found in visible positions, falling back to boresight estimate`
          );
        }
      }

      // 没有设备 ID 就用波束估算
      if (!servingPosition) {
        const boresight =
          bsAz !== undefined && bsEl !== undefined
            ? { azimuthDeg: bsAz, elevationDeg: bsEl }
            : null;

        estimate = estimateServingSatellite(
          plausiblePositions,
          boresight,
          servingSatRef.current?.norad
        );
        servingPosition = estimate.satellite;
        reasonCode = estimate.reason;
      }

      // 上一帧的估算结果，用于时间连续性判断
      servingSatRef.current = servingPosition
        ? { norad: servingPosition.noradId, name: servingPosition.name }
        : null;

      setEstimate(estimate);
      setEstimateReason(reasonCode);

      // 转换数据格式
      const satelliteData = plausiblePositions.map((pos) =>
        convertToSatelliteData(pos, servingPosition)
      );

      setSatellites(satelliteData);
      setServingSat(satelliteData.find((s) => s.serving) || null);

      // 更新缓存信息
      setCacheInfo(getCacheInfo());

    } catch (err) {
      console.error('Error loading satellite data:', err);
      // 错误详情（上游源、HTTP 状态）只进控制台；界面只显示一句可操作的提示
      setErrorCode(err instanceof TLEFetchError ? 'tle_fetch_failed' : 'load_failed');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  // 首次加载 + 遥测到达后重算
  //
  // 服务卫星是**估算**出来的, 需要 telemetry 里的设备波束指向。
  // 而 telemetry 是异步拿到的 —— 首次挂载时它还是 null,
  // 只跑一次的话估算必然拿不到波束 (会退化成"无法确定")。
  // 所以 telemetry 变化时要重算。
  useEffect(() => {
    loadSatelliteData();
    setCacheInfo(getCacheInfo());

    // 每 30 秒更新一次卫星位置
    const interval = setInterval(() => {
      loadSatelliteData(false);
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  // 遥测到了 → 重算服务卫星
  useEffect(() => {
    if (bsAz === undefined && bsEl === undefined) return;
    loadSatelliteData(false);
  }, [bsAz, bsEl]);

  // 监听位置更新事件和页面可见性变化
  useEffect(() => {
    const handleLocationUpdate = () => {
      console.log('Terminal location updated, reloading satellite data');
      loadSatelliteData();
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        console.log('Page became visible, reloading satellite data');
        loadSatelliteData();
      }
    };

    window.addEventListener('terminal-location-updated', handleLocationUpdate);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('terminal-location-updated', handleLocationUpdate);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []); // loadSatelliteData 现在使用 ref 防止竞争，不需要依赖

  // 强制刷新 TLE 数据
  const handleRefresh = () => {
    loadSatelliteData(true);
  };

  // 清除缓存
  const handleClearCache = () => {
    clearTLECache();
    setCacheInfo(getCacheInfo());
    loadSatelliteData(true);
  };

  // 初始化雷达图
  //
  // 图例名与 series 的 name 必须完全一致（echarts 要求），所以统一在这里算一次。
  // 文案随语言变化 —— 依赖 i18n.language 让切语言时重建图表。
  useEffect(() => {
    if (!radarRef.current || satellites.length === 0) return;

    // 初始化或获取图表实例
    if (!chartRef.current) {
      chartRef.current = echarts.init(radarRef.current);
    }

    const chart = chartRef.current;

    // 分组数据
    // 服务卫星标记。
    //
    // 正常情况: 它就在 satellites 里, 带 serving 标记。
    // 兜底: 估算结果里的那颗星被过滤掉了(异常轨道/仰角为负)时, 用估算值
    // 单独画一个 —— 右上角的卡片有它, 天空图上却没有, 是最让人困惑的状态。
    const servingFromList = satellites
      .filter((s) => s.serving)
      .map((s) => ({
        value: [s.azimuth, 90 - s.elevation], // 极坐标系统: 半径使用 90-仰角
        name: s.name,
        el: s.elevation.toFixed(1),
        az: s.azimuth.toFixed(0),
      }));

    const servingData =
      servingFromList.length > 0
        ? servingFromList
        : estimate?.satellite
          ? [
              {
                value: [
                  estimate.satellite.azimuth,
                  90 - estimate.satellite.elevation,
                ] as [number, number],
                name: estimate.satellite.name,
                el: estimate.satellite.elevation.toFixed(1),
                az: estimate.satellite.azimuth.toFixed(0),
              },
            ]
          : [];

    // separation 为空 = 还没有服务卫星 ⇒ 不分「候选/可见」, 全部当可见卫星画。
    const sepOf = (s: SatelliteData): number =>
      s.separation ? parseFloat(s.separation) : Number.NaN;

    const runnersData = satellites
      .filter((s) => !s.serving && sepOf(s) < RUNNER_SEPARATION_DEG)
      .map((s) => ({
        value: [s.azimuth, 90 - s.elevation],
        name: s.name,
        el: s.elevation.toFixed(1),
        az: s.azimuth.toFixed(0),
      }));

    const visibleData = satellites
      .filter(
        (s) =>
          !s.serving &&
          (Number.isNaN(sepOf(s)) || sepOf(s) >= RUNNER_SEPARATION_DEG)
      )
      .map((s) => ({
        value: [s.azimuth, 90 - s.elevation],
        name: s.name,
        el: s.elevation.toFixed(1),
        az: s.azimuth.toFixed(0),
      }));

    // 服务卫星标记颜色随置信度变 —— 低置信度不该还用绿色脉冲
    const servingColor =
      !estimate || estimate.confidence === 'high'
        ? '#4ade80'
        : estimate.confidence === 'medium'
          ? '#f59e0b'
          : '#ef4444';

    // 图例与 series 必须同名 (echarts 要求), 所以只算一次
    const servingSeriesName = estimate
      ? t('satellite:legend.serving_estimated')
      : t('satellite:legend.serving');
    const runnersSeriesName = t('satellite:legend.runners');
    const visibleSeriesName = t('satellite:legend.visible');
    const boresightSeriesName = t('satellite:legend.boresight');

    // 设备波束指向 —— 估算的参照物，画成十字
    const boresightData =
      bsAz !== undefined && bsEl !== undefined
        ? [
            {
              value: [bsAz, 90 - bsEl],
              name: boresightSeriesName,
              el: bsEl.toFixed(1),
              az: bsAz.toFixed(0),
            },
          ]
        : [];

    const option: echarts.EChartsOption = {
      backgroundColor: 'transparent',
      polar: {
        center: ['50%', '52%'],
        radius: '80%',
      },
      legend: {
        bottom: 0,
        textStyle: { color: '#94a3b8', fontSize: 10 },
        itemWidth: 9,
        itemHeight: 9,
        // 估算出来的服务卫星要说清楚 —— 绿色脉冲看着像"确知的"
        // 注意: 图例名必须与 series 的 name 完全一致, 否则 echarts 报
        // "series not exists"
        data: [
          servingSeriesName,
          runnersSeriesName,
          visibleSeriesName,
          boresightSeriesName,
        ],
      },
      angleAxis: {
        min: 0,
        max: 360,
        startAngle: 90, // 从北(上)开始
        clockwise: true, // 顺时针
        axisLine: { lineStyle: { color: '#334155' } },
        axisLabel: {
          color: '#64748b',
          fontSize: 9,
          formatter: '{value}°',
        },
        splitLine: { lineStyle: { color: '#1e293b' } },
      },
      radiusAxis: {
        min: 0,
        max: 90, // 0° 在中心(天顶), 90° 在边缘(地平线)
        inverse: true, // 反转, 让天顶在中心
        axisLine: { show: false },
        axisLabel: {
          color: '#64748b',
          fontSize: 9,
          formatter: (value: number) => `${value}°`,
        },
        splitLine: { lineStyle: { color: '#1e293b', type: 'dashed' } },
      },
      tooltip: {
        trigger: 'item',
        backgroundColor: '#111a28',
        borderColor: '#334155',
        textStyle: { color: '#e2e8f0', fontSize: 11 },
        formatter: (params: any) => {
          const data = params.data;
          // ECharts 的 tooltip 不走 React，文案从字典取当前语言
          return `<b>${data.name}</b><br/>${t('satellite:serving.elevation')}: ${data.el}° · ${t('satellite:serving.azimuth')}: ${data.az}°`;
        },
      },
      series: [
        {
          name: visibleSeriesName,
          type: 'scatter',
          coordinateSystem: 'polar',
          data: visibleData,
          symbolSize: 6,
          itemStyle: { color: '#38bdf8', opacity: 0.55 },
          emphasis: { scale: 1.6 },
        },
        {
          name: runnersSeriesName,
          type: 'scatter',
          coordinateSystem: 'polar',
          data: runnersData,
          symbolSize: 11,
          itemStyle: {
            color: '#f59e0b',
            shadowBlur: 8,
            shadowColor: '#f59e0b',
          },
          emphasis: { scale: 1.5 },
        },
        {
          name: servingSeriesName,
          type: 'effectScatter',
          coordinateSystem: 'polar',
          data: servingData,
          symbolSize: 17,
          rippleEffect: { scale: 3, brushType: 'stroke' },
          itemStyle: {
            // 置信度低时用警示色，别让绿脉冲看起来像"确知的"
            color: servingColor,
            shadowBlur: 14,
            shadowColor: servingColor,
          },
        },
        // 设备波束指向 —— 估算的参照物
        ...(boresightData.length > 0
          ? [
              {
                name: boresightSeriesName,
                type: 'scatter' as const,
                coordinateSystem: 'polar' as const,
                data: boresightData,
                symbolSize: 13,
                symbol: 'cross' as const,
                itemStyle: { color: '#a78bfa', opacity: 0.9 },
              },
            ]
          : []),
      ],
    };

    chart.setOption(option);

    // 响应式
    const handleResize = () => chart.resize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [satellites, estimate, bsAz, bsEl, t, i18n.language]);

  // 统计数据
  const stats = {
    visible: satellites.length,
    distinct: satellites.filter((s) => !s.serving && parseFloat(s.separation) < 25).length + 1,
    avgElevation: satellites.length > 0
      ? (satellites.reduce((sum, s) => sum + s.elevation, 0) / satellites.length).toFixed(1)
      : '0',
  };

  const runners = satellites.filter((s) => !s.serving && parseFloat(s.separation) < 25).slice(0, 4);

  const observer = getObserverLocation();

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">{t('satellite:page.title')}</h1>
          <p className="text-muted-foreground mt-1">
            {t('satellite:page.subtitle')}
            {cacheInfo.hasCached && cacheInfo.age && (
              <span className="ml-2 text-xs">
                {t('satellite:radar.tle_updated_minutes', { count: Math.round(cacheInfo.age / 60000) })}
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4 mr-2" />
            )}
            {t('satellite:radar.refresh_tle')}
          </Button>
          {cacheInfo.hasCached && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearCache}
              disabled={loading}
            >
              {t('satellite:radar.clear_cache')}
            </Button>
          )}

          {/* 全局语言切换（需求指定的「右上角」位置） */}
          <LanguageSwitcher variant="icon" />
        </div>
      </div>

      {/* 错误提示 */}
      {errorCode && (
        <Alert className={locationError ? 'border-orange-500 bg-orange-500/10' : 'border-red-500 bg-red-500/10'}>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="ml-7">
            {t(ERROR_KEYS[errorCode])}
            {locationError && (
              <a href="/settings" className="ml-2 underline text-accent">
                {t('satellite:radar.link_settings')}
              </a>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* 位置提示 */}
      {!locationError && observer && (
        <Alert className="border-blue-500/50 bg-blue-500/10">
          <MapPin className="h-4 w-4 text-blue-500" />
          <AlertDescription className="ml-7 text-sm">
            {t('satellite:location.prefix', {
              lat: observer.latitude.toFixed(6),
              lon: observer.longitude.toFixed(6),
            })}
            {cacheInfo.count
              ? t('satellite:location.loaded_satellites', { count: cacheInfo.count })
              : ''}
            {telemetry?.satelliteId
              ? t('satellite:location.serving_id', { id: telemetry.satelliteId })
              : ''}
          </AlertDescription>
        </Alert>
      )}

      {/* 星历来源提示: 离线降级时明确告知用户数据有多旧 */}
      {tleInfo && (
        <Alert className={tleInfo.degraded ? 'border-yellow-500/50 bg-yellow-500/10' : 'border-blue-500/50 bg-blue-500/10'}>
          {tleInfo.degraded ? (
            <AlertCircle className="h-4 w-4 text-yellow-500" />
          ) : (
            <MapPin className="h-4 w-4 text-blue-500" />
          )}
          <AlertDescription className="ml-7 text-sm">
            {freshnessText(tleInfo.freshness)}
            {tleInfo.degraded && (
              <span className="block mt-1 text-xs text-muted-foreground">
                {t('satellite:tle.degraded_warning')}
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

      {loading && satellites.length === 0 ? (
        <Card>
          <CardContent className="pt-6 flex items-center justify-center h-96">
            <div className="text-center">
              <Loader2 className="w-12 h-12 animate-spin text-accent mx-auto" />
              <p className="mt-4 text-muted-foreground">{t('satellite:loading.calculating')}</p>
              <p className="text-xs text-muted-foreground mt-2">
                {tleInfo
                  ? t('satellite:loading.with_source', { source: freshnessText(tleInfo.freshness) })
                  : t('satellite:loading.tle')}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : errorCode && satellites.length === 0 ? (
        // 加载失败且没有任何数据 —— 给出可操作的提示, 不能只转圈
        <Card>
          <CardContent className="pt-6 flex flex-col items-center justify-center h-96 text-center">
            <AlertCircle className="w-12 h-12 text-red-500/70" />
            <p className="mt-4 text-foreground">{t(ERROR_KEYS[errorCode])}</p>
            <p className="text-xs text-muted-foreground mt-2 max-w-md">
              {locationError
                ? t('satellite:error.hint_location')
                : t('satellite:error.hint_tle')}
            </p>
            {!locationError && (
              <div className="mt-4 flex gap-2">
                <Button onClick={() => loadSatelliteData(true)}>{t('satellite:radar.retry')}</Button>
                <Button variant="outline" onClick={() => { clearTLECache(); loadSatelliteData(true); }}>
                  {t('satellite:radar.retry_after_clear')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {/* 左侧: 雷达图 */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <i className="fa-solid fa-satellite-dish text-accent"></i>
                  {t('satellite:sky.title')}
                </CardTitle>
                <CardDescription>{t('satellite:sky.desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div ref={radarRef} style={{ height: '380px', width: '100%' }}></div>
                <p className="text-xs text-muted-foreground text-center mt-2">
                  {t('satellite:sky.note_base')}
                  {estimate
                    ? t('satellite:sky.note_estimated_suffix')
                    : t('satellite:sky.note_serving_suffix')}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* 右侧: 统计与列表 */}
          <div className="lg:col-span-3 space-y-4">
          {/* 当前服务卫星 */}
          {servingSat && (
            <Card className="border-accent/40 shadow-lg shadow-accent/20">
              <CardContent className="pt-6">
                <div className="text-xs text-muted-foreground">
                  {estimate ? t('satellite:serving.estimated') : t('satellite:serving.active')}
                </div>
                <div className="font-mono text-2xl font-bold text-accent mt-1">
                  {servingSat.name}
                </div>
                <div className="text-sm text-muted-foreground mt-1">
                  NORAD ID: {servingSat.norad}
                  {telemetry?.satelliteId && telemetry.satelliteId === parseInt(servingSat.norad) && (
                    <span className="ml-2 px-2 py-0.5 rounded bg-accent/20 text-accent text-[10px]">
                      {t('satellite:serving.verified')}
                    </span>
                  )}
                </div>

                {/* 估算置信度 —— 必须标明这是推断值，不是设备上报的 ID */}
                {estimate && (
                  <div className="mt-2 text-xs">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] ${
                        estimate.confidence === 'high'
                          ? 'bg-accent/20 text-accent'
                          : estimate.confidence === 'medium'
                            ? 'bg-warning-orange/20 text-warning-orange'
                            : 'bg-danger-red/20 text-danger-red'
                      }`}
                    >
                      {t('satellite:serving.confidence', {
                        level: t(CONFIDENCE_LABEL_KEYS[estimate.confidence]),
                      })}
                    </span>
                    {estimate.separationDeg !== undefined && !Number.isNaN(estimate.separationDeg) && (
                      <span className="ml-2 text-muted-foreground">
                        {t('satellite:serving.separation_from_boresight', {
                          deg: estimate.separationDeg.toFixed(2),
                        })}
                      </span>
                    )}
                    {estimateReason && (
                      <div className="text-muted-foreground mt-1 leading-relaxed">
                        {estimateReasonText(estimateReason, estimate)}
                      </div>
                    )}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                  <div>
                    <div className="text-muted-foreground">{t('satellite:serving.azimuth')}</div>
                    <div className="font-mono font-semibold">{servingSat.azimuth.toFixed(1)}°</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">{t('satellite:serving.elevation')}</div>
                    <div className="font-mono font-semibold">{servingSat.elevation.toFixed(1)}°</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">{t('satellite:serving.distance')}</div>
                    <div className="font-mono font-semibold">{servingSat.range}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">{t('satellite:serving.track_duration')}</div>
                    <div className="font-mono font-semibold">
                      {t('satellite:serving.track_duration_value', { count: servingSat.minutes })}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* 统计卡片 */}
          <div className="grid grid-cols-2 gap-3">
            <Card>
              <CardContent className="pt-6">
                <div className="text-xs text-muted-foreground">{t('satellite:stats.separation_elevation')}</div>
                <div className="font-mono text-2xl font-bold text-foreground mt-1">
                  {servingSat?.separation || '—'} / {servingSat?.elevation.toFixed(1)}°
                </div>
                <div className="text-xs text-muted-foreground mt-1">{t('satellite:stats.separation_elevation_sub')}</div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="text-xs text-muted-foreground">{t('satellite:stats.visible_count')}</div>
                <div className="font-mono text-2xl font-bold text-foreground mt-1">
                  {stats.visible} <span className="text-sm text-muted-foreground">{t('satellite:stats.unit_satellites')}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {t('satellite:stats.avg_elevation', { deg: stats.avgElevation })}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="text-xs text-muted-foreground">{t('satellite:stats.runners')}</div>
                <div className="font-mono text-2xl font-bold text-sky-400 mt-1">
                  {runners.length} <span className="text-sm text-muted-foreground">{t('satellite:stats.unit_satellites')}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1">{t('satellite:stats.runners_sub')}</div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="text-xs text-muted-foreground">{t('satellite:stats.distinct_orbits')}</div>
                <div className="font-mono text-2xl font-bold text-sky-400 mt-1">
                  {stats.distinct} <span className="text-sm text-muted-foreground">{t('satellite:stats.unit_satellites')}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1">{t('satellite:stats.distinct_sub')}</div>
              </CardContent>
            </Card>
          </div>

          {/* 候选卫星 */}
          {runners.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t('satellite:runners.title')}</CardTitle>
                <CardDescription>{t('satellite:runners.desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {runners.map((s) => (
                    <div
                      key={s.name}
                      className="px-3 py-2 rounded-lg bg-slate-800/70 text-xs font-mono"
                    >
                      {s.name}{' '}
                      <span className="text-orange-500 ml-1">{s.separation}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* 卫星列表 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-sm">
                <span>
                  <i className="fa-solid fa-table mr-2 text-accent"></i>
                  {t('satellite:list.title')}
                </span>
                <span className="text-xs text-muted-foreground font-mono">
                  {t('satellite:list.sorted_by')}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground border-b border-border sticky top-0 bg-card">
                    <tr className="text-left">
                      <th className="py-2 font-medium">{t('satellite:list.th_name_norad')}</th>
                      <th className="font-medium">{t('satellite:list.th_duration_min')}</th>
                      <th className="font-medium">{t('satellite:list.th_separation')}</th>
                      <th className="font-medium">{t('satellite:list.th_elevation')}</th>
                      <th className="font-medium">{t('satellite:list.th_distance')}</th>
                      <th className="font-medium">{t('satellite:list.th_first_seen')}</th>
                      <th className="font-medium">{t('satellite:list.th_last_seen')}</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {satellites
                      .sort((a, b) => parseFloat(a.separation) - parseFloat(b.separation))
                      .map((s) => (
                        <tr
                          key={s.name}
                          className={`border-b border-border/50 hover:bg-accent/5 ${
                            s.serving ? 'bg-accent/10 border-l-2 border-accent' : ''
                          }`}
                        >
                          <td className="py-2 pl-2">
                            <span className={s.serving ? 'text-accent font-bold' : 'text-accent'}>
                              {s.name}
                            </span>
                            {s.serving && (
                              <span className="ml-2 px-1 py-0.5 rounded bg-accent/20 text-accent text-[9px]">
                                {t('satellite:serving.badge')}
                              </span>
                            )}
                            <br />
                            <span className="text-muted-foreground">{s.norad}</span>
                          </td>
                          <td>{s.minutes.toFixed(1)}</td>
                          <td>{s.separation}</td>
                          <td>{s.elevation.toFixed(1)}°</td>
                          <td>{s.range}</td>
                          <td className="text-muted-foreground">{s.firstSeen}</td>
                          <td className="text-muted-foreground">{s.lastSeen}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
      )}
    </div>
  );
}
