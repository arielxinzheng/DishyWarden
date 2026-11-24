/**
 * Outage 分析器 —— 识别卫星切换事件
 * 
 * 从 dishGetHistory 的 outages 数组中识别卫星切换相关的中断，
 * 并提取切换时间、持续时长等关键信息。
 */

import {
  Outage,
  RawOutage,
  OutageCause,
  isHandoffOutage,
  parseOutageCause,
  normalizeOutage,
  HANDOFF_MAX_DURATION_MS,
} from './outageTypes';
import { ClockAnchor, clockOffsetMs, deviceToHostMs } from './dishClock';

/**
 * 卫星切换事件
 */
export interface HandoffEvent {
  /**
   * 设备时钟值（毫秒，**未经校准**）—— 事件在库里的稳定身份。
   *
   * `timestamp` 只是「按当前锚点对 rtcMs 的解释」，锚点变化时它会平移；
   * 而 rtcMs 永远不变。所以去重、覆盖写、水位线都必须基于这个字段，
   * 否则每次校准都会在库里留下一条错位的重复事件。
   */
  rtcMs: number;
  /** 切换发生时间戳（毫秒级 epoch，已按锚点换算到 host 时钟） */
  timestamp: number;
  /** 切换持续时长（毫秒） */
  durationMs: number;
  /** 原始 outage cause */
  cause: string;
  /** 解析后的 cause 枚举 */
  parsedCause: OutageCause;
  /** 是否为明确的切换标识（vs 隐式推断） */
  isExplicit: boolean;
}

/**
 * outage 时间戳 / 时长的单位
 *
 * - `s`  秒
 * - `ms` 毫秒
 * - `us` 微秒
 * - `ns` 纳秒
 */
export type TimestampUnit = 's' | 'ms' | 'us' | 'ns';

/**
 * 把一个数值按给定单位换算成毫秒。
 *
 * 秒要**乘** 1000（1 秒 = 1000 毫秒），微秒/纳秒要**除**（它们比毫秒更细）。
 */
function scaleToMs(value: number, unit: TimestampUnit): number {
  switch (unit) {
    case 's':
      return value * 1000;
    case 'ms':
      return value;
    case 'us':
      return value / 1000;
    case 'ns':
      return value / 1000000;
  }
}

/**
 * 判定一个**绝对** epoch 时间戳的单位。
 *
 * ## 为什么按数量级判定
 *
 * 绝对时间戳的数量级天然带着单位信息 —— 今天的 epoch 大约是：
 *
 * | 单位 | 今天的值 | 覆盖到 5138 年的上界 |
 * |------|----------|----------------------|
 * | 秒   | ~1.8e9   | 1e11                 |
 * | 毫秒 | ~1.8e12  | 1e14                 |
 * | 微秒 | ~1.8e15  | 1e17                 |
 * | 纳秒 | ~1.8e18  | —                    |
 *
 * 过去这个函数把 **≥1e11 一律当毫秒**，于是纳秒(1.8e18)和微秒(1.8e15)
 * 都被当成毫秒 —— 时间戳落到公元 5 万多年，事件永远在查询窗口之外，
 * 仪表盘上的卫星切换标记一个都不出现。
 *
 * 真机到底发哪种单位没有权威文档（`outageTypes.ts` 里那句「真实设备也用毫秒」
 * 是照着 mock 推的，没在真机上验证过），所以这里**不写死假设**，按数量级自适应。
 *
 * @param value - 时间戳（number 或 protobuf int64 序列化出的字符串）
 * @returns 判定出的单位；值非法时返回 null
 */
export function detectTimestampUnit(value: unknown): TimestampUnit | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1e11) return 's';
  if (n < 1e14) return 'ms';
  if (n < 1e17) return 'us';
  return 'ns';
}

/**
 * 把 outage 的开始时间戳规整成**毫秒级 epoch**。
 *
 * 单位按上面的数量级自适应（秒 / 毫秒 / 微秒 / 纳秒都能正确落到毫秒）。
 *
 * @param startTimestamp - 原始时间戳（number 或字符串）
 * @returns 毫秒级 epoch；值非法时返回 0
 */
export function toEpochMs(startTimestamp: unknown): number {
  const n = typeof startTimestamp === 'number'
    ? startTimestamp
    : Number(startTimestamp);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = detectTimestampUnit(n);
  if (!unit) return 0;
  return scaleToMs(n, unit);
}

/**
 * 把 outage 的持续时长规整成**毫秒**。
 *
 * ## 为什么时长也要判定单位
 *
 * 同一个设备的时钟单位在时间戳和时长上是一致的，所以**以时间戳判出的单位为准**。
 * 但真机上存在「时间戳是毫秒、时长却是纳秒」这种字段各自为政的情况，
 * 于是加一条兜底：时间戳单位是秒/毫秒、而时长却落在纳秒/微秒量级时，
 * 时长按更细的单位换算。
 *
 * 判据（时长是相对量，没有 epoch 锚点，只能按量级）：
 * - ≥1e9 ⇒ 纳秒（今天的 2 秒 = 2e9 ns）
 * - ≥1e6 ⇒ 微秒（今天的 2 秒 = 2e6 µs）
 * - 其余  ⇒ 毫秒（今天的 2 秒 = 2000 ms）
 *
 * @param duration - 原始时长
 * @param timestampUnit - 时间戳判出的单位，作为主判据
 * @returns 毫秒级时长；值非法时返回 0
 */
