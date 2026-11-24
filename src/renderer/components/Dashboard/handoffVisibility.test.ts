/**
 * 卫星切换标记可见性规则的回归测试
 *
 * ## 三层判据
 *
 * | 层 | 判据 | 关掉的条件 |
 * |---|---|---|
 * | ① 延迟维度 | `showsSatelliteHandoffs(mode)` | Local(网关)模式 |
 * | ② 时间范围 | `handoffsVisibleByDefault(range)` | 目前恒为开 |
 * | ③ 用户手动 | `overrides[range]` | 用户在该范围点过图例 |
 *
 * ## 需求
 *
 * - 所有范围 → 图例高亮, 卫星切换**默认开启**
 *   (2026-11 修正: 旧规则是「仅 15m 开」, 其前提"长窗口 ★ 太多会糊住折线"
 *    被真机数据推翻 —— 实测每小时只有 1~2 条, 6H 也就 ~10 条)
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

  it('1H / 6H 同样开启', () => {
    expect(handoffsVisibleByDefault('1h')).toBe(true);
    expect(handoffsVisibleByDefault('6h')).toBe(true);
  });
});

describe('resolveHandoffsVisible', () => {
  it('该范围没点过时用它的默认值', () => {
    expect(resolveHandoffsVisible('15m', {})).toBe(true);
    expect(resolveHandoffsVisible('1h', {})).toBe(true);
    expect(resolveHandoffsVisible('6h', {})).toBe(true);
  });

  it('该范围点过时用用户的选择', () => {
    expect(resolveHandoffsVisible('15m', { '15m': false })).toBe(false);
    expect(resolveHandoffsVisible('1h', { '1h': true })).toBe(true);
  });

  it('只影响该范围, 不波及其他范围', () => {
    const overrides: HandoffOverrides = { '15m': false };
    // 15m 被用户关了, 但 1h/6h 仍是各自的默认值(开)
    expect(resolveHandoffsVisible('15m', overrides)).toBe(false);
    expect(resolveHandoffsVisible('1h', overrides)).toBe(true);
    expect(resolveHandoffsVisible('6h', overrides)).toBe(true);
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

  it('PoP / Public: 所有时间范围默认显示', () => {
    for (const mode of ['pop', 'public'] as LatencyMode[]) {
      for (const range of ['15m', '1h', '6h'] as TimeRangeKey[]) {
        expect(showSeries(mode, range, {})).toBe(true);
      }
    }
  });

  it('PoP / Public: 在 1H 手动关掉 ⇒ 只影响 1H, 6H 仍显示', () => {
    const o = withToggledOverride({}, '1h', true);   // 1h 当前是开 → 关掉
    expect(showSeries('pop', '1h', o)).toBe(false);
    expect(showSeries('pop', '6h', o)).toBe(true);
  });

  it('用户在 15m 的选择不会被其他范围的默认值覆盖', () => {
    // 15m 里点一下关掉 → 切到 1H(默认开) → 切回 15m(还记得用户关了)
    let o: HandoffOverrides = {};
    o = withToggledOverride(o, '15m', true);
    expect(resolveHandoffsVisible('1h', o)).toBe(true);
    expect(resolveHandoffsVisible('6h', o)).toBe(true);
    expect(resolveHandoffsVisible('15m', o)).toBe(false);
  });
});
