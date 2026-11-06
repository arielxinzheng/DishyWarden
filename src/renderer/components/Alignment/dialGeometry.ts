/**
 * 校准盘的几何与配色 —— 纯函数与常量，不含 JSX。
 *
 * 与 `dialPill.tsx`（只有 DialPill 组件）分开的理由有两个：
 *   1. 职责：几何计算和 React 无关，可单测；
 *   2. 工程：组件文件里混导出函数会破坏 Fast Refresh，页面一改就整页重载。
 *
 * 统一约定：角度一律是「罗盘角」，0° = 正上方，顺时针为正（N→E→S→W）。
 * TILT 盘把仰角换算成罗盘角（compass = 90 - elevation）后复用同一套画法，
 * 于是仰角盘不必再写一份三角函数 —— 之前那版各写一份，结果扇形带和刻度
 * 落在了相反的两侧，指针还被画到 viewBox 之外。
 */

export interface Point {
  x: number;
  y: number;
}

/** 罗盘角 → 屏幕坐标 */
export function polar(cx: number, cy: number, r: number, compassDeg: number): Point {
  const rad = ((compassDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/**
 * 圆环扇区（donut sector）路径。
 *
 * 用 (起点, 跨度) 而不是 (起, 止) 两个端点：方位角的推荐带会跨过 0°
 * （例如 -3°..7°），区间端点写法要在每个调用处做一次归一化，
 * 而「起点 + 正跨度」天然支持跨零，画弧方向也只有一个。
 */
export function donutSectorPath(
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
  startCompassDeg: number,
  spanDeg: number
): string {
  const outStart = polar(cx, cy, rOuter, startCompassDeg);
  const outEnd = polar(cx, cy, rOuter, startCompassDeg + spanDeg);
  const inEnd = polar(cx, cy, rInner, startCompassDeg + spanDeg);
  const inStart = polar(cx, cy, rInner, startCompassDeg);
  const largeArc = Math.abs(spanDeg) > 180 ? 1 : 0;

  return [
    `M ${outStart.x} ${outStart.y}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${outEnd.x} ${outEnd.y}`,
    `L ${inEnd.x} ${inEnd.y}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${inStart.x} ${inStart.y}`,
    'Z',
  ].join(' ');
}

/**
 * 对齐配色 —— 「指针变绿」这条正反馈的唯一定义处。
 *
 * inBand 为真时推荐带由灰转绿、指针由橙转绿；两个圆盘都从这里取色，
 * 不会出现「一个盘绿了另一个盘还是橙的」。
 */
export const DIAL_COLORS = {
  pointerOut: '#f97316',
  pointerIn: '#22c55e',
  bandOut: 'rgba(148, 163, 184, 0.14)',
  bandOutStroke: 'rgba(148, 163, 184, 0.30)',
  bandIn: 'rgba(34, 197, 94, 0.22)',
  bandInStroke: 'rgba(34, 197, 94, 0.55)',
  text: '#e2e8f0',
  subText: '#94a3b8',
  faint: '#64748b',
} as const;

export function dialPalette(inBand: boolean) {
  return inBand
    ? { pointer: DIAL_COLORS.pointerIn, band: DIAL_COLORS.bandIn, bandStroke: DIAL_COLORS.bandInStroke }
    : { pointer: DIAL_COLORS.pointerOut, band: DIAL_COLORS.bandOut, bandStroke: DIAL_COLORS.bandOutStroke };
}