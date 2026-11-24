/**
 * `splitIdentifiableHandoffs` 的判据测试。
 *
 * 这组用例守的是一条会**静默丢历史**的路径：
 * `satellite_handoffs` 以 `rtc_ms` 为主键，写入用 `INSERT OR REPLACE`。
 * 如果一批事件的身份全是 0（设备时间字段读不出来时的占位值），
 * 它们会在库里互相覆盖，最后只剩一条 —— 没有异常，没有日志，只有少掉的行。
 */

import { describe, it, expect } from 'vitest';
import { OutageCause } from '../core/outageTypes';
import type { HandoffEvent } from '../core/outageAnalyzer';
import { splitIdentifiableHandoffs } from './handoffIdentity';

const HOUR = 60 * 60 * 1000;

/** 真机那台设备的 RTC 基准（比 host 早约 10 年）—— 有效的身份就是这个样子 */
const DEVICE_RTC_BASE = 1479481378560;

function makeHandoff(rtcMs: number, cause = 'HANDOFF'): HandoffEvent {
  return {
    rtcMs,
    // timestamp 是派生值，判据不看它
    timestamp: rtcMs + 10 * 365 * 24 * HOUR,
    durationMs: 2400,
    cause,
    parsedCause: OutageCause.HANDOFF,
    isExplicit: true,
  };
}

describe('splitIdentifiableHandoffs', () => {
  it('身份有效的条目原样保留，顺序不变', () => {
    const events = [makeHandoff(DEVICE_RTC_BASE), makeHandoff(DEVICE_RTC_BASE + 60_000)];
    const { identifiable, rejected } = splitIdentifiableHandoffs(events);

    expect(rejected).toHaveLength(0);
    expect(identifiable.map((h) => h.rtcMs)).toEqual([DEVICE_RTC_BASE, DEVICE_RTC_BASE + 60_000]);
  });

  it('rtcMs 为 0 的条目被拒 —— 这正是字段读不出来时的占位值', () => {
    const { identifiable, rejected } = splitIdentifiableHandoffs([
      makeHandoff(0),
      makeHandoff(0),
      makeHandoff(DEVICE_RTC_BASE),
    ]);

    expect(identifiable).toHaveLength(1);
    expect(identifiable[0].rtcMs).toBe(DEVICE_RTC_BASE);
    expect(rejected).toHaveLength(2);
  });

  it('NaN / Infinity / 负数一律拒收', () => {
    const { identifiable, rejected } = splitIdentifiableHandoffs([
      makeHandoff(Number.NaN),
      makeHandoff(Number.POSITIVE_INFINITY),
      makeHandoff(-1),
    ]);

    expect(identifiable).toHaveLength(0);
    expect(rejected).toHaveLength(3);
  });

  it('整批无效时 identifiable 为空 —— 调用方据此跳过写库', () => {
    const { identifiable } = splitIdentifiableHandoffs([makeHandoff(0), makeHandoff(0)]);
    expect(identifiable).toEqual([]);
  });

  it('空数组不报错', () => {
    expect(splitIdentifiableHandoffs([])).toEqual({ identifiable: [], rejected: [] });
  });

  it('不修改入参数组', () => {
    const events = [makeHandoff(0), makeHandoff(DEVICE_RTC_BASE)];
    const snapshot = events.map((h) => h.rtcMs);
    splitIdentifiableHandoffs(events);
    expect(events.map((h) => h.rtcMs)).toEqual(snapshot);
  });
});