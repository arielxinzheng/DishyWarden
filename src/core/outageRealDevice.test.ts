/**
 * 真机 outage 字段名与时间基准的回归测试
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
 * ## 时间基准
 *
 * 设备 RTC 报的是 2016 年（落后约 10 年），换算成 host 时间需要一个**锚点**。
 * 锚点由调用方跨轮推进（见 `dishClock.ts` 与 `dishClock.test.ts`），
 * 这里只验证两件事：
 *
 * - 没有锚点时事件保留设备自己的时间轴（不编假时间）
 * - 有锚点时 `rtcMs` 不变、`timestamp` 整体平移 —— 这正是「rtc 作身份」的含义
 */
import { describe, it, expect } from 'vitest';
import { normalizeOutage, isHandoffOutage } from './outageTypes';
import { analyzeOutages, toEpochMs, detectTimestampUnit } from './outageAnalyzer';
import type { ClockAnchor } from './dishClock';

/** 真机原始条目（原样照抄） */
const REAL_OUTAGE = {
  cause: 'NO_DOWNLINK',
  startTimestampNs: '1479420720000261589',
  durationNs: '560167119',
  didSwitch: true,
};

/** 真机时间戳解析出来的墙钟时间：2016-11-18 */
const REAL_TS_MS = 1479420720000;
/** 真机报告生成时刻（2026-11-24） */
const HOST_NOW_MS = Date.UTC(2026, 10, 24, 2, 6, 0);

const anchorAt = (deviceMs: number, hostMs: number): ClockAnchor => ({
  deviceMs,
  hostMs,
  uncertaintyMs: 30_000,
  source: 'observed',
});

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
    const { handoffs } = analyzeOutages([REAL_OUTAGE as never]);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].durationMs).toBeCloseTo(560.17, 1);
  });

  it('didSwitch:true 直接判成卫星切换，且标为明确标识', () => {
    const { handoffs } = analyzeOutages([REAL_OUTAGE as never]);
    expect(handoffs[0].isExplicit).toBe(true);
    expect(handoffs[0].cause).toBe('NO_DOWNLINK');
  });

  it('OBSTRUCTED + didSwitch:true 仍是遮挡事件，不能被吞成切换', () => {
    // 真机每一条 outage 的 didSwitch 都是 true，连遮挡也是。
    // 若据此判切换，otherOutages 会变空 ⇒ 遮挡告警再也不触发。
    const { handoffs, otherOutages } = analyzeOutages([
      {
        cause: 'OBSTRUCTED',
        startTimestampNs: '1479481378560372964',
        durationNs: '1579831282',
        didSwitch: true,
      } as never,
    ]);
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

describe('时间基准：rtc 是身份，timestamp 是解释', () => {
  it('没有锚点时保留设备自己的时间轴，不编假时间', () => {
    const { handoffs, clockAnchor } = analyzeOutages([REAL_OUTAGE as never]);
    expect(clockAnchor).toBeNull();
    expect(handoffs[0].rtcMs).toBeCloseTo(REAL_TS_MS, -1);
    // 未校准 ⇒ timestamp 就是 rtc
    expect(handoffs[0].timestamp).toBe(handoffs[0].rtcMs);
  });

  it('有锚点时 timestamp 被搬到 host 时间轴，rtcMs 一动不动', () => {
    // 真机形状：outages 窗口里最新一条 ≈ 现在，设备读数落在 2016 年
    const deviceNewest = 1479484860000;
    const { handoffs } = analyzeOutages([REAL_OUTAGE as never], {
      anchor: anchorAt(deviceNewest, HOST_NOW_MS),
    });

    // 身份不变
    expect(handoffs[0].rtcMs).toBeCloseTo(REAL_TS_MS, -1);
    // 解释被平移了约 10 年，落到 2026-11 附近
    const year = new Date(handoffs[0].timestamp).getUTCFullYear();
    expect(year).toBe(2026);
    expect(handoffs[0].timestamp).toBeLessThan(HOST_NOW_MS);
  });

  it('换一个锚点只让 timestamp 平移，rtcMs 保持稳定（锚点校准不产生新事件）', () => {
    const a = analyzeOutages([REAL_OUTAGE as never], {
      anchor: anchorAt(1479484860000, HOST_NOW_MS),
    });
    // 精度提升：同一设备读数，host 时刻往后挪 500ms
    const b = analyzeOutages([REAL_OUTAGE as never], {
      anchor: anchorAt(1479484860000, HOST_NOW_MS + 500),
    });

    expect(b.handoffs[0].rtcMs).toBe(a.handoffs[0].rtcMs);
    expect(b.handoffs[0].timestamp - a.handoffs[0].timestamp).toBe(500);
  });

  it('newestRtcMs 取本轮所有事件的最大 rtc，与锚点无关', () => {
    const events = [
      { cause: 'NO_DOWNLINK', startTimestampNs: '1479481378560372964', durationNs: '1579831282', didSwitch: true },
      { cause: 'NO_DOWNLINK', startTimestampNs: '1479484860000208567', durationNs: '540032558', didSwitch: true },
    ] as never;

    const plain = analyzeOutages(events);
    const anchored = analyzeOutages(events, {
      anchor: anchorAt(1479484860000, HOST_NOW_MS),
    });

    expect(plain.newestRtcMs).toBeCloseTo(1479484860000, -1);
    // 锚点平移不改 newestRtcMs —— 水位线建在这个值上才不会漏事件
    expect(anchored.newestRtcMs).toBe(plain.newestRtcMs);
  });
});
