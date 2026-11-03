/**
 * Y 轴自适应取整的回归测试
 *
 * ## 规则
 *
 * 顶格 = 峰值向上取整到「整十/整百」，**最小值恒为 0**。
 *
 * | 峰值 | 顶格 | 刻度间隔 |
 * |---|---|---|
 * | 4ms | 10 | 2 |
 * | 13ms | 20 | 5 |
 * | 40ms | 50 | 10 |
 * | 90ms | 100 | 20 |
 * | 130ms | 200 | 50 |
 * | 450ms | 500 | 100 |
 * | 900ms | 1000 | 200 |
 *
 * ## 为什么要连间隔一起定
 *
 * ECharts 的 `IntervalScale` 用 `nice(span / splitNumber)` 决定刻度间隔，
 * 而 span = max - 0 = 顶格。**间隔是顶格的函数**。
 *
 * 动画途中 max 是连续变化的小数 ⇒ 间隔会一路跳 ⇒ 刻度整排重排。
 * 实测（echarts 5.6 SSR 渲染，10 → 50 的过渡）：
 *
 * ```
 *   max= 10   labels=[0, 2, 4, 6, 8, 10]      ← 间隔 2
 *   max= 14.5 labels=[0, 3, 6, 9, 12, 15]     ← 间隔 3，整排变了
 *   max= 20   labels=[0, 5, 10, 15, 20]       ← 间隔 5，整排变了
 * ```
 *
 * ⇒ 间隔跳 6 次（2→3→5→10→20→30→50）—— 那是闪烁，不是平滑拉伸。
 *
 * 所以：顶格与间隔**一起**定，且顶格必须是间隔的整数倍。
 */

import { describe, it, expect } from 'vitest';
import {
  computeLatencyAxisScale,
  computeLatencyAxisMax,
  computeLatencyAxisInterval,
  computeLatencyPeak,
  quantizeAxisMax,
} from './latencyAxis';

describe('computeLatencyAxisScale', () => {
  it('按阶梯取整顶格', () => {
    expect(computeLatencyAxisScale(4).max).toBe(10);
    expect(computeLatencyAxisScale(10).max).toBe(10);
    expect(computeLatencyAxisScale(11).max).toBe(20);
    expect(computeLatencyAxisScale(19).max).toBe(20);
    expect(computeLatencyAxisScale(21).max).toBe(50);
    expect(computeLatencyAxisScale(50).max).toBe(50);
    expect(computeLatencyAxisScale(51).max).toBe(100);
    expect(computeLatencyAxisScale(130).max).toBe(200);
    expect(computeLatencyAxisScale(450).max).toBe(500);
    expect(computeLatencyAxisScale(900).max).toBe(1000);
  });

  it('峰值突破 20ms 后顶格拉到 50ms', () => {
    // 用户给的例子: Local 峰值在 0-10ms 内波动时顶格锁 10/20,
    // 除非峰值突破 20ms, 才平滑拉伸到 50ms
    expect(computeLatencyAxisScale(19).max).toBe(20);
    expect(computeLatencyAxisScale(20).max).toBe(20);
    expect(computeLatencyAxisScale(20.1).max).toBe(50);
  });

  it('顶格永远 >= 10, 不会塌陷', () => {
    expect(computeLatencyAxisScale(0).max).toBe(10);
    expect(computeLatencyAxisScale(-5).max).toBe(10);
    expect(computeLatencyAxisScale(NaN).max).toBe(10);
    expect(computeLatencyAxisScale(Infinity).max).toBe(10);
  });

  it('顶格必须是刻度间隔的整数倍', () => {
    // 这是"顶边标签不重复 + 底部 0 标签不消失"的前提
    for (const peak of [1, 4, 9, 10, 13, 20, 21, 49, 50, 99, 100, 130, 450, 900, 1234]) {
      const s = computeLatencyAxisScale(peak);
      expect(s.max % s.interval).toBe(0);
    }
  });

  it('超过 1000ms 时按整百取整, 间隔同步放大', () => {
    const s = computeLatencyAxisScale(1234);
    expect(s.max % 100).toBe(0);
    expect(s.max).toBeGreaterThanOrEqual(1234);
    expect(s.max % s.interval).toBe(0);
  });
});

