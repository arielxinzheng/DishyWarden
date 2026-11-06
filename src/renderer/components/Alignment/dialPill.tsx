/**
 * 圆心引导牌。
 *
 * 底色必须是不透明的：指针从牌下方穿过时，半透明底会让数字和指针糊在一起。
 * 所以 GaugeDial 的绘制顺序是「带 → 刻度 → 指针 → 引导牌」，牌子永远在最上层。
 *
 * 几何与配色见 `dialGeometry.ts`（那里是纯函数，这里是唯一的组件）。
 */

import { DIAL_COLORS } from './dialGeometry';

interface DialPillProps {
  cx: number;
  cy: number;
  /** 主文案：「向东旋转 15.0°」/「已对齐」/「无期望值」 */
  main: string;
  /** 副文案：「推荐 23.0° – 33.0°」 */
  sub: string;
  color: string;
  width?: number;
}

export function DialPill({ cx, cy, main, sub, color, width = 100 }: DialPillProps) {
  return (
    <g>
      <rect
        x={cx - width / 2}
        y={cy - 16}
        width={width}
        height={32}
        rx={9}
        fill="#0a0a0a"
        fillOpacity={0.94}
        stroke={color}
        strokeOpacity={0.45}
      />
      <text x={cx} y={cy - 2} fill={color} fontSize="11.5" fontWeight="600" textAnchor="middle">
        {main}
      </text>
      <text
        x={cx}
        y={cy + 11}
        fill={DIAL_COLORS.subText}
        fontSize="9"
        textAnchor="middle"
        fontFamily="ui-monospace, monospace"
      >
        {sub}
      </text>
    </g>
  );
}