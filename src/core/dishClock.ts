/**
 * 设备时钟推定 —— 把 dish 自己报的时间戳换算成 host 的 epoch 毫秒。
 *
 * ## 为什么需要这一层
 *
 * 真机（固件 2026.10.27）的 outage 时间戳来自设备 RTC，而那个 RTC 是错的：
 * `startTimestampNs = "1479481378560372964"` ⇒ 2016-11-18，比真实时间早约 10 年。
 * **速率是对的，基准是错的** —— 不做换算，事件会统一落在 2016 年，
 * 永远在查询窗口之外，仪表盘上的切换标记一条都不出现。
 *
 * 同一份响应里 `history.current = "398560"` 是**开机秒数**，不是 epoch。
 * 拿它当「设备现在」会算出 2073 年的偏移 —— 这个坑真机踩过。
 *
 * ## 唯一可靠的锚
 *
 * 设备的绝对时间只能靠「某个设备时钟读数 ↔ 同一个瞬间的 host 时刻」这对值建立。
 * dish 不提供「当前 RTC 值」字段，所以只能从 outage 列表反推：
 *
 * - 数组按时间**升序**，最后一条是窗口内最新的
 * - 若这条最新事件是**本轮才第一次见到的** ⇒ 它发生在上一轮之后、这一轮之前，
 *   真实时刻与 hostNow 的差 ≤ 一个采集周期。这叫 `observed` 锚，可信。
 * - 应用刚启动时，数组里已有的最新事件可能发生在几小时前，年龄无从得知
 *   ⇒ 只能假定「它就在现在」。这叫 `assumed` 锚，误差上限是整个 history 窗口。
 *
 * ## 锚会变 ⇒ 事件的身份不能是 ts
 *
 * `assumed` → `observed` 时整个时间轴会平移。若库里用换算后的 ts 作主键，
 * 校准后同一条事件会算出新 ts，于是多出一行 —— 错位的历史永远修不回来。
 * 正确做法是**用设备时钟值（rtc_ms）作身份**，ts 只是对它的当前解释，
 * 校准后覆盖同一行即可。
 *
 * ## 为什么不做「持续量化漂移」
 *
 * 设备 RTC 的速率实测是准的（同一窗口内相邻事件的时间差与真实间隔一致），
 * 所以只需要一个基准点，不需要持续估计频率偏差。真正需要「持续」的是
 * 基准点本身：每当出现新事件就重测一次，越测越准。
 */

/** 设备时钟与 host 时钟之间的一个对应点 */
export interface ClockAnchor {
  /** 设备时钟读数（毫秒），来自 outage 时间戳换算 */
  deviceMs: number;
  /** 同一瞬间的 host 时刻（epoch 毫秒） */
  hostMs: number;
  /**
   * 精度上界（毫秒）：`hostMs` 与该设备读数真实发生时刻的最大偏差。
   *
   * - `observed` 锚 = 两轮观测的实际间隔
   * - `assumed` 锚 = 真实年龄未知，取 history 窗口的量级
   */
  uncertaintyMs: number;
  /** 锚是怎么来的 */
  source: 'observed' | 'assumed';
}

/**
 * 「设备时钟可信」的判据。
 *
 * 设备自己报的时间如果落在 `[hostNow - 30 天, hostNow + 1 天]` 内，
 * 就认为它的 RTC 是对的，**不做任何修正**。这条门限不能省：
 * 一台时钟正常的设备，最新事件本来就可能发生在几十分钟前，
 * 若一律把它对齐到「现在」，等于每轮都给事件加上一个随机偏移。
 */
export interface ClockPlausibility {
  /** 可接受的最旧程度 */
  pastMs: number;
  /** 可接受的超前程度（设备时钟略快是常态） */
  futureMs: number;
}

const DEFAULT_PLAUSIBILITY: ClockPlausibility = {
  pastMs: 30 * 24 * 60 * 60 * 1000,
  futureMs: 24 * 60 * 60 * 1000,
};

/** estimateClockAnchor 的可调参数（默认值即生产值） */
export interface ClockAnchorOptions {
  /**
   * 设备 RTC 跳变的容差（毫秒）。
   *
   * 设备重启后 RTC 可能从另一个基准重新计时，此时最新读数会**明显小于**
   * 上一轮，旧锚立刻失效。小于这个跨度不算跳变 —— 正常的时间倒流不会
   * 超过一个 history 窗口，而 RTC 重置往往是十年量级。
   */
  rtcResetToleranceMs?: number;
  /** `assumed` 锚的精度上界（毫秒），取 history 窗口的量级 */
  assumedUncertaintyMs?: number;
  plausibility?: ClockPlausibility;
}

