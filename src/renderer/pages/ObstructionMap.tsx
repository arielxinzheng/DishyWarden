import { useDish } from '../hooks/useDish';
import { useMemo, useState, useEffect } from 'react';
import { ObstructionHemisphere } from '../components/Dashboard/ObstructionHemisphere';
import type { ObstructionEvent } from '../../storage/types';
import {
  OBSTRUCTION_LEVELS,
  OBSTRUCTION_LEVEL_COLORS,
  analyzeObstructionMap,
  assessObstructionImpact,
  describeObstructionAge,
} from '../lib/obstructionAnalysis';

/**
 * 障碍图页面
 * 显示星链天线视野中的障碍物分布
 * 123x123 网格，使用 Canvas 渲染热力图
 */
export default function ObstructionMap() {
  const { telemetry, isLoading, error, obstruction } = useDish();
  const [obstructionEvents, setObstructionEvents] = useState<ObstructionEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  // 加载过去 7 天的遮挡事件历史（最小持续时长 60 秒）
  useEffect(() => {
    const loadEvents = async () => {
      if (typeof window === 'undefined' || !window.electronAPI) {
        return; // 浏览器环境降级，不显示历史
      }

      setEventsLoading(true);
      try {
        const now = Date.now();
        const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
        const events = await window.electronAPI.getObstructionEvents(sevenDaysAgo, now, 20);
        setObstructionEvents(events);
      } catch (err) {
        console.error('Failed to load obstruction events:', err);
      } finally {
        setEventsLoading(false);
      }
    };

    loadEvents();
  }, []);

  // 优先用主进程存的实测遮挡图, 拿不到才降级到遥测里带的
  // 注意: 两者都可能是模拟数据, 所以 source 必须跟着走 —— 不能假定是真实
  const mapData = obstruction?.data ?? telemetry?.obstructionMap ?? null;
  const isReal = obstruction?.source === 'real';
  // 遥测里带的图没有独立来源标记, 保守当作 mock
  const source: 'real' | 'mock' = obstruction ? (obstruction.source === 'real' ? 'real' : 'mock') : 'mock';

  // 计算障碍统计信息
  const stats = useMemo(() => {
    if (!mapData) return null;
    return analyzeObstructionMap(mapData);
  }, [mapData]);

  const impact = stats ? assessObstructionImpact(stats.obstructionPercentage) : null;
  const ageText = obstruction ? describeObstructionAge(obstruction.timestamp) : null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-400">加载障碍图数据...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="bg-red-900/20 border border-red-500 rounded-lg p-4">
          <p className="text-red-400">加载失败: {error}</p>
        </div>
      </div>
    );
  }

  if (!mapData) {
    return (
      <div className="p-8">
        <div className="bg-yellow-900/20 border border-yellow-500 rounded-lg p-4">
          <p className="text-yellow-400">暂无障碍图数据</p>
          <p className="text-gray-400 text-sm mt-2">
            设备尚未返回视野遮挡图。恢复连接后会自动显示。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      {/* 页面标题 —— 投影方式说明在图表下方的「数据说明」里，这里不再重复 */}
      <div>
        <h1 className="text-3xl font-bold text-white">Obstructions / 障碍图</h1>
      </div>

      {/* 数据来源与新鲜度 —— 模拟图和实测图视觉几乎一样, 必须标出来 */}
      <div className={`rounded-lg border px-4 py-3 text-sm ${
        isReal
          ? 'border-green-500/40 bg-green-900/20 text-green-300'
          : 'border-yellow-500/40 bg-yellow-900/20 text-yellow-300'
      }`}>
        {source === 'real' ? (
          <>设备实测遮挡图{ageText ? ` · ${ageText}` : ''}</>
        ) : (
          <>当前显示模拟数据（非设备实测）。设备返回遮挡图后会自动切换。</>
        )}
      </div>

      {/* 统计卡片 */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <StatCard
            label="总像素数"
            value={stats.totalPixels.toLocaleString()}
            color="blue"
          />
          <StatCard
            label="障碍像素"
            value={stats.obstructedPixels.toLocaleString()}
            color="orange"
          />
          <StatCard
            label="视野遮挡占比"
            value={`${(stats.obstructionPercentage * 100).toFixed(2)}%`}
            color={stats.obstructionPercentage > 0.10 ? 'red' : 'green'}
          />
          <StatCard
            label="最大遮挡度"
            value={stats.maxObstruction.toFixed(2)}
            color="purple"
          />
        </div>
      )}

      {/* 方向与影响 —— 只在真实数据上给 */}
      {stats && source === 'real' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <StatCard
            label="主遮挡方向"
            value={
              stats.dominantDirection && stats.dominantAzimuth !== null
                ? `${azimuthArrow(stats.dominantAzimuth)} ${stats.dominantDirection}`
                : '无明显遮挡'
            }
            color="blue"
            hint={
              stats.dominantDirection
                ? `方位角约 ${stats.dominantAzimuth?.toFixed(0)}°（相对天线朝向）`
                : '遮挡在视野内分布均匀，没有占主导的方位'
            }
          />
          <StatCard
            label="影响评估"
            value={impact?.label ?? '—'}
            color={impact?.color === 'text-danger-red' ? 'red' : impact?.color === 'text-warning-orange' ? 'orange' : 'green'}
          />
        </div>
      )}

      {/* 障碍图可视化 */}
      <div className="bg-gray-800 rounded-lg overflow-hidden flex justify-center py-6">
        <ObstructionHemisphere
          data={mapData}
          width={700}
          height={550}
          showLegend={true}
          highlight={
            stats?.dominantAzimuth !== null && stats?.dominantAzimuth !== undefined
              ? { azimuth: stats.dominantAzimuth, text: stats.dominantDirection ?? '' }
              : null
          }
        />
      </div>

      {/* 图例 */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-white mb-4">数据说明</h3>
        <p className="text-gray-400 text-sm">
          此视图使用 3D 半球形透视投影显示天线视野。中心代表天顶（正上方），边缘代表地平线。
          颜色分级与上方「视野遮挡占比」使用同一套判据（归一化遮挡度 ≤ {OBSTRUCTION_LEVELS.clearMax.toFixed(2)} 记作无遮挡，
          超过 {OBSTRUCTION_LEVELS.partialMax.toFixed(2)} 记作完全遮挡），所以红/橙面积与占比数字一定对得上。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          {(['unmapped', 'clear', 'partial', 'blocked'] as const).map((level) => (
            <span key={level} className="flex items-center gap-2 text-gray-400">
              <span className={`w-3 h-3 rounded-full ${OBSTRUCTION_LEVEL_COLORS[level].dot}`} />
              {OBSTRUCTION_LEVEL_COLORS[level].zh}
              <span className="text-gray-600">· {OBSTRUCTION_LEVEL_COLORS[level].label}</span>
            </span>
          ))}
        </div>
      </div>

      {/* 遮挡历史时间轴 */}
      {window.electronAPI && (
        <div className="bg-gray-800 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-white mb-4">遮挡事件历史（最近 7 天）</h3>
          
          {eventsLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
          ) : obstructionEvents.length === 0 ? (
            <p className="text-gray-400 text-sm">过去 7 天无遮挡事件记录</p>
          ) : (
            <div className="space-y-3">
              {obstructionEvents.map((event, idx) => (
                <ObstructionEventCard key={idx} event={event} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 方位角 → 指向该方位的箭头（8 方向，0=北，顺时针） */
function azimuthArrow(azimuthDeg: number): string {
  const arrows = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
  const idx = Math.round((((azimuthDeg % 360) + 360) % 360) / 45) % 8;
  return arrows[idx];
}

// 统计卡片组件
interface StatCardProps {
  label: string;
  value: string;
  color: 'blue' | 'green' | 'orange' | 'red' | 'purple';
  /** 补充说明（工具提示级别，不抢主数值） */
  hint?: string;
}

function StatCard({ label, value, color, hint }: StatCardProps) {
  const colorClasses = {
    blue: 'bg-blue-900/20 border-blue-500 text-blue-400',
    green: 'bg-green-900/20 border-green-500 text-green-400',
    orange: 'bg-orange-900/20 border-orange-500 text-orange-400',
    red: 'bg-red-900/20 border-red-500 text-red-400',
    purple: 'bg-purple-900/20 border-purple-500 text-purple-400',
  };

  return (
    <div className={`rounded-lg border p-4 ${colorClasses[color]}`}>
      <p className="text-sm opacity-80 mb-1">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
      {hint && <p className="text-[11px] opacity-70 mt-1">{hint}</p>}
    </div>
  );
}

// 遮挡事件卡片组件
interface ObstructionEventCardProps {
  event: ObstructionEvent;
}

function ObstructionEventCard({ event }: ObstructionEventCardProps) {
  const formatDate = (ts: number) => {
    const date = new Date(ts);
    return date.toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return mins > 0 ? `${hours}小时${mins}分钟` : `${hours}小时`;
  };

  /**
   * 严重程度只由**遮挡率**决定，不掺时长。
   *
   * 老版本把 durationSec 也当成判据（>600s 就标橙），结果一次 10 分钟、
   * 峰值仅 1.5% 的轻微遮挡也会被涂成醒目橙色 —— 整列都在预警，等于没有预警。
   * 时长放右侧做副信息即可。
   *
   * 阈值与 assessObstructionImpact 对齐: <2% 无影响, <10% 中等, ≥10% 严重。
   */
  const peak = event.maxFractionObstructed ?? 0;
  const severity: 'low' | 'medium' | 'high' =
    peak >= 0.10 ? 'high' : peak >= 0.02 ? 'medium' : 'low';

  // 轻微事件保持中性，只给严重事件上色 —— 让用户能扫出真正的故障
  const severityStyle = {
    low: {
      card: 'border-gray-700/60 bg-gray-900/30',
      bar: 'bg-gray-600',
      label: '轻微',
      labelColor: 'text-gray-400',
    },
    medium: {
      card: 'border-warning-orange/40 bg-warning-orange/5',
      bar: 'bg-warning-orange',
      label: '中等',
      labelColor: 'text-warning-orange',
    },
    high: {
      card: 'border-danger-red/50 bg-danger-red/10',
      bar: 'bg-danger-red',
      label: '严重',
      labelColor: 'text-danger-red',
    },
  }[severity];

  return (
    <div className={`relative overflow-hidden rounded-lg border p-4 pl-5 ${severityStyle.card}`}>
      {/* 左侧状态条：一眼扫到严重事件 */}
      <span className={`absolute left-0 top-0 bottom-0 w-1 ${severityStyle.bar}`} />
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2 flex-wrap">
            <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded border border-current/30 ${severityStyle.labelColor}`}>
              {severityStyle.label}
            </span>
            <span className="text-white font-medium">
              {formatDate(event.startTs)} - {formatDate(event.endTs)}
            </span>
            <span className="text-sm text-gray-400">
              持续 {formatDuration(event.durationSec)}
            </span>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-gray-400">
              平均遮挡率: <span className="text-white font-medium">{(event.avgFractionObstructed * 100).toFixed(1)}%</span>
            </span>
            <span className="text-gray-400">
              峰值: <span className="text-white font-medium">{(peak * 100).toFixed(1)}%</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

