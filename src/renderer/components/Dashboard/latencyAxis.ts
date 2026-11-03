/**
 * Y 轴自适应取整
 *
 * ## 为什么需要
 *
 * 延迟卡片原本是**硬编码** `min: 20, max: 100`。两个问题：
 *
 * 1. **Local 模式下折线被压在图底** —— 峰值 4ms 的数据在 0~100 的量程里
 *    只占 4% 高度，**完全看不出波动**，用户以为"网关延迟一直是 0"。
 * 2. **最小值不是 0** —— `min: 20` 意味着图的底部是 20ms 而不是 0，
 *    视觉上会暗示"延迟从来没低于 20ms"，与事实不符。
 *
 * ## 取整规则
 *
 * 顶格 = ceil(峰值) 到「整十 / 整百」，**最小值恒为 0**。
 *
 * 阶梯（这样峰值在 0~10ms 内波动时，顶格死死锁在 10，不会抖）：
 *
 * | 峰值区间 | 顶格 | 刻度间隔 |
 * |---|---|---|
 * | (0, 10]   | 10   | 2  |
 * | (10, 20]  | 20   | 5  |
 * | (20, 50]  | 50   | 10 |
 * | (50, 100] | 100  | 20 |
 * | (100, 200]| 200  | 50 |
 * | (200, 500]| 500  | 100 |
 * | (500, 1000]| 1000 | 200 |
 * | > 1000    | 见下 | 见下 |
 *
 * **阶梯而不是纯 ceil(峰值/10)*10**：纯 ceil 会让顶格在 10→20→30 之间
 * 频繁跳动（峰值 19.9ms 给 20、20.1ms 给 30），标签看着在抖。
 * 阶梯把"常用量程"锚定住，峰值要**突破**一个档位才拉伸。
 *
 * 例：峰值 4ms → 10；峰值 19ms → 20；峰值 21ms → 50；
 *     峰值 999ms → 1000；峰值 1234ms → 1400。
 *
 * ## ⚠️ 刻度间隔为什么也要一起定
 *
 * ECharts 的 `IntervalScale` 用 `nice(span / splitNumber)` 决定刻度间隔，
 * span = max - 0 = 顶格。**所以间隔是顶格的函数** —— 顶格一变，
 * 间隔就跳，刻度整排重排。
 *
 * 实测（echarts 5.6 SSR 渲染，10 → 50 的过渡）：
 *
 * ```
 *   max= 10   labels=[0, 2, 4, 6, 8, 10]      ← 间隔 2
 *   max= 14.5 labels=[0, 3, 6, 9, 12, 15]     ← 间隔 3，整排变了
 *   max= 20   labels=[0, 5, 10, 15, 20]       ← 间隔 5，整排变了
 *   max= 38   labels=[0, 10, 20, 30, 38]      ← 间隔 10，整排变了
 * ```
 *
 * ⇒ **过渡途中刻度间隔跳 6 次**（2→3→5→10→20→30→50），
 * 标签反复重排 —— 这不是"平滑拉伸"，是闪烁。
 *
 * 解法：**过渡期间把间隔钉死**，并让动画中的顶格始终落在间隔的整数倍上。
 * 这样内部网格线原地不动，只有顶边在移动 —— 才是真正的平滑拉伸。
 */

/** 顶格阶梯（升序）。 */
const Y_MAX_STEPS = [10, 20, 50, 100, 200, 500, 1000];

/**
 * 每个阶梯配套的刻度间隔。
 *
 * ⚠️ **必须保证 `Y_MAX_STEPS[i] % Y_MAX_INTERVALS[i] === 0`** ——
 * 顶格是间隔的整数倍，过渡时量化出来的每一格都落在刻度线上，
 * 顶边标签因此永远是干净的整数（不会出现 13 / 17 这种）。
 */
const Y_MAX_INTERVALS = [2, 5, 10, 20, 50, 100, 200];

/** 一个刻度间隔 + 顶格的配套结果 */
export interface LatencyAxisScale {
  /** Y 轴最大值（顶格） */
  max: number;
  /** 刻度间隔 —— max 一定是 interval 的整数倍 */
  interval: number;
}

/**
 * 根据数据峰值算出 Y 轴的顶格与刻度间隔。
 *
 * @param peak 可见数据的峰值（延迟 ms）
 */
export function computeLatencyAxisScale(peak: number): LatencyAxisScale {
  // 非法/空数据 ⇒ 用最小阶梯, 避免出现 max: 0 导致轴塌陷
  if (!Number.isFinite(peak) || peak <= 0) {
    return { max: Y_MAX_STEPS[0], interval: Y_MAX_INTERVALS[0] };
  }

  for (let i = 0; i < Y_MAX_STEPS.length; i++) {
    if (peak <= Y_MAX_STEPS[i]) {
      return { max: Y_MAX_STEPS[i], interval: Y_MAX_INTERVALS[i] };
    }
  }

  // 超过 1000 ⇒ 间隔取 100 的倍数, 顶格取该间隔的整数倍（仍是整百/整千）
  const interval = 100 * Math.ceil(peak / 1000);
  const max = interval * Math.ceil(peak / interval);
  return { max, interval };
}

