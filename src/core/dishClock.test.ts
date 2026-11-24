/**
 * 设备时钟锚点推定的单测。
 *
 * 数值全部取自 2026-11 现场真机的两份诊断报告
 * （`dishywarden-diagnostics-20261124020613.txt` / `…24031815.txt`）：
 *
 * - outage 时间戳落在 2016-11-18 附近，速率正确、基准错约 10 年
 * - `history.current = "398560"` 是开机秒数，不是 epoch
 * - 报告生成时刻 = host 的「现在」
 *
 * 这些用例的作用是：**下次有人动锚点规则时，先在这里看到哪个现场假设被打破**。
 */
import { describe, it, expect } from 'vitest';
import {
  estimateClockAnchor,
  deviceToHostMs,
  clockOffsetMs,
  isRtcReset,
  type ClockAnchor,
} from './dishClock';

/** 现场报告生成时刻（UTC）：02:06:13+08:00 / 03:18:15+08:00 */
const REPORT_T1 = Date.UTC(2026, 10, 23, 18, 6, 13);
const REPORT_T2 = Date.UTC(2026, 10, 23, 19, 18, 15);

/** 现场两份报告里 outages 最新一条的设备时钟读数（ms） */
const RTC_T1 = 1479481378560; // 02:06 报告首条
const RTC_T2 = 1479484860000; // 03:18 报告首条

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('estimateClockAnchor：什么时候不修正', () => {
  it('设备时钟落在合理区间 ⇒ 返回 null（不修正），即使有旧锚', () => {
    const staleAnchor: ClockAnchor = {
      deviceMs: RTC_T1,
      hostMs: REPORT_T1,
      uncertaintyMs: 30_000,
      source: 'observed',
    };
    // 设备 RTC 被固件/NTP 修好了：最新读数就是当代时间
    const anchor = estimateClockAnchor(staleAnchor, REPORT_T2 - MINUTE, REPORT_T2);
    expect(anchor).toBeNull();
  });

  it('设备时钟只是略快（未来 1 小时内）仍视为可信', () => {
    expect(estimateClockAnchor(null, REPORT_T2 + 30 * MINUTE, REPORT_T2)).toBeNull();
  });
  it('设备时钟超前一整天以上 ⇒ 不可信', () => {
    expect(estimateClockAnchor(null, REPORT_T2 + 2 * DAY, REPORT_T2)).not.toBeNull();
  });

  it('本轮没有事件（设备刚重启、窗口空）⇒ 沿用旧锚，不退回「可信」', () => {
    const prev: ClockAnchor = {
      deviceMs: RTC_T1,
      hostMs: REPORT_T1,
      uncertaintyMs: 30_000,
      source: 'observed',
    };
    // ⚠️ 若这里返回 null，下一轮会重新用 assumed 覆盖掉已经测准的 observed 锚
    expect(estimateClockAnchor(prev, null, REPORT_T2)).toBe(prev);
    expect(estimateClockAnchor(prev, 0, REPORT_T2)).toBe(prev);
    expect(estimateClockAnchor(prev, Number.NaN, REPORT_T2)).toBe(prev);
  });

  it('没有任何旧锚且本轮无事件 ⇒ null', () => {
    expect(estimateClockAnchor(null, null, REPORT_T2)).toBeNull();
  });
});

describe('estimateClockAnchor：现场 2016 年 RTC', () => {
  it('首轮只能假定「最新事件就是现在」⇒ assumed 锚，精度取 history 窗口量级', () => {
    const anchor = estimateClockAnchor(null, RTC_T1, REPORT_T1);
    expect(anchor).not.toBeNull();
    expect(anchor!.source).toBe('assumed');
    expect(anchor!.deviceMs).toBe(RTC_T1);
    expect(anchor!.hostMs).toBe(REPORT_T1);
    // 真实年龄未知，只能声明一个粗精度；12 小时 = history 窗口量级
    expect(anchor!.uncertaintyMs).toBe(12 * HOUR);
  });

  it('下一轮出现更新的事件 ⇒ observed 锚，精度 = 两轮实际间隔', () => {
    const assumed = estimateClockAnchor(null, RTC_T1, REPORT_T1)!;
    const anchor = estimateClockAnchor(assumed, RTC_T2, REPORT_T2)!;

    expect(anchor.source).toBe('observed');
    expect(anchor.deviceMs).toBe(RTC_T2);
    expect(anchor.hostMs).toBe(REPORT_T2);
    // 72 分钟的两轮间隔（两次报告时间差）
    expect(anchor.uncertaintyMs).toBe(REPORT_T2 - REPORT_T1);
    // 比 assumed 准得多
    expect(anchor.uncertaintyMs).toBeLessThan(assumed.uncertaintyMs);
  });

  it('没有更新的事件 ⇒ 沿用旧锚（RTC 速率实测是准的，不需要重测）', () => {
    const observed = estimateClockAnchor(
      estimateClockAnchor(null, RTC_T1, REPORT_T1),
      RTC_T2,
      REPORT_T2,
    )!;
    const again = estimateClockAnchor(observed, RTC_T2, REPORT_T2 + 30_000);
    expect(again).toBe(observed);
  });

  it('设备重启导致 RTC 跳回更早的基准 ⇒ 回到 assumed，下次重新校准', () => {
    const observed = estimateClockAnchor(null, RTC_T2, REPORT_T2)!;
    // 重启后 rtc 从零附近重新计时（远小于上一轮读数，且超过 1 小时容差）
    const rebooted = estimateClockAnchor(observed, 90_000, REPORT_T2 + HOUR)!;
    expect(rebooted.source).toBe('assumed');
    expect(rebooted.deviceMs).toBe(90_000);
    expect(rebooted.hostMs).toBe(REPORT_T2 + HOUR);
  });

  it('微小时间倒流（不足 1 小时）不算重启，保留旧锚', () => {
    const observed = estimateClockAnchor(null, RTC_T2, REPORT_T2)!;
    expect(estimateClockAnchor(observed, RTC_T2 - 5 * MINUTE, REPORT_T2 + 30_000)).toBe(observed);
  });
});

