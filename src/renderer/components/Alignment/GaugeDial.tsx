/**
 * 校准盘 —— 把 DialModel 画成一张 SVG 圆盘。
 *
 * 方位角盘与仰角盘共用这一个组件，差异只有三处：圆心、半径、刻度范围。
 * 因为 alignmentGuidance 已经把仰角换算成罗盘角，这里不需要第二套三角函数。
 *
 * 绘制顺序（不可调换）：
 *   推荐带 → 刻度 → 指针 → 引导牌 → 提示箭头
 * 引导牌必须压在指针之上，否则指针从牌下方穿过时数字和线条会糊成一团。
 */

import { DIAL_COLORS, dialPalette, donutSectorPath, polar } from './dialGeometry';
import { DialPill } from './dialPill';
import type { DialModel } from './alignmentGuidance';

interface GaugeGeometry {
  cx: number;
  cy: number;
  rOuter: number;
  rInner: number;
  /** 刻度点所在半径（在推荐带外侧） */
  tickR: number;
  pointerR: number;
  /** 刻度覆盖的罗盘角范围：全圆 0–355，仰角盘只有 0–90 */
  tickFrom: number;
  tickTo: number;
  tickStep: number;
  /** 圆心引导牌位置 */
  pillX: number;
  pillY: number;
  pillWidth: number;
}

const GAUGE: Record<'compass' | 'elevation', GaugeGeometry> = {
  compass: {
    cx: 100,
    cy: 100,
    rOuter: 76,
    rInner: 52,
    tickR: 82,
    pointerR: 76,
    tickFrom: 0,
    tickTo: 355,
    tickStep: 5,
    pillX: 100,
    pillY: 100,
    pillWidth: 100,
  },
  elevation: {
    // 圆心落在左下角，只画右上那 90°，视觉上是「仰角从水平抬到垂直」
    cx: 46,
    cy: 174,
    // 环半径比方位角盘小一档：象限盘的可视面积只有圆形盘的四分之一，
    // 环画满会让圆心牌没有地方摆（见下方 pillX/pillY 的取值推导）
    rOuter: 104,
    rInner: 80,
    tickR: 111,
    pointerR: 104,
    tickFrom: 0,
    tickTo: 90,
    tickStep: 5,
    // 牌子放右上角的空白区。这里的坐标不是随手填的：
    //   - 推荐带（仰角 71–81° ⇒ 罗盘角 9–19°）最右只到 x≈80，
    //   - 刻度点最小 y = cy - tickR = 63，
    // 所以 x 94–190 / y 28–60 这块是这张盘上唯一既不压带、也不压刻度、
    // 还能装下「推荐 71.0°–81.0°」整行的矩形。
    pillX: 142,
    pillY: 44,
    pillWidth: 96,
  },
};

export interface GaugeDialProps {
  variant: 'compass' | 'elevation';
  model: DialModel;
  /** 无障碍描述，例如「方位角校准盘」 */
  ariaLabel: string;
}

