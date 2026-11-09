import { useDish } from '../hooks/useDish';
import { useMemo, useState, useEffect } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { ObstructionHemisphere } from '../components/Dashboard/ObstructionHemisphere';
import type { ObstructionEvent } from '../../storage/types';
import {
  OBSTRUCTION_LEVELS,
  OBSTRUCTION_LEVEL_COLORS,
  analyzeObstructionMap,
  classifyObstruction,
  assessObstructionImpact,
  describeObstructionAge,
  type CompassDirection,
} from '../lib/obstructionAnalysis';
import { LanguageSwitcher } from '../components/LanguageSwitcher';

/** 8 方位码 → 字典键（方位文案随语言变化，箭头符号本身与语言无关） */
const DIRECTION_LABEL_KEYS: Record<CompassDirection, string> = {
  N: 'obstruction:dir.n',
  NE: 'obstruction:dir.ne',
  E: 'obstruction:dir.e',
  SE: 'obstruction:dir.se',
  S: 'obstruction:dir.s',
  SW: 'obstruction:dir.sw',
  W: 'obstruction:dir.w',
  NW: 'obstruction:dir.nw',
};

/**
 * 障碍图页面
 * 显示星链天线视野中的障碍物分布
 * 123x123 网格，使用 Canvas 渲染热力图
 */
