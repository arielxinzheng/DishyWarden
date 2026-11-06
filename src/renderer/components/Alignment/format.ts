/**
 * 角度格式化 —— 校准页所有度数的唯一出口。
 *
 * dish 上报的角度是 float32/float64 原始值，直接渲染会出现
 * 「24.799999237060547°」这类噪声。校准页的用途是让人照着数字去掰天线，
 * 一位小数足够，多位小数只会让人怀疑设备坏了。
 *
 * 为什么不散落写 `${x.toFixed(1)}°`：
 *   - 散落写法必然漏掉 NaN/undefined 分支，页面出现「NaN°」；
 *   - 单位符号 ° 会有一半地方写成 `°`、一半写成 ` 度`。
 */

/** `24.799999...` → `24.8°`；无有效值时 → `—` */
export function formatDeg(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  // `-0` 会被 toFixed 渲染成 `-0.0`，看起来像读数异常
  const normalized = Object.is(value, -0) ? 0 : value;
  return `${normalized.toFixed(digits)}°`;
}

/** 带符号的偏差：`+3.2°` / `-3.2°` / `0.0°` */
export function formatSignedDeg(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const text = formatDeg(value, digits);
  return value > 0 ? `+${text}` : text;
}

/** 角度归一化到 [0, 360) —— 用于「推荐 -3°–7°」这种跨零区间的人类可读展示 */
export function normalizeAzimuth(deg: number): number {
  return ((deg % 360) + 360) % 360;
}