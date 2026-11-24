/**
 * 「最近一次卫星切换是多久以前」的文案选择器
 *
 * ## 为什么需要这个
 *
 * 真机上出现过这个界面：`★ 卫星切换` 开着，图上却一个标记都没有，
 * 底下写着「该时间范围内没有卫星切换记录」—— 用户只能认为功能坏了。
 *
 * 实际情况是数据完全正常，只是**最近一次切换在 6.4 小时前**，
 * 而当时选的是 1H 窗口（连 6H 窗口都刚好差一点没覆盖到）。
 *
 * ⇒ 空态不能只说「没有」，还要说「最近一次在多久之前」：
 *   有具体时间说明链路是通的，用户也知道该把时间范围拉多长才能看到。
 *
 * 这里只做**纯计算**（毫秒 → 单位与数量），文案交给 i18n，
 * 这样五种语言共用一套分档规则，也方便单测。
 */

/** 分档单位：分钟 / 小时 / 天 */
export type HandoffAgeUnit = 'minutes' | 'hours' | 'days';

export interface HandoffAge {
  unit: HandoffAgeUnit;
  count: number;
}

/**
 * 把「距今多久」折算成最适合展示的单位。
 *
 * 分档规则（按人读数字的习惯，避免出现 "0.1 天" 这种）：
 * - 不足 1 小时 → 分钟（最少 1，避免出现"0 分钟前"）
 * - 不足 1 天   → 小时
 * - 其余        → 天
 *
 * 未来时间（时钟偏差导致的负数）按 1 分钟处理 —— 显示"1 分钟前"
 * 比显示"-3 分钟前"或"0 分钟前"都更不刺眼。
 */
export function describeHandoffAge(timestampMs: number, nowMs: number = Date.now()): HandoffAge {
  const elapsedMs = nowMs - timestampMs;
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  if (!Number.isFinite(elapsedMs) || elapsedMs < MINUTE) {
    return { unit: 'minutes', count: 1 };
  }
  if (elapsedMs < HOUR) {
    return { unit: 'minutes', count: Math.round(elapsedMs / MINUTE) };
  }
  if (elapsedMs < DAY) {
    return { unit: 'hours', count: Math.round(elapsedMs / HOUR) };
  }
  return { unit: 'days', count: Math.round(elapsedMs / DAY) };
}

/** 对应的 i18n key（五种语言同构） */
export function handoffAgeKey(age: HandoffAge): string {
  return `dashboard:chart.handoff_last_seen_${age.unit}`;
}
