/**
 * 指标卡片：一个大数值 + 一条迷你走势图。
 *
 * 纯展示组件。输入是**原始数值序列**（来自 metricSeries.ts），
 * 归一化到 100x32 的 viewBox 在这里做 —— 因为这是渲染细节，
 * 调用方只该关心「画哪条指标」，不该关心刻度。
 */

import { Card, CardContent } from '../ui/card';

export interface MetricCardProps {
  title: string;
  /** 主数值（已格式化，含单位） */
  value: string;
  /** 次要说明，通常是区间峰值或状态标签 */
  subtitle?: string;
  /** 圆点与线条颜色 */
  dotColor: string;
  chartType: 'area' | 'line' | 'bars';
  /** 数值序列，空数组时只画空白（保留高度，避免卡片跳动） */
  series?: number[];
  /**
   * 固定值域 [min, max]。
   *
   * 不给的话按序列自身的 min/max 归一化 —— 适合「波动幅度」有意义的指标
   * (延迟、吞吐)。但对在线率这种有绝对含义的指标(0=离线, 1=在线),
   * 自适应归一化会把「一直在线」画成一条居中的直线, 看起来像坏了。
   * 给定值域后, 1 永远在顶部, 0 永远在底部。
   */
  domain?: [number, number];
  /**
   * 自定义图表区域。
   *
   * 给的话**取代**内置的迷你走势图(不是叠加) —— 用于「连接状态」卡:
   * 它的语义是离散状态, 用折线表达不合适, 换成状态色块条。
   */
  children?: React.ReactNode;
  /**
   * 图例文本(左/右两端)。
   *
   * 六张卡**共用同一个图例行**(没给文字的卡渲染空占位),
   * 这样图表区的高度、底部基线、到卡片边缘的留白才能像素级一致 ——
   * 否则「连接状态」因为多一行文字, 底部就会比其他卡低一截,
   * 视线横扫时对不上位置。
   */
  legendLeft?: string;
  legendRight?: string;
  /**
   * 图表区的宽度基准 ref。
   *
   * 挂在**图表区基准层**上(不是图表元素自己) —— 状态条的宽度由块数决定,
   * 而块数又取决于宽度, 观察它会形成循环依赖。
   *
   * 用**回调 ref**而不是 RefObject: Dashboard 有 `if (!telemetry) return null`,
   * 首帧元素不存在, RefObject 版本会永远测不到(见 useElementWidth 的说明)。
   */
  chartAreaRef?: (node: HTMLDivElement | null) => void;
}

const VIEW_W = 100;
const VIEW_H = 32;

/**
 * 图表区高度(px) —— 六张卡**共用**。
 *
 * 「连接状态」的状态色块条是 flex <div> 实现的, 其他五张是 SVG。
 * 两者要落在同一条底部基线上, 高度必须一致, 否则视线横扫时会错位。
 * SVG 用 h-8 (=32px), 所以状态条也用 32。
 */
export const CHART_HEIGHT = 32;

/**
 * 数值序列 → polyline points
 * y 轴要翻转：值越大，y 越小（SVG 原点在左上）
 * 序列完全平坦时画中线，否则「没有波动」会被渲染成贴底或贴顶，看起来像坏了
 *
 * domain 给定时用固定值域, 不按序列自身 min/max 缩放。
 */
function toPoints(values: number[], domain?: [number, number]): string {
  const min = domain ? domain[0] : Math.min(...values);
  const max = domain ? domain[1] : Math.max(...values);
  const span = max - min;

  return values
    .map((value, i) => {
      const x = (i / (values.length - 1)) * VIEW_W;
      const y = span === 0 ? VIEW_H / 2 : VIEW_H - ((value - min) / span) * VIEW_H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** 数值序列 → 柱高（底部对齐，最高值占满 VIEW_H） */
function toBars(values: number[]): number[] {
  const max = Math.max(...values, 0);
  // 全 0 时给 2px 基线，否则图表区域空的像没加载
  if (max <= 0) return values.map(() => 2);
  return values.map((v) => Math.max(2, (v / max) * VIEW_H));
}

export function MetricCard({
  title, value, subtitle, dotColor, chartType, series, domain,
  children, legendLeft, legendRight, chartAreaRef,
}: MetricCardProps) {
  const points = series && series.length >= 2 ? toPoints(series, domain) : undefined;
  const bars = series && series.length > 0 ? toBars(series) : undefined;

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4 flex flex-col h-full">
        <div className="flex items-center gap-2 mb-2">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dotColor }} />
          <span className="text-xs font-semibold text-slate-300">{title}</span>
        </div>

        <div>
          <div className="mt-2 font-mono text-xl font-bold text-slate-100 leading-tight">{value}</div>
          {subtitle && <div className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</div>}
        </div>

        {/* 图表区 —— 外层 div 是**宽度基准**, 供父组件测量可用宽度。
            基准必须是这一层(宽度与内容无关), 不能是里面的图表元素
            (状态条的宽度由块数决定, 块数又由宽度决定 ⇒ 循环依赖)。 */}
        <div ref={chartAreaRef} className="w-full">
          {children ?? (
            <svg
              className="mt-3 w-full"
              style={{ height: CHART_HEIGHT }}
              viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
              preserveAspectRatio="none"
            >
            {chartType === 'area' && points && (
              <g>
                <polygon points={`0,${VIEW_H} ${points} ${VIEW_W},${VIEW_H}`} fill={dotColor} fillOpacity="0.15" />
                <polyline points={points} fill="none" stroke={dotColor} strokeWidth="1.5" />
              </g>
            )}

            {chartType === 'line' && points && (
              <polyline points={points} fill="none" stroke={dotColor} strokeWidth="1.5" />
            )}

            {chartType === 'bars' && bars && (
              <g>
                {bars.map((height, i) => {
                  const slot = VIEW_W / bars.length;
                  return (
                    <rect
                      key={i}
                      x={i * slot + 0.5}
                      y={VIEW_H - height}
                      width={Math.max(0.5, slot - 1)}
                      height={height}
                      fill={i % 2 ? '#a78bfa' : dotColor}
                    />
                  );
                })}
              </g>
            )}
            </svg>
          )}
        </div>

        {/* 图例行 —— 六张卡**共用**。
            没有文字的卡也渲染这一行(高度相同), 保证:
            - 图表区底部落在同一条基线上
            - 图表区到卡片底边的留白像素级一致
            没有这一行的话, 「连接状态」会比其他卡多占一行, 底部错位。 */}
        <div className="flex justify-between mt-1 h-[14px] text-[10px] text-slate-600/70">
          <span>{legendLeft}</span>
          <span>{legendRight}</span>
        </div>
      </CardContent>
    </Card>
  );
}