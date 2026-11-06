/**
 * 期望朝向（desiredBoresight*）的解析语义。
 *
 * 这组用例锁的是一个真实踩过的坑：期望朝向被兜成 0 之后，
 * 「设备没上报推荐朝向」会变成「推荐正北」，校准页据此给出
 * 「向西旋转 135°」这种错误引导，而「无期望值」分支永远走不到。
 */

import { describe, expect, it } from 'vitest';
import { DishClient, parseFiniteNumber, type TelemetryData } from './dishClient';

/** parseStatus 是 private，但映射逻辑是本文件要锁的东西 —— 用类型断言取出来 */
function mapper() {
  const client = new DishClient({ address: '127.0.0.1', grpcPort: 9200 });
  const inner = client as unknown as {
    parseStatus(status: Record<string, unknown>): TelemetryData;
    lastTelemetry: TelemetryData | null;
  };
  return {
    parse: (status: Record<string, unknown>) => inner.parseStatus(status),
    setPrev: (t: TelemetryData | null) => {
      inner.lastTelemetry = t;
    },
  };
}

describe('parseFiniteNumber', () => {
  it('正常数字原样返回', () => {
    expect(parseFiniteNumber(135)).toBe(135);
    expect(parseFiniteNumber(0)).toBe(0);
    expect(parseFiniteNumber(-12.5)).toBe(-12.5);
  });

  it('数字字符串能解析（int64 在 proto 里是 string）', () => {
    expect(parseFiniteNumber('135')).toBe(135);
    expect(parseFiniteNumber('0')).toBe(0);
  });

  it('缺失 / 非法值返回 undefined，而不是 0', () => {
    expect(parseFiniteNumber(undefined)).toBeUndefined();
    expect(parseFiniteNumber(null)).toBeUndefined();
    expect(parseFiniteNumber('')).toBeUndefined();
    expect(parseFiniteNumber('  ')).toBeUndefined();
    expect(parseFiniteNumber('abc')).toBeUndefined();
    expect(parseFiniteNumber(Number.NaN)).toBeUndefined();
    expect(parseFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('0 与 undefined 必须能区分：0 是合法的正北方位，不是「没上报」', () => {
    // 设备确实上报了 0（推荐正北）→ 有值
    expect(parseFiniteNumber(0) ?? '缺失').toBe(0);
    // 设备没上报 → 没值
    expect(parseFiniteNumber(undefined) ?? '缺失').toBe('缺失');
  });
});

describe('parseStatus —— 期望朝向的映射', () => {
  it('设备不报期望朝向时是 undefined，不是 0', () => {
    const { parse } = mapper();
    const t = parse({
      alignmentStats: { hasActuators: 'HAS_ACTUATORS_YES', attitudeUncertaintyDeg: 0.4 },
      boresightAzimuthDeg: 135,
    });
    expect(t.alignmentStats?.desiredBoresightAzimuthDeg).toBeUndefined();
    expect(t.alignmentStats?.desiredBoresightElevationDeg).toBeUndefined();
  });

  it('整个 alignmentStats 缺失时也是 undefined', () => {
    const { parse } = mapper();
    const t = parse({ boresightAzimuthDeg: 135 });
    expect(t.alignmentStats?.desiredBoresightAzimuthDeg).toBeUndefined();
  });

  it('设备上报 0 时保留 0（推荐正北是合法值，不能当成缺失）', () => {
    const { parse } = mapper();
    const t = parse({
      alignmentStats: { desiredBoresightAzimuthDeg: 0, desiredBoresightElevationDeg: 0 },
    });
    expect(t.alignmentStats?.desiredBoresightAzimuthDeg).toBe(0);
    expect(t.alignmentStats?.desiredBoresightElevationDeg).toBe(0);
  });

  it('正常上报时按值映射', () => {
    const { parse } = mapper();
    const t = parse({
      alignmentStats: { desiredBoresightAzimuthDeg: 135, desiredBoresightElevationDeg: 45 },
    });
    expect(t.alignmentStats?.desiredBoresightAzimuthDeg).toBe(135);
    expect(t.alignmentStats?.desiredBoresightElevationDeg).toBe(45);
  });

  it('本帧缺失时沿用上一帧的值（设备抖动不应让推荐范围忽有忽无）', () => {
    const { parse, setPrev } = mapper();
    setPrev({
      alignmentStats: { desiredBoresightAzimuthDeg: 135, desiredBoresightElevationDeg: 45 },
    } as TelemetryData);
    const t = parse({ alignmentStats: { attitudeUncertaintyDeg: 0.4 } });
    expect(t.alignmentStats?.desiredBoresightAzimuthDeg).toBe(135);
    expect(t.alignmentStats?.desiredBoresightElevationDeg).toBe(45);
  });

  it('回归：绝不能退化成 0（0 会被当成「推荐正北」）', () => {
    const { parse } = mapper();
    const t = parse({ alignmentStats: {} });
    expect(t.alignmentStats?.desiredBoresightAzimuthDeg).not.toBe(0);
  });
});
