/**
 * 「最近一次卫星切换」空态文案的分档测试
 *
 * 背景见 `handoffAge.ts`：真机上数据是好的，只是最近一次切换在 6.4 小时前，
 * 1H/6H 窗口都覆盖不到，界面只说"没有记录" ⇒ 用户认为功能坏了。
 * 所以这档文案必须**稳定且可读**，不能出现 "0 分钟前" / "-3 分钟前" / "0.1 天前"。
 */
import { describe, it, expect } from 'vitest';
import { describeHandoffAge, handoffAgeKey } from './handoffAge';

const NOW = Date.UTC(2026, 10, 24, 3, 0, 0);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('describeHandoffAge', () => {
  it('刚发生 / 未来时间 都显示 1 分钟前，不出现 0 或负数', () => {
    expect(describeHandoffAge(NOW, NOW)).toEqual({ unit: 'minutes', count: 1 });
    expect(describeHandoffAge(NOW + 5 * MINUTE, NOW)).toEqual({ unit: 'minutes', count: 1 });
  });

  it('一小时内用分钟', () => {
    expect(describeHandoffAge(NOW - 12 * MINUTE, NOW)).toEqual({ unit: 'minutes', count: 12 });
    expect(describeHandoffAge(NOW - 59 * MINUTE, NOW)).toEqual({ unit: 'minutes', count: 59 });
  });

  it('一天内用小时 —— 真机那个 6.4 小时的场景', () => {
    expect(describeHandoffAge(NOW - 6.4 * HOUR, NOW)).toEqual({ unit: 'hours', count: 6 });
    expect(describeHandoffAge(NOW - HOUR, NOW)).toEqual({ unit: 'hours', count: 1 });
    expect(describeHandoffAge(NOW - 23 * HOUR, NOW)).toEqual({ unit: 'hours', count: 23 });
  });

  it('超过一天用天', () => {
    expect(describeHandoffAge(NOW - DAY, NOW)).toEqual({ unit: 'days', count: 1 });
    expect(describeHandoffAge(NOW - 3 * DAY - 5 * HOUR, NOW)).toEqual({ unit: 'days', count: 3 });
  });

  it('非法时间戳退化成 1 分钟前，不抛错', () => {
    expect(describeHandoffAge(Number.NaN, NOW)).toEqual({ unit: 'minutes', count: 1 });
  });

  it('每个单位都有对应的 i18n key', () => {
    expect(handoffAgeKey({ unit: 'minutes', count: 5 })).toBe(
      'dashboard:chart.handoff_last_seen_minutes'
    );
    expect(handoffAgeKey({ unit: 'hours', count: 6 })).toBe(
      'dashboard:chart.handoff_last_seen_hours'
    );
    expect(handoffAgeKey({ unit: 'days', count: 2 })).toBe(
      'dashboard:chart.handoff_last_seen_days'
    );
  });
});
