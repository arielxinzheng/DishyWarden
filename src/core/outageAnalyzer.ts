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

/**
 * 卫星切换事件
 */
export interface HandoffEvent {
  /** 切换发生时间戳（毫秒级 epoch） */
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
 * 把 outage 的开始时间戳规整成**毫秒级 epoch**。
 *
 * ## 单位约定
 *
 * DishyMock 的 `outages[].startTimestamp` 发的是**毫秒**
 * （其 `src/state/types.ts` 明确写着「若 ≤1e12 会被被测方乘 1000, 所以必须填毫秒」）。
 * 真实设备也用毫秒。
 *
 * 所以这里**不能再乘 1000** —— 之前乘了一次,
 * 时间戳变成 `1793671076044000`（公元 58000 年）,
 * 于是所有事件都落在时间窗之外, 图表上一个点都没有。
 *
 * 防御：若拿到的是**秒**级（< 1e11 约 1973 年后到 5138 年前的秒级时间戳
 * 数量级会落在 1e9 ~ 1e11），补齐到毫秒。
 */
export function toEpochMs(startTimestamp: unknown): number {
  const n = typeof startTimestamp === 'number'
    ? startTimestamp
    : Number(startTimestamp);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // 秒级时间戳量级: 1e9 (2001年) ~ 1e11 (5138年); 毫秒级: 1e12 以上
  return n < 1e11 ? n * 1000 : n;
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
}

/**
 * 分析 outages 数组，识别卫星切换事件
 * 
 * @param outages - dishGetHistory 返回的 outages 数组
 * @returns 分析结果
 */
export function analyzeOutages(
  outages: RawOutage[],
): OutageAnalysis {
  const handoffs: HandoffEvent[] = [];
  const otherOutages: Outage[] = [];

  for (const raw of outages) {
    // 规整数值字段(protobuf 的 int64 序列化成字符串)
    const normalized: Outage = normalizeOutage(raw);
    const startTimestamp = normalized.startTimestamp;
    const durationMs = normalized.durationMs;

    if (isHandoffOutage(normalized)) {
      // 规整成毫秒级 epoch(原始数据已是毫秒, 不要再乘 1000)
      const timestampMs = toEpochMs(startTimestamp);

      // 兼容 DishyMock (triggered) 和真实设备 (cause)
      const causeStr = normalized.cause || normalized.triggered || 'UNKNOWN';

      // 判断是否为明确的切换标识
      const causeUpper = causeStr.toUpperCase();
      const isExplicit =
        causeUpper.includes('HANDOFF') ||
        causeUpper.includes('SWITCHING') ||
        causeUpper.includes('HANDOVER');

      handoffs.push({
        timestamp: timestampMs,
        durationMs,
        cause: causeStr,
        parsedCause: parseOutageCause(causeStr),
        isExplicit,
      });
    } else {
      otherOutages.push(normalized);
    }
  }

  const totalOutages = outages.length;
  const handoffRatio = totalOutages > 0 ? handoffs.length / totalOutages : 0;

  return {
    handoffs,
    otherOutages,
    totalOutages,
    handoffRatio,
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