export default function ObstructionMap() {
  const { t } = useTranslation('obstruction');
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
  // 检出时间语义码 → 当前语言文案（分钟/小时/天带数量，unknown/just_now 不带）
  const age = obstruction ? describeObstructionAge(obstruction.timestamp) : null;
  const ageText = age ? t(age.labelKey, { count: age.count }) : null;
  const dominantDirection = stats?.dominantDirection ?? null;
  const dominantDirectionText = dominantDirection
    ? t(DIRECTION_LABEL_KEYS[dominantDirection])
    : null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-400">{t('obstruction:page.loading')}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="bg-red-900/20 border border-red-500 rounded-lg p-4">
          <p className="text-red-400">{t('obstruction:page.load_failed', { error })}</p>
        </div>
      </div>
    );
  }

  if (!mapData) {
    return (
      <div className="p-8">
        <div className="bg-yellow-900/20 border border-yellow-500 rounded-lg p-4">
          <p className="text-yellow-400">{t('obstruction:page.no_data_title')}</p>
          <p className="text-gray-400 text-sm mt-2">{t('obstruction:page.no_data_desc')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      {/* 页面标题 —— 投影方式说明在图表下方的「数据说明」里，这里不再重复 */}
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-3xl font-bold text-white">{t('obstruction:page.title')}</h1>

        {/* 全局语言切换（需求指定的「右上角」位置） */}
        <LanguageSwitcher variant="icon" />
      </div>

      {/* 数据来源与新鲜度 —— 模拟图和实测图视觉几乎一样, 必须标出来 */}
      <div className={`rounded-lg border px-4 py-3 text-sm ${
        isReal
          ? 'border-green-500/40 bg-green-900/20 text-green-300'
          : 'border-yellow-500/40 bg-yellow-900/20 text-yellow-300'
      }`}>
        {source === 'real' ? (
          <>
            {t('obstruction:source.real')}
            {ageText ? t('obstruction:source.age_suffix', { age: ageText }) : ''}
          </>
        ) : (
          <>{t('obstruction:source.mock')}</>
        )}
      </div>

      {/* 统计卡片 */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <StatCard
            label={t('obstruction:stat.total_pixels')}
            value={stats.totalPixels.toLocaleString()}
            color="blue"
          />
          <StatCard
            label={t('obstruction:stat.obstructed_pixels')}
            value={stats.obstructedPixels.toLocaleString()}
            color="orange"
          />
          <StatCard
            label={t('obstruction:stat.obstruction_pct')}
            value={`${(stats.obstructionPercentage * 100).toFixed(2)}%`}
            color={stats.obstructionPercentage > 0.10 ? 'red' : 'green'}
          />
          <StatCard
            label={t('obstruction:stat.max_obstruction')}
            value={stats.maxObstruction.toFixed(2)}
            // 颜色跟 3D 图的四色分级同源：灰/绿 = 未达遮挡线，橙 = 部分，红 = 挡死。
            // 不再固定用紫色 —— 数值本身就该传达严重程度。
            color={
              classifyObstruction(stats.maxObstruction) === 'blocked'
                ? 'red'
                : classifyObstruction(stats.maxObstruction) === 'partial'
                  ? 'orange'
                  : 'green'
            }
            tooltip={
              <>
                <p>
                  <Trans
                    i18nKey="obstruction:tip.scale"
                    components={{ strong: <strong className="text-gray-100" /> }}
                  />
                </p>
                <p className="mt-1">{t('obstruction:tip.extremes')}</p>
                <p className="mt-1.5 text-gray-400">
                  <Trans
                    i18nKey="obstruction:tip.compare"
                    components={{ strong: <strong className="text-gray-200" /> }}
                  />
                </p>
                <p className="mt-1.5 text-gray-500">
                  {t('obstruction:tip.threshold', {
                    clearMax: OBSTRUCTION_LEVELS.clearMax.toFixed(2),
                    partialMax: OBSTRUCTION_LEVELS.partialMax.toFixed(2),
                  })}
                </p>
              </>
            }
          />
        </div>
      )}

      {/* 方向与影响 —— 只在真实数据上给 */}
      {stats && source === 'real' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <StatCard
            label={t('obstruction:stat.direction')}
            value={
              dominantDirection && stats.dominantAzimuth !== null
                ? `${azimuthArrow(stats.dominantAzimuth)} ${dominantDirectionText ?? ''}`
                : t('obstruction:direction.none')
            }
            color="blue"
            hint={
              dominantDirection
                ? t('obstruction:direction.hint', { deg: stats.dominantAzimuth?.toFixed(0) })
                : t('obstruction:direction.hint_uniform')
            }
          />
          <StatCard
            label={t('obstruction:stat.impact')}
            value={impact ? t(impact.labelKey) : '—'}
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
          // 页面下方自带图例（与本页四色分级同源），半球组件不再重复画一条
          showLegend={false}
          highlight={
            stats?.dominantAzimuth !== null && stats?.dominantAzimuth !== undefined
              ? { azimuth: stats.dominantAzimuth, text: dominantDirectionText ?? '' }
              : null
          }
        />
      </div>

      {/* 图例 */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-white mb-4">{t('obstruction:data_notes.title')}</h3>
        <p className="text-gray-400 text-sm">
          {t('obstruction:data_notes.body', {
            clearMax: OBSTRUCTION_LEVELS.clearMax.toFixed(2),
            partialMax: OBSTRUCTION_LEVELS.partialMax.toFixed(2),
          })}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          {(['unmapped', 'clear', 'partial', 'blocked'] as const).map((level) => (
            <span key={level} className="flex items-center gap-2 text-gray-400">
              <span className={`w-3 h-3 rounded-full ${OBSTRUCTION_LEVEL_COLORS[level].dot}`} />
              {t(OBSTRUCTION_LEVEL_COLORS[level].labelKey)}
            </span>
          ))}
        </div>
      </div>

      {/* 遮挡历史时间轴 */}
      {window.electronAPI && (
        <div className="bg-gray-800 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-white mb-4">{t('obstruction:events.title')}</h3>

          {eventsLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
          ) : obstructionEvents.length === 0 ? (
            <p className="text-gray-400 text-sm">{t('obstruction:events.empty')}</p>
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
  /** 悬停/聚焦时展开的名词解释气泡 */
  tooltip?: React.ReactNode;
}

function StatCard({ label, value, color, hint, tooltip }: StatCardProps) {
  const colorClasses = {
    blue: 'bg-blue-900/20 border-blue-500 text-blue-400',
    green: 'bg-green-900/20 border-green-500 text-green-400',
    orange: 'bg-orange-900/20 border-orange-500 text-orange-400',
    red: 'bg-red-900/20 border-red-500 text-red-400',
    purple: 'bg-purple-900/20 border-purple-500 text-purple-400',
  };

  return (
    <div className={`rounded-lg border p-4 ${colorClasses[color]}`}>
      {tooltip ? (
        <InfoLabel text={label} tooltip={tooltip} />
      ) : (
        <p className="text-sm opacity-80 mb-1">{label}</p>
      )}
      <p className="text-2xl font-bold">{value}</p>
      {hint && <p className="text-[11px] opacity-70 mt-1">{hint}</p>}
    </div>
  );
}

/**
 * 带释义气泡的标签。
 *
 * ## 为什么不用原生 `title`
 *
 * Electron/Chromium 里原生 title 有约 1 秒延迟、样式完全不可控，
 * 而且这个项目里已经踩过「Electron 里根本不弹」的坑（见 StatusTooltip 头注释）。
 * 这里用纯 CSS 的 hover/focus 浮层：零状态、零 portal，键盘 Tab 聚焦也能看到。
 *
 * ## 两重提示
 *
 * 虚线底边 + 小 (i) 图标 —— SaaS 里「可悬浮查看释义」的标准范式；
 * 任何一个都足以暗示可交互，两个同时出现是为了在深色低对比背景下更明显。
 */
function InfoLabel({ text, tooltip }: { text: string; tooltip: React.ReactNode }) {
  return (
    <div
      className="group/label relative inline-flex items-center gap-1 rounded-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
      tabIndex={0}
      aria-describedby="obstruction-max-tooltip"
    >
      <span className="text-sm opacity-80 border-b border-dotted border-white/35 pb-0.5 cursor-help">
        {text}
      </span>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="w-3.5 h-3.5 opacity-60 cursor-help"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 16.5v-4.8M12 7.8v.6" strokeLinecap="round" />
      </svg>

      {/* 浮层：右对齐，避免在 4 列网格的最后一列溢出视口 */}
      <div
        id="obstruction-max-tooltip"
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full z-30 mt-2 hidden w-72 rounded-lg border border-gray-600/80 bg-gray-950/95 px-3 py-2.5 text-[11.5px] font-normal leading-relaxed text-gray-300 shadow-xl backdrop-blur-sm group-hover/label:block group-focus/label:block"
      >
        {tooltip}
      </div>
    </div>
  );
}

// 遮挡事件卡片组件
interface ObstructionEventCardProps {
  event: ObstructionEvent;
}

function ObstructionEventCard({ event }: ObstructionEventCardProps) {
  const { t, i18n } = useTranslation('obstruction');

  // 日期跟随当前语言（原来固定 zh-CN，切到英文时会出现中文日期顺序）
  const formatDate = (ts: number) => {
    const date = new Date(ts);
    return date.toLocaleString(i18n.language, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return t('obstruction:duration.seconds', { count: seconds });
    if (seconds < 3600) {
      return t('obstruction:duration.minutes', { count: Math.floor(seconds / 60) });
    }
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return mins > 0
      ? t('obstruction:duration.hours_minutes', { count: hours, mins })
      : t('obstruction:duration.hours', { count: hours });
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
      label: t('obstruction:event.severity_low'),
      labelColor: 'text-gray-400',
    },
    medium: {
      card: 'border-warning-orange/40 bg-warning-orange/5',
      bar: 'bg-warning-orange',
      label: t('obstruction:event.severity_medium'),
      labelColor: 'text-warning-orange',
    },
    high: {
      card: 'border-danger-red/50 bg-danger-red/10',
      bar: 'bg-danger-red',
      label: t('obstruction:event.severity_high'),
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
              {t('obstruction:event.duration', { duration: formatDuration(event.durationSec) })}
            </span>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-gray-400">
              {t('obstruction:event.avg_obstruction', {
                value: (event.avgFractionObstructed * 100).toFixed(1),
              })}
            </span>
            <span className="text-gray-400">
              {t('obstruction:event.peak', { value: (peak * 100).toFixed(1) })}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