export function toDurationMs(duration: unknown, timestampUnit: TimestampUnit | null): number {
  const d = typeof duration === 'number' ? duration : Number(duration);
  if (!Number.isFinite(d) || d <= 0) return 0;

  // 主判据: 时间戳判出的单位(同一设备同一时钟)
  const byTimestamp = timestampUnit ? scaleToMs(d, timestampUnit) : d;

  // 合理的中断时长区间: 1 毫秒 ~ 1 小时
  const plausible = (ms: number) => ms >= 1 && ms <= 3600000;
  if (plausible(byTimestamp)) return byTimestamp;

  // 回落: 字段名就是 durationMs, 契约上是毫秒。
  // 真机上可能出现「时间戳是纳秒、时长却是毫秒」这种字段各自为政的情况。
  if (plausible(d)) return d;

  return byTimestamp;
}

/**
 * Outage 分析结果
 */
export interface OutageAnalysis {
  /** 检测到的卫星切换事件 */
  handoffs: HandoffEvent[];
  /** 其他类型的中断事件 */
  otherOutages: Outage[];
  /** 总中断次数 */
  totalOutages: number;
  /** 卫星切换占比 */
  handoffRatio: number;
  /**
   * 本轮把设备时钟搬到 host 时钟所用的锚。
   * `null` = 设备时钟可信，没有做任何换算。
   *
   * 调用方负责保存它，下一轮连同 `newestRtcMs` 一起喂给
   * `estimateClockAnchor` 推进（见 `dishClock.ts` 开篇）。
   */
  clockAnchor: ClockAnchor | null;
  /**
   * 本轮所有事件里最新的设备时钟值（毫秒，未校准）；没有事件时为 0。
   *
   * 水位线与锚点推进都必须基于它 —— 不能用 `timestamp`：锚点一变，
   * 同一批事件的时间戳就整体平移，水位线跟着飘会漏事件或重复写。
   */
  newestRtcMs: number;
}

/**
 * 分析 outages 数组，识别卫星切换事件
 *
 * ## 为什么时钟修正必须由调用方传入锚
 *
 * 设备的时钟偏差只能从「跨轮」比较里看出来：这一轮看到的最新事件是不是
 * 上一轮之后出现的，决定它能不能被当作「现在」。跨轮状态不属于纯函数的
 * 职责，所以这里只做换算，锚点由调用方持有并推进
 * （`estimateClockAnchor`，见 `dishClock.ts`）。
 *
 * 不传锚点 = 不做任何修正，事件保留设备自己的时间轴。这比编一个假时间诚实：
 * 错的时间轴至少在相对位置上是正确的，且能被诊断报告一眼看出来。
 *
 * @param outages - dishGetHistory 返回的 outages 数组
 * @param options.anchor - 调用方持有的时钟锚；null/省略 = 设备时钟可信，不修正
 */
export function analyzeOutages(
  outages: RawOutage[],
  options: { anchor?: ClockAnchor | null } = {},
): OutageAnalysis {
  const anchor = options.anchor ?? null;
  const handoffs: HandoffEvent[] = [];
  const otherOutages: Outage[] = [];

  // 先把所有事件的时间戳/时长规整成毫秒，再统一换算时间基准 ——
  // 单条事件各自处理会得到不一致的结果。
  const prepared = outages.map((raw) => {
    const normalized = normalizeOutage(raw);
    const unit = detectTimestampUnit(normalized.startTimestamp);
    const rtcMs = toEpochMs(normalized.startTimestamp);
    return {
      rtcMs,
      normalized: {
        ...normalized,
        startTimestamp: rtcMs,
        durationMs: toDurationMs(normalized.durationMs, unit),
      },
      unit,
    };
  });

  const newestRtcMs = prepared.reduce((max, p) => (p.rtcMs > max ? p.rtcMs : max), 0);

  for (const { rtcMs, normalized } of prepared) {
    // 只搬时间戳，不动时长 —— 时长是时长，跟时钟基准无关
    const timestampMs = deviceToHostMs(rtcMs, anchor);

    const normalizedOutage: Outage = {
      ...normalized,
      startTimestamp: timestampMs,
    };

    if (isHandoffOutage(normalizedOutage)) {
      // 兼容 DishyMock (triggered) 和真实设备 (cause)
      const causeStr = normalized.cause || normalized.triggered || 'UNKNOWN';

      // 判断是否为明确的切换标识：设备自报 didSwitch 优先，
      // 其次看 cause 里有没有 HANDOFF/SWITCHING 这类字面标识
      const causeUpper = causeStr.toUpperCase();
      const isExplicit =
        normalized.didSwitch === true ||
        causeUpper.includes('HANDOFF') ||
        causeUpper.includes('SWITCHING') ||
        causeUpper.includes('HANDOVER');

      handoffs.push({
        rtcMs,
        timestamp: timestampMs,
        durationMs: normalized.durationMs,
        cause: causeStr,
        parsedCause: parseOutageCause(causeStr),
        isExplicit,
      });
    } else {
      otherOutages.push(normalizedOutage);
    }
  }

  // 诊断日志: 真机 outages 的单位没有权威文档, 这行日志能让远程实测机上
  // 一眼看出设备发的是秒/毫秒/微秒/纳秒、时钟偏了多少。
  // 只打印数量级与计数, 不打印原始条目(避免把设备标识带进日志)。
  // 只在异常时打印: 数量为 0, 或单位不是毫秒, 或做了时钟校准 —— 正常情况不刷屏。
  if (outages.length === 0) {
    console.log('[outage] outages=0 设备没有返回任何中断记录');
  } else {
    const first = prepared[0];
    const offset = clockOffsetMs(anchor);
    if (first.unit !== 'ms' || offset !== 0) {
      console.log(
        `[outage] outages=${outages.length} unit=${first.unit} ` +
          `first_rtc_magnitude=${first.rtcMs.toExponential(2)} ` +
          `first_duration_ms=${first.normalized.durationMs} ` +
          `clock_offset_ms=${offset} clock_source=${anchor?.source ?? 'trusted'}`
      );
    }
  }

  const totalOutages = outages.length;
  const handoffRatio = totalOutages > 0 ? handoffs.length / totalOutages : 0;

  return {
    handoffs,
    otherOutages,
    totalOutages,
    handoffRatio,
    clockAnchor: anchor,
    newestRtcMs,
  };
}

