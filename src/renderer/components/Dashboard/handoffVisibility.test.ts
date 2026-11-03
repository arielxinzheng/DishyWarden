/**
 * 卫星切换标记可见性规则的回归测试
 *
 * ## 三层判据
 *
 * | 层 | 判据 | 关掉的条件 |
 * |---|---|---|
 * | ① 延迟维度 | `showsSatelliteHandoffs(mode)` | Local(网关)模式 |
 * | ② 时间范围 | `handoffsVisibleByDefault(range)` | 1H / 6H |
 * | ③ 用户手动 | `overrides[range]` | 用户在该范围点过图例 |
 *
 * ## 需求
 *
 * - 15m(全局默认状态)→ 图例高亮, 卫星切换**开启**
 * - 1H / 6H → 图例关闭, 卫星切换**关闭**
 * - 点图例能切换显隐(立刻见效)
 * - 手动选择**按范围分别记忆** —— 在 15m 里点过不影响 1H 的默认值,
 *   但切回 15m 时还记得用户的选择
 */

import { describe, it, expect } from 'vitest';
import {
  handoffsVisibleByDefault,
  resolveHandoffsVisible,
  toggleHandoffsVisible,
  withToggledOverride,
  type HandoffOverrides,
  type TimeRangeKey,
} from './handoffVisibility';
import { showsSatelliteHandoffs, type LatencyMode } from './latencyModes';

describe('handoffsVisibleByDefault', () => {
  it('15m 开启', () => {
    expect(handoffsVisibleByDefault('15m')).toBe(true);
  });

  it('1H / 6H 关闭', () => {
    expect(handoffsVisibleByDefault('1h')).toBe(false);
    expect(handoffsVisibleByDefault('6h')).toBe(false);
  });
});

describe('resolveHandoffsVisible', () => {
  it('该范围没点过时用它的默认值', () => {
    expect(resolveHandoffsVisible('15m', {})).toBe(true);
    expect(resolveHandoffsVisible('1h', {})).toBe(false);
    expect(resolveHandoffsVisible('6h', {})).toBe(false);
  });

  it('该范围点过时用用户的选择', () => {
    expect(resolveHandoffsVisible('15m', { '15m': false })).toBe(false);
    expect(resolveHandoffsVisible('1h', { '1h': true })).toBe(true);
  });

  it('只影响该范围, 不波及其他范围', () => {
    const overrides: HandoffOverrides = { '15m': false };
    // 15m 被用户关了, 但 1h/6h 仍是各自的默认值
    expect(resolveHandoffsVisible('15m', overrides)).toBe(false);
    expect(resolveHandoffsVisible('1h', overrides)).toBe(false);
    expect(resolveHandoffsVisible('6h', overrides)).toBe(false);
  });
});

describe('toggleHandoffsVisible', () => {
  it('是切换语义', () => {
    expect(toggleHandoffsVisible(true)).toBe(false);
    expect(toggleHandoffsVisible(false)).toBe(true);
  });

  it('连点两次回到原值', () => {
    expect(toggleHandoffsVisible(toggleHandoffsVisible(true))).toBe(true);
  });
});

describe('withToggledOverride', () => {
  it('记录该范围的新值', () => {
    const next = withToggledOverride({}, '15m', true);
    expect(next['15m']).toBe(false);
  });

  it('不影响其他范围的记录', () => {
    let overrides: HandoffOverrides = { '1h': true };
    overrides = withToggledOverride(overrides, '15m', true);
    expect(overrides['1h']).toBe(true);
    expect(overrides['15m']).toBe(false);
  });

  it('不原地修改入参(React state 比较依赖新引用)', () => {
    const original: HandoffOverrides = { '15m': true };
    const next = withToggledOverride(original, '15m', true);
    expect(next).not.toBe(original);
    expect(original['15m']).toBe(true);
  });

  it('连点两次回到原状态', () => {
    let o: HandoffOverrides = {};
    o = withToggledOverride(o, '15m', true);   // 关
    o = withToggledOverride(o, '15m', false);  // 再开
    expect(resolveHandoffsVisible('15m', o)).toBe(true);
  });
});

describe('三层判据的组合', () => {
  /** 复刻组件里的 `showHandoffSeries` 判据 */
  const showSeries = (
    mode: LatencyMode,
    range: TimeRangeKey,
    overrides: HandoffOverrides,
  ) => showsSatelliteHandoffs(mode) && resolveHandoffsVisible(range, overrides);

  it('Local 模式永远不显示, 任何时间范围、任何用户选择', () => {
    for (const range of ['15m', '1h', '6h'] as TimeRangeKey[]) {
      for (const o of [{}, { '15m': true }, { '1h': true }, { '6h': true }]) {
        expect(showSeries('gateway', range, o)).toBe(false);
      }
    }
  });

  it('PoP / Public: 15m 默认显示, 1H/6H 默认关闭', () => {
    for (const mode of ['pop', 'public'] as LatencyMode[]) {
      expect(showSeries(mode, '15m', {})).toBe(true);
      expect(showSeries(mode, '1h', {})).toBe(false);
      expect(showSeries(mode, '6h', {})).toBe(false);
    }
  });

  it('PoP / Public: 在 1H 手动点开 ⇒ 1H 显示, 但 6H 仍是默认关闭', () => {
    const o = withToggledOverride({}, '1h', false);
    expect(showSeries('pop', '1h', o)).toBe(true);
    expect(showSeries('pop', '6h', o)).toBe(false);
  });

  it('用户在 15m 的选择不会被 1H/6H 的默认值覆盖', () => {
    // 15m 里点一下关掉 → 切到 1H(仍是默认关) → 切回 15m(还记得用户关了)
    let o: HandoffOverrides = {};
    o = withToggledOverride(o, '15m', true);
    expect(resolveHandoffsVisible('1h', o)).toBe(false);
    expect(resolveHandoffsVisible('6h', o)).toBe(false);
    expect(resolveHandoffsVisible('15m', o)).toBe(false);
  });
});