const DEFAULT_RTC_RESET_TOLERANCE_MS = 60 * 60 * 1000;
const DEFAULT_ASSUMED_UNCERTAINTY_MS = 12 * 60 * 60 * 1000;

/**
 * 设备 RTC 是否跳回了更早的基准（设备重启）。
 *
 * 这个判据有两个消费者，必须共用同一份实现：
 *
 * 1. `estimateClockAnchor` —— 旧锚立即失效，回到 `assumed`
 * 2. 采集器的 rtc 水位线（`historian.ts`）—— 必须归零，否则重启后所有事件
 *    都小于旧水位线，会被当成「早就处理过」而永久吞掉
 *
 * 两处各写一遍迟早早样：一边改了容差，另一边还在按旧阈值判，重启后切换标记
 * 就会静态消失，且没有任何报错。
 */
export function isRtcReset(
  prevDeviceMs: number | null,
  newestDeviceMs: number,
  options: ClockAnchorOptions = {},
): boolean {
  if (prevDeviceMs === null) return false;
  if (!Number.isFinite(newestDeviceMs) || newestDeviceMs <= 0) return false;
  const tolerance = options.rtcResetToleranceMs ?? DEFAULT_RTC_RESET_TOLERANCE_MS;
  return newestDeviceMs < prevDeviceMs - tolerance;
}

/**
 * 根据本轮观测到的设备时钟读数，更新锚点。
 *
 * 纯函数 —— 状态由调用方持有，这样才能直接对着现场真实数值做单测。
 *
 * @param prev 上一轮的锚；`null` 表示「没有修正」（设备时钟可信，或还没建立锚）
 * @param newestDeviceMs 本轮所有事件里最新的设备时钟读数（毫秒）；无事件时传 null
 * @param hostNow 本轮采集的 host 时刻（epoch 毫秒）
 * @returns 下一轮的锚；`null` = 设备时钟可信，不要修正
 */
export function estimateClockAnchor(
  prev: ClockAnchor | null,
  newestDeviceMs: number | null,
  hostNow: number,
  options: ClockAnchorOptions = {},
): ClockAnchor | null {
  const assumedUncertainty = options.assumedUncertaintyMs ?? DEFAULT_ASSUMED_UNCERTAINTY_MS;
  const { pastMs, futureMs } = options.plausibility ?? DEFAULT_PLAUSIBILITY;

  // 本轮一条事件都没有（设备刚重启、窗口空）：没有新信息，沿用旧锚。
  // 注意这里**不能**返回 null —— 否则下一轮会被当成首轮，重新用 assumed
  // 覆盖掉已经测准的 observed 锚。
  if (newestDeviceMs === null || !Number.isFinite(newestDeviceMs) || newestDeviceMs <= 0) {
    return prev;
  }

  // 设备时钟落在合理区间 ⇒ 它是对的，不做修正（同时也就丢弃了旧锚，
  // 覆盖设备 RTC 被固件/NTP 修好的情况）
  if (newestDeviceMs > hostNow - pastMs && newestDeviceMs < hostNow + futureMs) {
    return null;
  }

  const assumed = (): ClockAnchor => ({
    deviceMs: newestDeviceMs,
    hostMs: hostNow,
    uncertaintyMs: assumedUncertainty,
    source: 'assumed',
  });

  // 首轮：不知道这条最新事件发生在多久以前 ⇒ 只能假定「就是现在」
  if (!prev) return assumed();

  // RTC 跳变（设备重启）：旧锚失效，回到 assumed，下次出现新事件时再校准
  if (isRtcReset(prev.deviceMs, newestDeviceMs, options)) return assumed();

  if (newestDeviceMs > prev.deviceMs) {
    // 出现了上一轮还没见到的事件 ⇒ 它发生在这两轮之间。
    // 这是唯一能给出「真实时刻」的观测，精度 = 两轮的实际间隔。
    return {
      deviceMs: newestDeviceMs,
      hostMs: hostNow,
      uncertaintyMs: Math.max(0, hostNow - prev.hostMs),
      source: 'observed',
    };
  }

  // 没有新事件：设备 RTC 速率实测是准的，旧锚依然成立
  return prev;
}

/**
 * 把一个设备时钟读数换算成 host epoch 毫秒。
 *
 * 锚为 `null`（设备时钟可信）时原样返回。
 */
export function deviceToHostMs(deviceMs: number, anchor: ClockAnchor | null): number {
  if (!anchor) return deviceMs;
  return deviceMs + (anchor.hostMs - anchor.deviceMs);
}

/** 锚对应的偏移量（host = device + offset）；无锚时为 0。用于日志与诊断输出 */
export function clockOffsetMs(anchor: ClockAnchor | null): number {
  return anchor ? anchor.hostMs - anchor.deviceMs : 0;
}