/**
 * 过滤指定时间窗口内的卫星切换事件
 * 
 * @param handoffs - 卫星切换事件数组
 * @param startMs - 窗口起始时间（毫秒级 epoch）
 * @param endMs - 窗口结束时间（毫秒级 epoch）
 * @returns 窗口内的切换事件
 */
export function filterHandoffsByTimeWindow(
  handoffs: HandoffEvent[],
  startMs: number,
  endMs: number
): HandoffEvent[] {
  return handoffs.filter(h => h.timestamp >= startMs && h.timestamp <= endMs);
}

/**
 * 计算卫星切换频率
 * 
 * @param handoffs - 卫星切换事件数组
 * @param windowMs - 统计窗口时长（毫秒）
 * @returns 每小时切换次数
 */
export function calculateHandoffFrequency(
  handoffs: HandoffEvent[],
  windowMs: number
): number {
  if (handoffs.length === 0 || windowMs <= 0) return 0;
  
  const windowHours = windowMs / 3600000;
  return handoffs.length / windowHours;
}

/**
 * 计算平均切换持续时长
 * 
 * @param handoffs - 卫星切换事件数组
 * @returns 平均持续时长（毫秒），无事件时返回 null
 */
export function calculateAverageHandoffDuration(
  handoffs: HandoffEvent[]
): number | null {
  if (handoffs.length === 0) return null;
  
  // ⚠️ 累加前显式转 number ——
  //   protobuf 的 int64 序列化成字符串, 直接 `sum + h.durationMs`
  //   会变成字符串拼接(0 + "2109" = "02109"), 平均时长算出 3.77e+222 这种垃圾值。
  const totalDuration = handoffs.reduce(
    (sum, h) => sum + (Number.isFinite(h.durationMs) ? h.durationMs : 0),
    0
  );
  return totalDuration / handoffs.length;
}

/**
 * 检测异常长的切换事件
 * 
 * 正常卫星切换应在 2-8 秒内完成，超过阈值可能表示其他问题
 * （如信号遮挡、无卫星覆盖等）
 * 
 * @param handoffs - 卫星切换事件数组
 * @param thresholdMs - 异常阈值（默认 10 秒）
 * @returns 异常长的切换事件
 */
export function detectAbnormalHandoffs(
  handoffs: HandoffEvent[],
  thresholdMs = HANDOFF_MAX_DURATION_MS
): HandoffEvent[] {
  return handoffs.filter(h => h.durationMs > thresholdMs);
}

/**
 * 生成 outage 分析摘要（用于日志和调试）
 * 
 * @param analysis - 分析结果
 * @returns 可读的摘要文本
 */
export function summarizeOutageAnalysis(analysis: OutageAnalysis): string {
  const { handoffs, otherOutages, totalOutages, handoffRatio } = analysis;
  
  const lines = [
    `总中断: ${totalOutages}`,
    `卫星切换: ${handoffs.length} (${(handoffRatio * 100).toFixed(1)}%)`,
    `其他中断: ${otherOutages.length}`,
  ];

  if (handoffs.length > 0) {
    const avgDuration = calculateAverageHandoffDuration(handoffs);
    const abnormal = detectAbnormalHandoffs(handoffs);
    
    lines.push(`平均切换时长: ${avgDuration?.toFixed(0)}ms`);
    
    if (abnormal.length > 0) {
      lines.push(`⚠️ 异常切换: ${abnormal.length} (>${HANDOFF_MAX_DURATION_MS}ms)`);
    }
  }

  return lines.join(', ');
}