export function GaugeDial({ variant, model, ariaLabel }: GaugeDialProps) {
  const geo = GAUGE[variant];
  const palette = dialPalette(model.inBand);
  const ticks: number[] = [];
  for (let deg = geo.tickFrom; deg <= geo.tickTo; deg += geo.tickStep) ticks.push(deg);

  return (
    <svg
      viewBox="0 0 200 200"
      className="w-full max-w-[280px]"
      role="img"
      aria-label={`${ariaLabel}：${model.hintMain}，${model.hintSub}`}
    >
      {/* 推荐范围扇带 —— 未进带时灰色，进带时转绿（配色唯一来源：dialGeometry.dialPalette） */}
      {model.hasBand && (
        <path
          d={donutSectorPath(
            geo.cx,
            geo.cy,
            geo.rInner,
            geo.rOuter,
            model.bandStartCompass,
            model.bandSpanCompass
          )}
          fill={palette.band}
          stroke={palette.bandStroke}
          strokeWidth={0.8}
          className="transition-all duration-300"
        />
      )}

      {/* 刻度点 */}
      {ticks.map((deg) => {
        const p = polar(geo.cx, geo.cy, geo.tickR, deg);
        return <circle key={deg} cx={p.x} cy={p.y} r={0.9} fill="white" fillOpacity={0.35} />;
      })}

      {/* 方位标签只在全圆罗盘上有意义 —— 仰角盘没有「东南西北」 */}
      {variant === 'compass' && (
        <g fontFamily="ui-monospace, monospace" fontSize={9.5} fill={DIAL_COLORS.faint} textAnchor="middle">
          <text x={geo.cx} y={9}>N</text>
          <text x={193} y={geo.cy + 3.5}>E</text>
          <text x={geo.cx} y={197}>S</text>
          <text x={7} y={geo.cy + 3.5}>W</text>
        </g>
      )}

      {/* 指针 */}
      <g className="transition-all duration-300">
        {(() => {
          const tip = polar(geo.cx, geo.cy, geo.pointerR, model.pointerCompass);
          return (
            <>
              <line
                x1={geo.cx}
                y1={geo.cy}
                x2={tip.x}
                y2={tip.y}
                stroke={palette.pointer}
                strokeWidth={2.5}
                strokeLinecap="round"
              />
              <circle cx={tip.x} cy={tip.y} r={3.2} fill={palette.pointer} />
              <circle cx={geo.cx} cy={geo.cy} r={2.6} fill={palette.pointer} fillOpacity={0.7} />
            </>
          );
        })()}
      </g>

      {/* 圆心引导牌：直接说「该往哪转多少度」 */}
      <DialPill
        cx={geo.pillX}
        cy={geo.pillY}
        main={model.hintMain}
        sub={model.hintSub}
        color={model.inBand ? DIAL_COLORS.pointerIn : DIAL_COLORS.text}
        width={geo.pillWidth}
      />

      {/* 圆周提示箭头：沿切线指向前进方向，进带后消失 */}
      {model.nudgeClockwise !== null && (
        <HintArrow
          cx={geo.cx}
          cy={geo.cy}
          r={geo.tickR}
          compassDeg={
            // 往目标方向错开一点，别和指针末端叠在一起
            model.pointerCompass + (model.nudgeClockwise ? 20 : -20)
          }
          clockwise={model.nudgeClockwise}
          color={DIAL_COLORS.pointerOut}
        />
      )}
    </svg>
  );
}

interface HintArrowProps {
  cx: number;
  cy: number;
  r: number;
  compassDeg: number;
  clockwise: boolean;
  color: string;
}

/**
 * 切线方向的小三角。
 *
 * 罗盘角 θ 的屏幕方向单位向量是 (sin, -cos)，对 θ 求导得到「θ 增大方向」
 * 的切向 (-sin, cos) —— 顺时针就是这个方向。
 */
function HintArrow({ cx, cy, r, compassDeg, clockwise, color }: HintArrowProps) {
  const rad = ((compassDeg - 90) * Math.PI) / 180;
  const baseX = cx + r * Math.cos(rad);
  const baseY = cy + r * Math.sin(rad);

  // 切向（θ 增大 = 顺时针）
  const tx = -Math.sin(rad);
  const ty = Math.cos(rad);
  // 径向，用来给出三角形的底边宽度
  const nx = Math.cos(rad);
  const ny = Math.sin(rad);

  const dir = clockwise ? 1 : -1;
  const length = 9;
  const halfWidth = 4.5;

  const tip = `${baseX + dir * tx * length},${baseY + dir * ty * length}`;
  const corner1 = `${baseX + nx * halfWidth},${baseY + ny * halfWidth}`;
  const corner2 = `${baseX - nx * halfWidth},${baseY - ny * halfWidth}`;

  return <polygon points={`${tip} ${corner1} ${corner2}`} fill={color} fillOpacity={0.9} />;
}