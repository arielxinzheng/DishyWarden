/**
 * 卫星切换识别链路的回归测试
 *
 * ## 覆盖的 5 个真实 bug
 *
 * 1. `analyzeOutages` 把已经是毫秒的 `startTimestamp` 又乘了 1000
 *    ⇒ 时间戳变成公元 58000 年 ⇒ 所有事件落在时间窗外 ⇒ 图表上一个点都没有
 * 2. protobuf 的 int64 序列化成**字符串**, `durationMs` 没转 number
 *    ⇒ `sum + h.durationMs` 变成字符串拼接 ⇒ 平均时长算出 `3.77e+222`
 * 3. `HANDOFF` / `SWITCHING` 不在 `OutageCause` 枚举里
 *    ⇒ `parseOutageCause('HANDOFF')` 落到 `UNKNOWN`
 * 4. `isHandoffOutage` 用未规整的 `durationMs` 做 `<= 10000` 比较
 * 5. `durationMs` 参与 `<=` 比较时是字符串, 比较结果失真
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeOutages,
  calculateAverageHandoffDuration,
  detectAbnormalHandoffs,
  toEpochMs,
} from './outageAnalyzer';
import { normalizeOutage, parseOutageCause, OutageCause, type RawOutage } from './outageTypes';

/** DishyMock 实测的原始形态: int64 是字符串 */
const raw = (o: Partial<RawOutage> = {}): RawOutage => ({
  startTimestamp: '1793671076044',
  durationMs: '2109',
  triggered: 'HANDOFF',
  ...o,
});

describe('toEpochMs', () => {
  it('毫秒级时间戳原样保留(不再乘 1000)', () => {
    expect(toEpochMs('1793671076044')).toBe(1793671076044);
    expect(toEpochMs(1793671076044)).toBe(1793671076044);
  });

  it('秒级时间戳补齐到毫秒', () => {
    expect(toEpochMs(1793671076)).toBe(1793671076000);
    expect(toEpochMs('1793671076')).toBe(1793671076000);
  });

  it('非法值返回 0', () => {
    expect(toEpochMs(undefined)).toBe(0);
    expect(toEpochMs('abc')).toBe(0);
    expect(toEpochMs(-1)).toBe(0);
  });
});

describe('normalizeOutage', () => {
  it('字符串数值转成 number', () => {
    const o = normalizeOutage(raw());
    expect(typeof o.startTimestamp).toBe('number');
    expect(typeof o.durationMs).toBe('number');
    expect(o.startTimestamp).toBe(1793671076044);
    expect(o.durationMs).toBe(2109);
  });
});

describe('parseOutageCause', () => {
  it('HANDOFF / SWITCHING 不再落到 UNKNOWN', () => {
    expect(parseOutageCause('HANDOFF')).toBe(OutageCause.HANDOFF);
    expect(parseOutageCause('SWITCHING')).toBe(OutageCause.SWITCHING);
    expect(parseOutageCause('handoff')).toBe(OutageCause.HANDOFF);
  });

  it('其他 cause 正常映射', () => {
    expect(parseOutageCause('NO_DOWNLINK')).toBe(OutageCause.NO_DOWNLINK);
    expect(parseOutageCause('NO_SATS')).toBe(OutageCause.NO_SATS);
    expect(parseOutageCause('WHATEVER')).toBe(OutageCause.UNKNOWN);
  });
});

describe('analyzeOutages', () => {
  it('时间戳保持毫秒级, 不会被乘 1000', () => {
    const { handoffs } = analyzeOutages([raw({ triggered: 'HANDOFF' })]);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].timestamp).toBe(1793671076044);
    // 回归防护: 之前这里是 1793671076044000(公元 58000 年)
    // 合法的 ms epoch 在 1e12 ~ 1e13 之间(2001-09-09 ~ 2286 年)
    expect(handoffs[0].timestamp).toBeGreaterThan(1e12);
    expect(handoffs[0].timestamp).toBeLessThan(1e13);
  });

  it('durationMs 是 number 而不是字符串', () => {
    const { handoffs } = analyzeOutages([raw({ triggered: 'HANDOFF' })]);
    expect(typeof handoffs[0].durationMs).toBe('number');
    expect(handoffs[0].durationMs).toBe(2109);
  });

  it('平均时长是数字, 不是字符串拼接出来的垃圾值', () => {
    const { handoffs } = analyzeOutages([
      raw({ triggered: 'HANDOFF', durationMs: '2000' }),
      raw({ triggered: 'HANDOFF', durationMs: '4000' }),
      raw({ triggered: 'HANDOFF', durationMs: '6000' }),
    ]);
    const avg = calculateAverageHandoffDuration(handoffs);
    expect(avg).toBe(4000);
    expect(Number.isFinite(avg!)).toBe(true);
    // 回归防护: 之前这里是 3.77e+222
    expect(avg!).toBeLessThan(1e6);
  });

  it('识别明确的切换标识', () => {
    const { handoffs } = analyzeOutages([
      raw({ triggered: 'HANDOFF' }),
      raw({ triggered: 'SWITCHING' }),
    ]);
    expect(handoffs).toHaveLength(2);
    expect(handoffs.every((h) => h.isExplicit)).toBe(true);
  });

  it('短时 NO_DOWNLINK 也能识别为隐式切换', () => {
    const { handoffs, otherOutages } = analyzeOutages([
      raw({ triggered: 'NO_DOWNLINK', durationMs: '3000' }),
    ]);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].isExplicit).toBe(false);
    expect(handoffs[0].parsedCause).toBe(OutageCause.NO_DOWNLINK);
    expect(otherOutages).toHaveLength(0);
  });

  it('长时间的中断不算切换', () => {
    const { handoffs, otherOutages } = analyzeOutages([
      raw({ triggered: 'NO_DOWNLINK', durationMs: '30000' }),
    ]);
    expect(handoffs).toHaveLength(0);
    expect(otherOutages).toHaveLength(1);
  });

  it('cause 字段(真实设备)与 triggered 字段(DishyMock)都支持', () => {
    const withCause = analyzeOutages([
      { startTimestamp: 1793671076044, durationMs: 2109, cause: 'HANDOFF' },
    ]);
    expect(withCause.handoffs).toHaveLength(1);
    expect(withCause.handoffs[0].cause).toBe('HANDOFF');

    const withTriggered = analyzeOutages([
      { startTimestamp: 1793671076044, durationMs: 2109, triggered: 'HANDOFF' },
    ]);
    expect(withTriggered.handoffs).toHaveLength(1);
  });

  it('异常切换检测基于数值比较', () => {
    const { handoffs } = analyzeOutages([
      raw({ triggered: 'HANDOFF', durationMs: '2000' }),
      raw({ triggered: 'HANDOFF', durationMs: '15000' }),
    ]);
    const abnormal = detectAbnormalHandoffs(handoffs);
    expect(abnormal).toHaveLength(1);
    expect(abnormal[0].durationMs).toBe(15000);
  });

  it('空数组不崩', () => {
    const analysis = analyzeOutages([]);
    expect(analysis.handoffs).toHaveLength(0);
    expect(analysis.totalOutages).toBe(0);
    expect(analysis.handoffRatio).toBe(0);
  });
});
