/**
 * outage 时间戳 / 时长的单位处理（#10：卫星切换事件一个都不显示）。
 *
 * 背景：仪表盘的 ★ 卫星切换标记来自 `dishGetHistory` 的 outages[]。
 * 过去 `toEpochMs()` 把 **≥1e11 一律当毫秒**，于是真机若发纳秒
 * （Starlink 协议里绝对时间戳常用纳秒），时间戳会落到公元 5 万多年，
 * 事件永远在查询窗口之外 ⇒ 一个标记都不出现。
 *
 * 这里覆盖四件事：
 *   ① 绝对时间戳按数量级判单位（秒 / 毫秒 / 微秒 / 纳秒）
 *   ② 时长用同一套单位换算，并兜住「时间戳毫秒、时长纳秒」的混搭
 *   ③ 用纳秒时间戳的 outage 仍能被识别成卫星切换
 *   ④ 换算之后的事件落回真实时间窗（这是 #10 的验收点）
 */

import { describe, expect, it } from 'vitest';
import {
  analyzeOutages,
  detectTimestampUnit,
  filterHandoffsByTimeWindow,
  toDurationMs,
  toEpochMs,
} from './outageAnalyzer';
import type { RawOutage } from './outageTypes';

/** 2026-11-23T05:00:00Z 的毫秒级 epoch */
const MS_NOW = 1793671200000;

describe('detectTimestampUnit', () => {
  it('按数量级区分秒 / 毫秒 / 微秒 / 纳秒', () => {
    expect(detectTimestampUnit(1793671200)).toBe('s');
    expect(detectTimestampUnit(MS_NOW)).toBe('ms');
    expect(detectTimestampUnit(MS_NOW * 1000)).toBe('us');
    expect(detectTimestampUnit(MS_NOW * 1e6)).toBe('ns');
  });

  it('字符串形式的 protobuf int64 一样能判', () => {
    expect(detectTimestampUnit('1793671200')).toBe('s');
    expect(detectTimestampUnit('1793671200000')).toBe('ms');
    expect(detectTimestampUnit(String(MS_NOW * 1e6))).toBe('ns');
  });

  it('非法值返回 null', () => {
    expect(detectTimestampUnit(undefined)).toBeNull();
    expect(detectTimestampUnit('abc')).toBeNull();
    expect(detectTimestampUnit(0)).toBeNull();
    expect(detectTimestampUnit(-1)).toBeNull();
  });
});

describe('toEpochMs', () => {
  it('毫秒原样返回', () => {
    expect(toEpochMs(MS_NOW)).toBe(MS_NOW);
    expect(toEpochMs(String(MS_NOW))).toBe(MS_NOW);
  });

  it('秒补齐到毫秒', () => {
    expect(toEpochMs(1793671076)).toBe(1793671076000);
    expect(toEpochMs('1793671076')).toBe(1793671076000);
  });

  it('微秒换算成毫秒', () => {
    expect(toEpochMs(MS_NOW * 1000)).toBe(MS_NOW);
  });

  it('纳秒换算成毫秒（真机的情形）', () => {
    expect(toEpochMs(MS_NOW * 1e6)).toBe(MS_NOW);
  });

  it('非法值返回 0', () => {
    expect(toEpochMs(undefined)).toBe(0);
    expect(toEpochMs('abc')).toBe(0);
    expect(toEpochMs(-1)).toBe(0);
  });
});

describe('toDurationMs', () => {
  it('毫秒时长原样返回', () => {
    expect(toDurationMs(2109, 'ms')).toBe(2109);
  });

  it('微秒时长换算成毫秒', () => {
    expect(toDurationMs(2e6, 'us')).toBe(2000);
  });

  it('纳秒时长换算成毫秒', () => {
    expect(toDurationMs(2e9, 'ns')).toBe(2000);
  });

  it('时间戳是毫秒、时长却是纳秒时按毫秒契约回落', () => {
    // 2e9 按毫秒解释是 23 天, 超出合理区间 ⇒ 回落成毫秒读数 ⇒ 依然是超长中断
    expect(toDurationMs(2e9, 'ms')).toBe(2e9);
  });

  it('时间戳是毫秒、时长是微秒时按毫秒契约解释', () => {
    expect(toDurationMs(2e6, 'ms')).toBe(2e6);
  });

  it('非法值返回 0', () => {
    expect(toDurationMs(undefined, 'ms')).toBe(0);
    expect(toDurationMs('abc', 'ms')).toBe(0);
    expect(toDurationMs(0, 'ms')).toBe(0);
  });
});

describe('analyzeOutages —— 纳秒时间戳的切换事件', () => {
  const nsOutage: RawOutage = {
    startTimestamp: String(MS_NOW * 1e6), // 纳秒
    durationMs: '2109', // 毫秒
    cause: 'NO_DOWNLINK',
  };

  it('仍被识别成卫星切换', () => {
    const analysis = analyzeOutages([nsOutage]);
    expect(analysis.handoffs).toHaveLength(1);
    expect(analysis.handoffs[0].timestamp).toBe(MS_NOW);
    expect(analysis.handoffs[0].durationMs).toBe(2109);
  });

  it('换算后的事件落回真实时间窗（#10 的验收点）', () => {
    const analysis = analyzeOutages([nsOutage]);
    const inWindow = filterHandoffsByTimeWindow(
      analysis.handoffs,
      MS_NOW - 3600_000,
      MS_NOW + 3600_000
    );
    expect(inWindow).toHaveLength(1);
  });

  it('纳秒时长也能判定为短时中断', () => {
    const analysis = analyzeOutages([
      {
        startTimestamp: String(MS_NOW * 1e6),
        durationMs: String(2 * 1e9), // 2 秒，纳秒
        cause: 'NO_DOWNLINK',
      },
    ]);
    expect(analysis.handoffs).toHaveLength(1);
    expect(analysis.handoffs[0].durationMs).toBe(2000);
  });

  it('长中断不会被误判成切换', () => {
    const analysis = analyzeOutages([
      {
        startTimestamp: String(MS_NOW * 1e6),
        durationMs: '600000', // 10 分钟，毫秒
        cause: 'NO_DOWNLINK',
      },
    ]);
    expect(analysis.handoffs).toHaveLength(0);
    expect(analysis.otherOutages).toHaveLength(1);
  });

  it('毫秒时间戳的既有行为不变', () => {
    const analysis = analyzeOutages([
      {
        startTimestamp: String(MS_NOW),
        durationMs: '2109',
        cause: 'NO_DOWNLINK',
      },
    ]);
    expect(analysis.handoffs).toHaveLength(1);
    expect(analysis.handoffs[0].timestamp).toBe(MS_NOW);
  });
});