describe('computeLatencyAxisMax', () => {
  it('与 computeLatencyAxisScale 的 max 一致', () => {
    for (const peak of [0, 4, 13, 40, 90, 130, 450, 900, 1234]) {
      expect(computeLatencyAxisMax(peak)).toBe(computeLatencyAxisScale(peak).max);
    }
  });
});

describe('computeLatencyAxisInterval', () => {
  it('与 computeLatencyAxisScale 的 interval 一致', () => {
    // 落定时从 targetScale.interval 切到 targetScale.interval,
    // 若两者不一致, 切换瞬间刻度会跳一次
    for (const peak of [0, 4, 13, 40, 90, 130, 450, 900]) {
      const s = computeLatencyAxisScale(peak);
      expect(computeLatencyAxisInterval(s.max)).toBe(s.interval);
    }
  });
});

describe('computeLatencyPeak', () => {
  it('只算大于 0 的值（0 是"无数据"而不是"延迟为 0"）', () => {
    expect(computeLatencyPeak([0, 0, 4, 0, 2])).toBe(4);
    expect(computeLatencyPeak([0, 0, 0])).toBe(0);
    expect(computeLatencyPeak([])).toBe(0);
  });

  it('忽略 NaN / Infinity', () => {
    expect(computeLatencyPeak([NaN, 5, Infinity])).toBe(5);
  });
});

describe('quantizeAxisMax', () => {
  it('结果永远是间隔的整数倍', () => {
    for (const v of [10.4, 13.7, 27.2, 44.9, 63.1]) {
      expect(quantizeAxisMax(v, 5, 100) % 5).toBe(0);
    }
  });

  it('不会越过目标', () => {
    expect(quantizeAxisMax(38, 10, 50)).toBeLessThanOrEqual(50);
    expect(quantizeAxisMax(62, 10, 50)).toBeGreaterThanOrEqual(50);
  });

  it('接近目标时直接落定在目标上', () => {
    expect(quantizeAxisMax(48, 10, 50)).toBe(50);
    expect(quantizeAxisMax(52, 10, 50)).toBe(50);
  });

  it('永不越过目标（不会来回抖）', () => {
    // 向上
    for (const v of [10, 11, 19, 20, 29, 39, 45, 49, 50]) {
      expect(quantizeAxisMax(v, 10, 50)).toBeLessThanOrEqual(50);
    }
    // 向下
    for (const v of [50, 49, 41, 31, 21, 11, 10]) {
      expect(quantizeAxisMax(v, 10, 10)).toBeGreaterThanOrEqual(10);
    }
  });

  it('非法输入退回目标', () => {
    expect(quantizeAxisMax(NaN, 10, 50)).toBe(50);
    expect(quantizeAxisMax(30, 0, 50)).toBe(50);
  });

  it('动画推进是单调的（不会卡住不动）', () => {
    // 复刻组件的缓动: next = cur + (target-cur)*0.15, 再量化。
    // 若量化用"朝目标取整"而不是"取最近格点", 第一帧就会跳一整格,
    // 观感是瞬跳; 若用就近取整却把值卡死, 动画会永远走不完。
    const interval = 10;
    const target = 50;
    let anim = 10;
    const seen: number[] = [];
    for (let i = 0; i < 400; i++) {
      if (anim === target) break;
      const next = anim + (target - anim) * 0.15;
      anim = Math.abs(target - next) < 0.01 ? target : next;
      seen.push(quantizeAxisMax(anim, interval, target));
    }
    // 显示值必须单调上升（放大方向）
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
    // 最终必须精确落在目标上
    expect(seen[seen.length - 1]).toBe(target);
    // 且不能一步跳到终点（要有中间台阶 ⇒ 是"平滑阶梯"而非瞬跳）
    expect(seen[0]).toBeLessThan(target);
    expect(new Set(seen).size).toBeGreaterThan(1);
  });
});
