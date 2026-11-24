/**
 * 真机 outage 字段名的回归测试
 *
 * ## 为什么需要
 *
 * 2026-11 在一台真实 terminal（192.168.100.1，固件经 grpc-web 9201）上实测，
 * `dishGetHistory.outages` 的条目长这样：
 *
 * ```json
 * {"cause":"NO_DOWNLINK","startTimestampNs":"1479420720000261589",
 *  "durationNs":"560167119","didSwitch":true}
 * ```
 *
 * 三处和代码假设不符，每一处都足以让"卫星切换"彻底消失：
 *
 * 1. 字段名是 `startTimestampNs` / `durationNs`，不是 `startTimestamp` / `durationMs`
 *    ⇒ 规整后时间戳 0、时长 0 ⇒ 事件永远在查询窗口外。
 * 2. 时间戳是**纳秒**（19 位，超过 `Number.MAX_SAFE_INTEGER`）
 *    ⇒ 按数量级判单位时必须认成 ns，否则落到公元 5 万年。
 * 3. 设备带 `didSwitch:true`，明确告诉我们"这次换了卫星"
 *    ⇒ 比按持续时长猜可靠得多。
 *
 * 另外设备 RTC 报的是 **2016 年**，需要按 `history.current` 做整体时钟修正。
 */
import { describe, it, expect } from 'vitest';
import { normalizeOutage, isHandoffOutage } from './outageTypes';
import { analyzeOutages, toEpochMs, detectTimestampUnit } from './outageAnalyzer';

/** 真机原始条目（原样照抄） */
const REAL_OUTAGE = {
  cause: 'NO_DOWNLINK',
  startTimestampNs: '1479420720000261589',
  durationNs: '560167119',
  didSwitch: true,
};

/** 真机时间戳解析出来的墙钟时间：2016-11-18 */
const REAL_TS_MS = 1479420720000;

describe('真机 outage 字段名与单位', () => {
  it('认 startTimestampNs / durationNs', () => {
    const o = normalizeOutage(REAL_OUTAGE as never);
    // 保留纳秒数量级，交给 detectTimestampUnit 判单位
    expect(o.startTimestamp).toBeGreaterThan(1e17);
    expect(o.durationMs).toBe(560167119);
  });

  it('纳秒时间戳能正确落到毫秒（而不是公元 5 万年）', () => {
    const o = normalizeOutage(REAL_OUTAGE as never);
    expect(detectTimestampUnit(o.startTimestamp)).toBe('ns');
    const ms = toEpochMs(o.startTimestamp);
    // 允许几十毫秒的浮点误差
    expect(Math.abs(ms - REAL_TS_MS)).toBeLessThan(100);
  });

  it('纳秒时长换算成毫秒是 560ms 量级，不是天文数字', () => {
    const { handoffs } = analyzeOutages([REAL_OUTAGE as never], { hostNow: REAL_TS_MS });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].durationMs).toBeCloseTo(560.17, 1);
  });

  it('didSwitch:true 直接判成卫星切换，且标为明确标识', () => {
    const { handoffs } = analyzeOutages([REAL_OUTAGE as never], { hostNow: REAL_TS_MS });
    expect(handoffs[0].isExplicit).toBe(true);
    expect(handoffs[0].cause).toBe('NO_DOWNLINK');
  });

  it('OBSTRUCTED + didSwitch:true 仍是遮挡事件，不能被吞成切换', () => {
    // 真机每一条 outage 的 didSwitch 都是 true，连遮挡也是。
    // 若据此判切换，otherOutages 会变空 ⇒ 遮挡告警再也不触发。
    const { handoffs, otherOutages } = analyzeOutages(
      [
        {
          cause: 'OBSTRUCTED',
          startTimestampNs: '1479481378560372964',
          durationNs: '1579831282',
          didSwitch: true,
        } as never,
      ],
      { hostNow: REAL_TS_MS },
    );
    expect(handoffs).toHaveLength(0);
    expect(otherOutages).toHaveLength(1);
  });

  it('didSwitch:false 的长中断不算切换', () => {
    const o = normalizeOutage({
      cause: 'OBSTRUCTED',
      startTimestampNs: '1479425250040287618',
      durationNs: '1299976570', // 1300ms，时长在阈值内
      didSwitch: false,
    } as never);
    // OBSTRUCTED 不在隐式切换 cause 里 ⇒ 不算切换
    expect(isHandoffOutage(o)).toBe(false);
  });
});

describe('设备时钟偏差修正', () => {
  const hostNow = Date.UTC(2026, 10, 23, 10, 0, 0);

  it('history.current 是开机秒数时，绝不能当 epoch 用', () => {
    // 真机：current = "398560"，deviceState.uptimeS = "398578" —— 就是 uptime。
    // 当 epoch 用会把事件搬到 2073 年，比不修正更糟（真机踩过）。
    const { handoffs, clockMode } = analyzeOutages([REAL_OUTAGE as never], {
      deviceNow: '398560',
      hostNow,
    });
    expect(handoffs).toHaveLength(1);
    // 应走「最新事件对齐现在」，而不是「current 当 epoch」
    expect(clockMode).toBe('newest');
    // 落点必须在这一代（而不是 1970 或 2073）
    expect(handoffs[0].timestamp).toBeGreaterThan(hostNow - 60 * 1000);
    expect(handoffs[0].timestamp).toBeLessThanOrEqual(hostNow);
  });

  it('current 确实是 epoch 时按它修正', () => {
    // 设备时钟慢 1 小时，但内部一致（事件时间戳和 current 同一基准）
    const skewMs = 3600 * 1000;
    const deviceNowMs = hostNow - skewMs;
    const eventAtDeviceMs = deviceNowMs - 4280 * 1000;
    const { handoffs, clockMode } = analyzeOutages(
      [
        {
          cause: 'NO_DOWNLINK',
          startTimestampNs: String(BigInt(eventAtDeviceMs) * 1000000n),
          durationNs: '560167119',
          didSwitch: true,
        } as never,
      ],
      { deviceNow: String(BigInt(deviceNowMs) * 1000000n), hostNow },
    );
    expect(clockMode).toBe('current');
    // 事件比设备"现在"早 4280 秒 ⇒ 修正后比 hostNow 早约 4280 秒
    const ageMs = hostNow - handoffs[0].timestamp;
    expect(ageMs).toBeGreaterThan(4200 * 1000);
    expect(ageMs).toBeLessThan(4400 * 1000);
  });

  it('给定固定 offset 时不再自己算（避免同一事件每轮被重写）', () => {
    const fixed = 316000000000;
    const a = analyzeOutages([REAL_OUTAGE as never], { hostNow, clockOffsetMs: fixed });
    const b = analyzeOutages([REAL_OUTAGE as never], { hostNow: hostNow + 30000, clockOffsetMs: fixed });
    expect(a.handoffs[0].timestamp).toBe(b.handoffs[0].timestamp);
    expect(a.clockMode).toBe('given');
  });

  it('设备时钟正常时不做任何修正', () => {
    const { handoffs, clockMode } = analyzeOutages(
      [
        {
          cause: 'HANDOFF',
          startTimestamp: String(hostNow - 120000),
          durationMs: '1500',
        } as never,
      ],
      { hostNow },
    );
    expect(clockMode).toBe('none');
    expect(handoffs[0].timestamp).toBe(hostNow - 120000);
  });
});
