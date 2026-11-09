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

/**
 * ===== 回归：proto3「值为 0 的字段不出现在响应里」=====
 *
 * 现象：DishyMock 恢复全部告警后，SLMonitor 里的 high_packet_loss /
 * severe_weather 一直不消失（occurrence_count 涨到 68，last_seen 持续刷新）。
 *
 * 根因：dishGrpc 用 `defaults: false` 加载 proto，proto3 里等于默认值的字段
 * **根本不会出现在响应里**。旧代码把「丢包率回到 0 ⇒ 字段消失」当成
 * 「设备没上报 ⇒ 沿用上一帧」，于是丢包率被永久冻结在 0.6，告警永远成立。
 *
 * 修法：所有物理量走 `gauge()` —— 缺失即 0。
 */
describe('parseStatus —— 物理量缺失必须归零，不能沿用上一帧', () => {
  it('丢包率从 0.6 恢复为「字段消失」⇒ 必须回到 0（告警要能自愈）', () => {
    const { parse, setPrev } = mapper();
    // 第一帧：场景激活，丢包 60%
    const sick = parse({
      popPingDropRate: 0.6,
      downlinkThroughputBps: 120e6,
      snr: 6,
      obstructionStats: { fractionObstructed: 0.3 },
    });
    expect(sick.popPingDropRate).toBeCloseTo(0.6, 6);
    setPrev(sick as TelemetryData);

    // 第二帧：场景恢复 —— 0 值的字段在 proto3 里直接消失
    const healthy = parse({
      downlinkThroughputBps: 140e6,
      isSnrAboveNoiseFloor: true,
    });

    expect(healthy.popPingDropRate).toBe(0);        // ← 修复前是 0.6
    expect(healthy.snr).toBe(0);                    // ← 修复前是 6
    expect(healthy.fractionObstructed).toBe(0);     // ← 修复前是 0.3
    expect(healthy.secondsObstructed).toBe(0);
  });

  it('恢复后 high_packet_loss 判据不再成立', () => {
    const { parse, setPrev } = mapper();
    const sick = parse({ popPingDropRate: 0.6 });
    setPrev(sick as TelemetryData);
    const healthy = parse({ popPingLatencyMs: 30 });
    // 规则判据: (data.popPingDropRate || 0) > 0.1
    expect((healthy.popPingDropRate || 0) > 0.1).toBe(false);
  });

  it('真实非零量照常透传', () => {
    const { parse } = mapper();
    const t = parse({
      popPingDropRate: 0.12, popPingLatencyMs: 88, snr: 4,
      downlinkThroughputBps: 5e6,
      deviceInfo: { dishTemperature: 61 },
    });
    expect(t.popPingDropRate).toBeCloseTo(0.12, 6);
    expect(t.popPingLatencyMs).toBe(88);
    expect(t.snr).toBe(4);
    expect(t.dishTemperature).toBe(61);
  });

  it('设备重启（uptime 归零）不再被旧值掩盖', () => {
    const { parse, setPrev } = mapper();
    setPrev(parse({ deviceState: { uptimeS: 86400 } }) as TelemetryData);
    const rebooted = parse({ deviceState: {} }); // uptime=0 ⇒ 字段消失
    expect(rebooted.uptime).toBe(0);
  });
});

/**
 * ===== 连接状态推导：必须分清 SEARCHING 与 OFFLINE =====
 *
 * 旧实现把所有"无下行"的情况都算成 SEARCHING，于是
 * dish_offline（判据 state !== 'ONLINE'）与 frequent_searching（state === 'SEARCHING'）
 * 会对同一件事双报；而真正该报的 severe_weather 又要求 state === 'ONLINE' 反而漏报。
 */
describe('deriveState（经由 parseStatus）—— 状态语义', () => {
  const online = (over: Record<string, unknown> = {}) => ({
    downlinkThroughputBps: 140e6,
    deviceState: { uptimeS: 3600 },
    isSnrAboveNoiseFloor: true,
    ...over,
  });

  it('有下行且有 SNR 证据 ⇒ ONLINE', () => {
    const { parse } = mapper();
    expect(parse(online()).state).toBe('ONLINE');
  });

  it('无下行但路由器还连着 ⇒ SEARCHING（正在锁星，属正常过程）', () => {
    const { parse } = mapper();
    const t = parse({
      downlinkThroughputBps: 0,
      connectedRouters: ['router-1'],
      deviceState: { uptimeS: 3600 },
    });
    expect(t.state).toBe('SEARCHING');
  });

  it('无下行且看不到任何路由器 ⇒ OFFLINE（设备在线却不在服务）', () => {
    const { parse } = mapper();
    const t = parse({
      downlinkThroughputBps: 0,
      deviceState: { uptimeS: 3600 },
    });
    expect(t.state).toBe('OFFLINE');
  });

  it('刚开机（uptime < 60s）优先判 BOOTING，不报离线', () => {
    const { parse } = mapper();
    const t = parse({ downlinkThroughputBps: 0, deviceState: { uptimeS: 12 } });
    expect(t.state).toBe('BOOTING');
  });

  it('恶劣天气（丢包 12% + SNR 低于噪声底，但下行仍在）⇒ ONLINE', () => {
    const { parse } = mapper();
    const t = parse({
      popPingDropRate: 0.12,
      downlinkThroughputBps: 140e6,
      isSnrAboveNoiseFloor: false,
      deviceState: { uptimeS: 90970 },
    });
    // 关键: 没有真实 snr 字段时，snr=0，但下行健康 ⇒ 不能判成搜星/离线
    expect(t.state).toBe('ONLINE');
  });
});
