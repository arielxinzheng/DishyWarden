/**
 * 卫星雷达页面
 * 显示天空中可见的 Starlink 卫星位置
 */

import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts';
import { useDish } from '../hooks/useDish';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Alert, AlertDescription } from '../components/ui/alert';
import { RefreshCw, MapPin, AlertCircle, Loader2 } from 'lucide-react';
import { getTLEData, describeFreshness, clearTLECache, getCacheInfo } from '../utils/tleService';
import {
  calculateMultipleSatellites,
  filterVisibleSatellites,
  getObserverLocation,
  calculateAngularSeparation,
  type SatellitePosition,
} from '../utils/satelliteCalculator';

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
  const { telemetry } = useDish();
  const radarRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const loadingRef = useRef(false); // 使用 ref 跟踪加载状态，避免闭包问题
  
  const [satellites, setSatellites] = useState<SatelliteData[]>([]);
  const [servingSat, setServingSat] = useState<SatelliteData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [locationError, setLocationError] = useState(false);
  const [cacheInfo, setCacheInfo] = useState({ hasCached: false, age: null as number | null, count: null as number | null });
  // 星历来源与新鲜度: 离线兜底时需要告诉用户数据有多旧
  const [tleInfo, setTleInfo] = useState<{ source: string; text: string; degraded: boolean } | null>(null);

  // 转换 SatellitePosition 为 SatelliteData
  const convertToSatelliteData = (
    pos: SatellitePosition,
    serving: SatellitePosition | null
  ): SatelliteData => {
    const separation = serving ? calculateAngularSeparation(pos, serving) : 0;
    
    return {
      name: pos.name,
      norad: pos.noradId,
      azimuth: pos.azimuth,
      elevation: pos.elevation,
      separation: `${separation.toFixed(1)}°`,
      range: `${Math.round(pos.range)} km`,
      firstSeen: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      lastSeen: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
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
    setError(null);
    setLocationError(false);

    try {
      // 检查观测者位置
      const observer = getObserverLocation();
      if (!observer) {
        setLocationError(true);
        setError('未设置终端位置，请前往设置页面配置经纬度');
        loadingRef.current = false;
        setLoading(false);
        return;
      }

      // 获取 TLE 数据 (自带回退链: 缓存 → 过期缓存 → 网络 → 内置种子)
      const tleResult = await getTLEData(forceRefresh);
      const tles = tleResult.data;

      setTleInfo({
        source: tleResult.source,
        text: describeFreshness(tleResult),
        degraded: tleResult.source === 'seed' || tleResult.source === 'stale-cache',
      });

      if (tles.length === 0) {
        setError('未获取到 TLE 数据');
        loadingRef.current = false;
        setLoading(false);
        return;
      }

      // 计算所有卫星位置
      const allPositions = calculateMultipleSatellites(tles, observer);
      
      // 只保留地平线以上的卫星
      const visiblePositions = filterVisibleSatellites(allPositions, 0);

      if (visiblePositions.length === 0) {
        setError('当前位置没有可见卫星');
        loadingRef.current = false;
        setLoading(false);
        return;
      }

      // 从 telemetry 获取真实的服务卫星 ID
      // 如果 telemetry 可用且包含有效的 satelliteId，使用它；否则回退到仰角最高的
      let servingPosition: SatellitePosition;
      if (telemetry?.satelliteId) {
        const servingSatId = String(telemetry.satelliteId);
        const matchedPosition = visiblePositions.find((pos) => pos.noradId === servingSatId);
        
        if (matchedPosition) {
          servingPosition = matchedPosition;
        } else {
          // 如果匹配失败（卫星ID不在可见列表中），使用仰角最高的
          console.warn(`Service satellite ${servingSatId} not found in visible positions, using highest elevation`);
          servingPosition = visiblePositions.reduce((max, pos) =>
            pos.elevation > max.elevation ? pos : max
          );
        }
      } else {
        // 如果没有 telemetry 数据，使用仰角最高的
        servingPosition = visiblePositions.reduce((max, pos) =>
          pos.elevation > max.elevation ? pos : max
        );
      }

      // 转换数据格式
      const satelliteData = visiblePositions.map((pos) =>
        convertToSatelliteData(pos, servingPosition)
      );

      setSatellites(satelliteData);
      setServingSat(satelliteData.find((s) => s.serving) || null);

      // 更新缓存信息
      setCacheInfo(getCacheInfo());
      
    } catch (err) {
      console.error('Error loading satellite data:', err);
      setError(err instanceof Error ? err.message : '加载卫星数据失败');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  // 首次加载
  useEffect(() => {
    loadSatelliteData();
    setCacheInfo(getCacheInfo());

    // 每 30 秒更新一次卫星位置
    const interval = setInterval(() => {
      loadSatelliteData(false);
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  // 监听位置更新事件和页面可见性变化
  useEffect(() => {
    const handleLocationUpdate = () => {
      console.log('收到位置更新事件，重新加载卫星数据');
      loadSatelliteData();
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        console.log('页面变为可见，重新加载卫星数据');
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
  useEffect(() => {
    if (!radarRef.current || satellites.length === 0) return;

    // 初始化或获取图表实例
    if (!chartRef.current) {
      chartRef.current = echarts.init(radarRef.current);
    }

    const chart = chartRef.current;

    // 分组数据
    const servingData = satellites
      .filter((s) => s.serving)
      .map((s) => ({
        value: [s.azimuth, 90 - s.elevation], // 极坐标系统: 半径使用 90-仰角
        name: s.name,
        el: s.elevation.toFixed(1),
        az: s.azimuth.toFixed(0),
      }));

    const runnersData = satellites
      .filter((s) => !s.serving && parseFloat(s.separation) < 25)
      .map((s) => ({
        value: [s.azimuth, 90 - s.elevation],
        name: s.name,
        el: s.elevation.toFixed(1),
        az: s.azimuth.toFixed(0),
      }));

    const visibleData = satellites
      .filter((s) => !s.serving && parseFloat(s.separation) >= 25)
      .map((s) => ({
        value: [s.azimuth, 90 - s.elevation],
        name: s.name,
        el: s.elevation.toFixed(1),
        az: s.azimuth.toFixed(0),
      }));

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
        data: ['当前服务', '候选卫星', '可见卫星'],
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
          return `<b>${data.name}</b><br/>仰角: ${data.el}° · 方位角: ${data.az}°`;
        },
      },
      series: [
        {
          name: '可见卫星',
          type: 'scatter',
          coordinateSystem: 'polar',
          data: visibleData,
          symbolSize: 6,
          itemStyle: { color: '#38bdf8', opacity: 0.55 },
          emphasis: { scale: 1.6 },
        },
        {
          name: '候选卫星',
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
          name: '当前服务',
          type: 'effectScatter',
          coordinateSystem: 'polar',
          data: servingData,
          symbolSize: 17,
          rippleEffect: { scale: 3, brushType: 'stroke' },
          itemStyle: {
            color: '#4ade80',
            shadowBlur: 14,
            shadowColor: '#4ade80',
          },
        },
      ],
    };

    chart.setOption(option);

    // 响应式
    const handleResize = () => chart.resize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [satellites]);

  // 统计数据
  const stats = {
    visible: satellites.length,
    distinct: satellites.filter((s) => !s.serving && parseFloat(s.separation) < 25).length + 1,
    avgElevation: satellites.length > 0 
      ? (satellites.reduce((sum, s) => sum + s.elevation, 0) / satellites.length).toFixed(1) 
      : '0',
  };

  const runners = satellites.filter((s) => !s.serving && parseFloat(s.separation) < 25).slice(0, 4);

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">卫星雷达</h1>
          <p className="text-muted-foreground mt-1">
            基于 SGP4 轨道模型和 TLE 数据实时计算卫星位置
            {cacheInfo.hasCached && cacheInfo.age && (
              <span className="ml-2 text-xs">
                · TLE 更新于 {Math.round(cacheInfo.age / 60000)} 分钟前
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
            刷新 TLE
          </Button>
          {cacheInfo.hasCached && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearCache}
              disabled={loading}
            >
              清除缓存
            </Button>
          )}
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <Alert className={locationError ? 'border-orange-500 bg-orange-500/10' : 'border-red-500 bg-red-500/10'}>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="ml-7">
            {error}
            {locationError && (
              <a href="/settings" className="ml-2 underline text-accent">
                前往设置
              </a>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* 位置提示 */}
      {!locationError && getObserverLocation() && (
        <Alert className="border-blue-500/50 bg-blue-500/10">
          <MapPin className="h-4 w-4 text-blue-500" />
          <AlertDescription className="ml-7 text-sm">
            观测位置: {getObserverLocation()?.latitude.toFixed(6)}°N, {getObserverLocation()?.longitude.toFixed(6)}°E
            {cacheInfo.count && ` · 已加载 ${cacheInfo.count} 颗卫星星历`}
            {telemetry?.satelliteId && ` · 当前服务卫星: ${telemetry.satelliteId}`}
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
            {tleInfo.text}
            {tleInfo.degraded && (
              <span className="block mt-1 text-xs text-muted-foreground">
                轨道参数存在漂移，仰角可能有偏差；恢复网络后会自动刷新。
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
              <p className="mt-4 text-muted-foreground">正在计算卫星位置...</p>
              <p className="text-xs text-muted-foreground mt-2">
                {tleInfo
                  ? `正在用 ${tleInfo.text} 计算`
                  : '正在加载星历数据 (TLE) 并运行 SGP4 轨道计算'}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : error && satellites.length === 0 ? (
        // 加载失败且没有任何数据 —— 给出可操作的提示, 不能只转圈
        <Card>
          <CardContent className="pt-6 flex flex-col items-center justify-center h-96 text-center">
            <AlertCircle className="w-12 h-12 text-red-500/70" />
            <p className="mt-4 text-foreground">{error}</p>
            <p className="text-xs text-muted-foreground mt-2 max-w-md">
              {locationError
                ? '在「设置」页填写终端经纬度后即可计算卫星仰角。'
                : '星历数据是计算卫星位置的必要输入。请检查网络连接后重试。'}
            </p>
            {!locationError && (
              <div className="mt-4 flex gap-2">
                <Button onClick={() => loadSatelliteData(true)}>重试</Button>
                <Button variant="outline" onClick={() => { clearTLECache(); loadSatelliteData(true); }}>
                  清除缓存后重试
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
                  天空视图
                </CardTitle>
                <CardDescription>极坐标雷达 · 中心为天顶(90°)</CardDescription>
              </CardHeader>
              <CardContent>
                <div ref={radarRef} style={{ height: '380px', width: '100%' }}></div>
                <p className="text-xs text-muted-foreground text-center mt-2">
                  圆心 = 天顶 | 边缘 = 地平线 | 绿色脉冲 = 当前服务卫星
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
                <div className="text-xs text-muted-foreground">当前服务卫星 (Active)</div>
                <div className="font-mono text-2xl font-bold text-accent mt-1">
                  {servingSat.name}
                </div>
                <div className="text-sm text-muted-foreground mt-1">
                  NORAD ID: {servingSat.norad}
                  {telemetry?.satelliteId && telemetry.satelliteId === parseInt(servingSat.norad) && (
                    <span className="ml-2 px-2 py-0.5 rounded bg-accent/20 text-accent text-[10px]">
                      已验证
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                  <div>
                    <div className="text-muted-foreground">方位角</div>
                    <div className="font-mono font-semibold">{servingSat.azimuth.toFixed(1)}°</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">仰角</div>
                    <div className="font-mono font-semibold">{servingSat.elevation.toFixed(1)}°</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">距离</div>
                    <div className="font-mono font-semibold">{servingSat.range}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">跟踪时长</div>
                    <div className="font-mono font-semibold">{servingSat.minutes.toFixed(1)} 分钟</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* 统计卡片 */}
          <div className="grid grid-cols-2 gap-3">
            <Card>
              <CardContent className="pt-6">
                <div className="text-xs text-muted-foreground">角距离 / 仰角</div>
                <div className="font-mono text-2xl font-bold text-foreground mt-1">
                  {servingSat?.separation || '—'} / {servingSat?.elevation.toFixed(1)}°
                </div>
                <div className="text-xs text-muted-foreground mt-1">与服务卫星 / 仰角</div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="text-xs text-muted-foreground">可见卫星数量</div>
                <div className="font-mono text-2xl font-bold text-foreground mt-1">
                  {stats.visible} <span className="text-sm text-muted-foreground">颗</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  平均仰角 {stats.avgElevation}°
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="text-xs text-muted-foreground">候选卫星</div>
                <div className="font-mono text-2xl font-bold text-sky-400 mt-1">
                  {runners.length} <span className="text-sm text-muted-foreground">颗</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1">角距离 &lt; 25°</div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="text-xs text-muted-foreground">不同轨道</div>
                <div className="font-mono text-2xl font-bold text-sky-400 mt-1">
                  {stats.distinct} <span className="text-sm text-muted-foreground">颗</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1">候选 + 服务</div>
              </CardContent>
            </Card>
          </div>

          {/* 候选卫星 */}
          {runners.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">候选卫星</CardTitle>
                <CardDescription>距离当前服务卫星最近的卫星</CardDescription>
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
                  卫星详情列表
                </span>
                <span className="text-xs text-muted-foreground font-mono">
                  按角距离排序
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground border-b border-border sticky top-0 bg-card">
                    <tr className="text-left">
                      <th className="py-2 font-medium">卫星名称 / NORAD</th>
                      <th className="font-medium">持续(分)</th>
                      <th className="font-medium">角距离</th>
                      <th className="font-medium">仰角</th>
                      <th className="font-medium">距离</th>
                      <th className="font-medium">首次观测</th>
                      <th className="font-medium">最近观测</th>
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
                                服务中
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