describe('换算', () => {
  it('无锚点 = 恒等（事件保留设备自己的时间轴）', () => {
    expect(deviceToHostMs(RTC_T1, null)).toBe(RTC_T1);
    expect(clockOffsetMs(null)).toBe(0);
  });

  it('有锚点时整体平移：同一锚点下相对间隔保持不变', () => {
    const anchor = estimateClockAnchor(null, RTC_T2, REPORT_T2)!;
    const newer = RTC_T2 + 7_840; // 03:18 报告里相邻的第二条
    const shifted = deviceToHostMs(newer, anchor) - deviceToHostMs(RTC_T2, anchor);
    expect(shifted).toBe(7_840);
    // 偏移量本身是 10 年量级
    expect(clockOffsetMs(anchor)).toBeGreaterThan(9 * 365 * DAY);
  });

  it('现场数值：2016 年的读数被搬到 2026-11，既不是 2016 也不是 2073', () => {
    // 首轮锚点（assumed）把最新事件对齐到报告时刻
    const anchor = estimateClockAnchor(null, RTC_T2, REPORT_T2)!;
    const shifted = deviceToHostMs(RTC_T2, anchor);
    expect(new Date(shifted).getUTCFullYear()).toBe(2026);
    expect(shifted).toBe(REPORT_T2);

    // 更早的那条现场事件：被搬到报告时刻之前 58 分钟，仍落在同一天
    const earlier = deviceToHostMs(RTC_T1, anchor);
    expect(new Date(earlier).toISOString().slice(0, 10)).toBe('2026-11-23');
    expect(earlier).toBeLessThan(REPORT_T2);
    expect(REPORT_T2 - earlier).toBe(RTC_T2 - RTC_T1);
  });
});

describe('isRtcReset：重启判据（锚点与 rtc 水位线共用）', () => {
  it('没有上一轮读数 ⇒ 无从比较，不算跳变', () => {
    expect(isRtcReset(null, 90_000)).toBe(false);
  });

  it('正常运行（读数前进）⇒ 不是跳变', () => {
    expect(isRtcReset(RTC_T2, RTC_T2 + 30_000)).toBe(false);
  });

  it('微小倒流（不足 1 小时）⇒ 不是跳变；超出容差 ⇒ 是跳变', () => {
    expect(isRtcReset(RTC_T2, RTC_T2 - 5 * MINUTE)).toBe(false);
    expect(isRtcReset(RTC_T2, RTC_T2 - 2 * HOUR)).toBe(true);
  });

  it('重启后 rtc 从零附近重新计时 ⇒ 跳变（水位线必须归零，否则新事件全被吞掉）', () => {
    expect(isRtcReset(RTC_T2, 90_000)).toBe(true);
  });

  it('本轮没有读数（0 / NaN）⇒ 不是跳变，别把水位线误清空', () => {
    expect(isRtcReset(RTC_T2, 0)).toBe(false);
    expect(isRtcReset(RTC_T2, Number.NaN)).toBe(false);
  });

  it('与锚点重置同一个判据：判为跳变的那一瞬，锚点也退回 assumed', () => {
    const observed = estimateClockAnchor(null, RTC_T2, REPORT_T2)!;
    const nextDeviceMs = 90_000; // 重启后
    expect(isRtcReset(observed.deviceMs, nextDeviceMs)).toBe(true);

    const anchor = estimateClockAnchor(observed, nextDeviceMs, REPORT_T2 + HOUR)!;
    expect(anchor.source).toBe('assumed');
  });
});