/**
 * 根据数据峰值算出 Y 轴顶格（只要 max 的场景）。
 *
 * @param peak 可见数据的峰值（延迟 ms）
 * @returns Y 轴最大值（恒 >= 10）
 */
export function computeLatencyAxisMax(peak: number): number {
  return computeLatencyAxisScale(peak).max;
}

/**
 * 根据**顶格**反推刻度间隔。
 *
 * 与 `computeLatencyAxisScale` 保持一致 —— 给定同一个 max，
 * 两者算出的 interval 必须相同（否则过渡落定时会跳一次）。
 *
 * @param max Y 轴顶格
 */
export function computeLatencyAxisInterval(max: number): number {
  if (!Number.isFinite(max) || max <= 0) {
    return Y_MAX_INTERVALS[0];
  }
  for (let i = 0; i < Y_MAX_STEPS.length; i++) {
    if (max <= Y_MAX_STEPS[i]) {
      return Y_MAX_INTERVALS[i];
    }
  }
  return 100 * Math.ceil(max / 1000);
}

/**
 * 算可见数据的峰值。
 *
 * ⚠️ **只算真正可见的那些点** —— 分桶/聚合后的数据里可能有 0 值占位
 * （没有数据的桶），把它们算进峰值会让 Y 轴被拉高。
 * 这里只取大于 0 的值参与峰值计算（0 是"无数据"而不是"延迟为 0"）。
 *
 * @param values 延迟序列
 * @returns 峰值（ms）；没有有效值时返回 0
 */
export function computeLatencyPeak(values: number[]): number {
  let peak = 0;
  for (const v of values) {
    if (Number.isFinite(v) && v > peak) peak = v;
  }
  return peak;
}

/**
 * 把动画中的顶格量化到刻度间隔的整数倍上。
 *
 * 为什么要量化：动画期间 `max` 是连续变化的小数（如 37.4），
 * 而**顶边本身就是一个刻度**（ECharts 会把 extent[1] 加进刻度列表）。
 * 不量化的话顶边标签就会显示 13 / 17 / 23 这种过渡期的碎片数字，
 * 还会出现顶部标签重复、缩小方向丢失 0 标签。
 *
 * 量化后顶边只会取 20 / 30 / 40 / 50 这样的整刻度值 ——
 * 标签始终干净，且网格线不会重排。
 *
 * @param value 当前动画值
 * @param interval 钉死的刻度间隔
 * @param target 目标顶格（保证最终**精确**落在目标上，不被量化误差带偏）
 */
export function quantizeAxisMax(value: number, interval: number, target: number): number {
  if (!Number.isFinite(value) || interval <= 0) return target;
  if (!Number.isFinite(target)) return value;

  const goingUp = target > value;

  // ⚠️ 阈值用 `interval / 2` ——
  //   量化到的是**最近的格点**, 所以进入半格范围就该落定。
  //   若用整个 interval, 目标前最后一格永远到不了(会被立刻判为"已到位")。
  if (Math.abs(target - value) <= interval / 2) return target;

  // ⚠️ **取最近的格点**, 而不是"朝目标方向的下一格" ——
  //   用 ceil/floor 朝目标取整会**立刻跳一整格**:
  //   实测 10→50 的过渡变成 1帧→3帧→4帧→44帧 —— 第一下是瞬跳, 后面又长尾。
  //   取最近格点则是: 缓动曲线走到哪, 显示值就跟到哪,
  //   每级停留帧数随曲线自然分布(前半段慢、后半段快), 观感是平滑的阶梯。
  //
  //   ⚠️ 但「最近」必须保证**不越过目标** ——
  //   否则会冲过目标再被拉回来, 出现抖动。
  const nearest = Math.round(value / interval) * interval;
  const clamped = goingUp ? Math.min(nearest, target) : Math.max(nearest, target);

  // 兜底: 永远返回一个间隔的整数倍 —— 这是"顶边不重复、0 不消失"的前提。
  //        ECharts 会把 extent[1](顶边)额外塞进刻度列表,
  //        若顶边不在格点上, 就会出现 [0,2,...,10,**10**] 这样的重复标签,
  //        或缩小方向上的 [**2**,4,...,170](丢了 0)。
  const onGrid = Math.round(clamped / interval) * interval;
  return goingUp ? Math.min(onGrid, target) : Math.max(onGrid, target);
}
