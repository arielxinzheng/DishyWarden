/**
 * 指标卡片迷你图的数据派生
 *
 * 只做一件事: HistorySample[] → 每张卡片要画的**数值序列**。
 * 不产出 SVG 字符串 —— 归一化到 viewBox 是卡片的渲染细节(见 MetricCard.tsx)。
 *
 * 为什么在这里抽稀而不是交给 SQL:
 *   时间范围最多 6h / 30s 采样 = 720 个点, 迷你图只有 100px 宽。
 *   查询侧的分桶是为了让主图刻度整齐, 迷你图要的是「形状」, 两者诉求不同,
 *   挪到展示层按卡片宽度决定密度更合理。
 *
 * ⚠️ 迷你图**刻意不做**断流留白(与 `dataGaps` 那套判据不同口径):
 *   24 个点铺满 6h 时一个点代表 15 分钟, 一段 31 分钟的断流会吃掉两个点,
 *   100px 宽的走势线中间空一截既不表达"缺了多久", 又让曲线看着像坏了。
 *   迷你图要的是趋势形状, 缺数据本来就是"少一个点" —— 只要不 `?? 0`
 *   兜底画成"延迟降到 0"就足够了(下面 `Number.isFinite` 那行就是干这个的)。
 */

import type { HistorySample } from '../../../storage/types';

/** 迷你图最多画多少个点 */
export const SERIES_LENGTH = 24;

/**
 * 相邻区间取均值降到目标长度。
 *
 * 用均值而不是跳步取样: 跳步会把丢包尖峰整片漏掉, 让走势图看起来比实际平稳。
 */
function downsample(values: number[], length: number): number[] {
  if (values.length <= length) return values;

  const bucket = values.length / length;
  const out: number[] = [];

  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * bucket);
    const end = Math.max(start + 1, Math.floor((i + 1) * bucket));

    let sum = 0;
    for (let j = start; j < end; j++) sum += values[j];
    out.push(sum / (end - start));
  }

  return out;
}

/** 抽出某条指标的序列并降到迷你图长度 */
function pick(history: HistorySample[], read: (sample: HistorySample) => number): number[] {
  const values: number[] = [];
  for (const sample of history) {
    const value = read(sample);
    // 非有限值(字段缺失/NaN)不能进序列, 否则归一化时整条线变 NaN
    if (Number.isFinite(value)) values.push(value);
  }
  return downsample(values, SERIES_LENGTH);
}

/** 六张指标卡片各自需要的数值序列 */
export interface MetricSeries {
  /**
   * 在线率序列 0..1(桶内 ONLINE 采样占比)。
   * 连接状态卡用它做走势 —— 这才是「连接状态」的时序。
   *
   * 数据来源: HistorySample.onlineRatio
   *   - 明细粒度: 1 或 0
   *   - 分桶粒度: 桶内占比
   *   - 小时聚合粒度: undefined(表里没存 state) -> 序列为空
   *
   * 没有可用数据时返回空数组, 卡片会画空白而不是编造。
   */
  availability: number[];
  /** 信号质量 snr。信号质量相关的展示用这条。 */
  snr: number[];
  latency: number[];
  drop: number[];
  down: number[];
  up: number[];
  obstruction: number[];
}

export function buildMetricSeries(history: HistorySample[]): MetricSeries {
  return {
    availability: pick(history, (s) => s.onlineRatio ?? Number.NaN),
    snr: pick(history, (s) => s.snr),
    latency: pick(history, (s) => s.popPingLatencyMs),
    drop: pick(history, (s) => s.popPingDropRate),
    down: pick(history, (s) => s.downlinkThroughputBps),
    up: pick(history, (s) => s.uplinkThroughputBps),
    obstruction: pick(history, (s) => s.fractionObstructed),
  };
}

/** 序列峰值, 空序列返回 null(调用方据此显示 —) */
export function peakOf(values: number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null;
}