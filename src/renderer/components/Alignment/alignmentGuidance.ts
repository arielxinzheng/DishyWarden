/**
 * 校准页的几何与引导语义 —— 纯函数，不碰 React、不碰 SVG 坐标、不碰文案。
 *
 * ## 分工
 *
 *   本文件          遥测数值 → 罗盘角空间的对齐模型（带在哪、指针在哪、该往哪转）
 *   guidanceText.ts 语义码 → 当前语言的人话（唯一允许拼文案的地方）
 *   dialGeometry.ts 罗盘角 → SVG 路径 / 配色（纯函数，无 JSX）
 *   dialPill.tsx    圆心引导牌（唯一的 JSX 零件）
 *   GaugeDial.tsx   把一个模型画成盘
 *
 * 视图层只做「把数字摆到屏幕上」，不再参与「差多少度、算不算对齐」的判断。
 * 之前这段逻辑散在 JSX 里，方位角和仰角各写一份三角函数，结果两盘对同一台
 * 设备能给出相反的结论。
 *
 * ## 为什么这里只说「语义码」
 *
 * 本模块不返回任何句子，只返回：
 *   - action：要用户做什么（对齐了 / 没期望值 / 旋转 / 抬高 / 降低）
 *   - direction：往哪边动（cw = 罗盘角增大 / ccw = 罗盘角减小 / none）
 *   - adjustDeg：要动多少度（绝对值）
 *   - bandLow/HighDeg：推荐区间边界（视图层负责格式化与单位）
 * 文案由视图层按 action + direction 组装，换语言时本模块与单测纹丝不动。
 *
 * ## 角度约定
 *
 * 一律使用**罗盘角**：0° = 正上方，顺时针为正（N→E→S→W）。
 * 仰角先换算 `compass = 90 - elevation`（仰角 0° = 水平 = 罗盘角 90°；
 * 仰角 90° = 正上方 = 罗盘角 0°），于是两个盘共用同一套画法。
 */

import { normalizeAzimuth } from './format';

/**
 * 推荐带半宽（度）。
 *
 * 为什么是 ±5°：Starlink 终端本身有相控阵电扫能力，机械朝向差几度不影响
 * 链路；而给太宽的带会让用户以为「随便摆都行」，失去校准意义。
 * 与设备上报的 `desiredBoresight*` 一起构成推荐区间。
 */
export const DEFAULT_TOLERANCE_DEG = 5;

/** 罗盘角移动方向的语义码 */
export type GuidanceDirection = 'cw' | 'ccw' | 'none';

/** 圆心引导牌要表达的「动作」语义码 */
export type GuidanceAction = 'aligned' | 'no_expected' | 'rotate' | 'raise' | 'lower';

/** 需要用户实际搬动天线的动作（不含「已对齐 / 无期望值」） */
export type MoveAction = 'rotate' | 'raise' | 'lower';

/** 一个校准盘要画/要表达的一切（全部是数值与语义码，没有任何文案） */
export interface DialModel {
  /** 盘的类型：方位角盘 / 仰角盘（视图层据此选「朝向」「仰角」措辞） */
  kind: 'rotation' | 'elevation';
  /** 设备是否给出了期望值。false 时盘上没有绿带，也不能判「已对齐」 */
  hasBand: boolean;
  /** 推荐带起点（罗盘角，允许为负/超过 360，绘制函数内部自己归一） */
  bandStartCompass: number;
  /** 推荐带跨度（罗盘角，恒为正，可跨 0°） */
  bandSpanCompass: number;
  /** 指针当前位置（罗盘角，已归一） */
  pointerCompass: number;
  /** 指针是否落在推荐带内 */
  inBand: boolean;
  /**
   * 带符号偏差，null = 设备没给期望值。
   * 旋转盘的语义是罗盘角差（正 = 需向东），仰角盘是仰角差（正 = 需抬高）。
   * 供参数表如实展示，避免页面自己再算一遍 shortestDelta。
   */
  deltaDeg: number | null;
  /** 圆心引导牌要表达的动作 */
  action: GuidanceAction;
  /** 动作方向（cw = 顺时针/向东、ccw = 逆时针/向西、none = 无需动作） */
  direction: GuidanceDirection;
  /** 需要调整的角度绝对值（度）；无需调整时为 null */
  adjustDeg: number | null;
  /** 推荐区间下界（方位角已缩放 0–360；仰角为原始仰角）；无期望值时为 null */
  bandLowDeg: number | null;
  /** 推荐区间上界，同上 */
  bandHighDeg: number | null;
  /** 圆周提示箭头方向：true = 罗盘角增大（顺时针）；null = 不画箭头 */
  nudgeClockwise: boolean | null;
}

/** 设备没给期望值时的空模型（无带、不判对齐、不给箭头） */
const emptyModel = (
  kind: DialModel['kind'],
  pointerCompass: number
): DialModel => ({
  kind,
  hasBand: false,
  bandStartCompass: 0,
  bandSpanCompass: 0,
  pointerCompass,
  inBand: false,
  deltaDeg: null,
  action: 'no_expected',
  direction: 'none',
  adjustDeg: null,
  bandLowDeg: null,
  bandHighDeg: null,
  nudgeClockwise: null,
});

/**
 * 从 `from` 转到 `to` 的最短有符号角差，范围 [-180, 180)。
 * 正 = 罗盘角增大（顺时针 / 向东）；负 = 逆时针（向西）。
 */
export function shortestDelta(fromDeg: number, toDeg: number): number {
  return (((toDeg - fromDeg + 540) % 360) + 360) % 360 - 180;
}

/** 方位角盘：指针 = 波束方位角，带 = 期望方位角 ± 容差 */
export function rotationModel(
  azimuthDeg: number | undefined,
  desiredAzimuthDeg: number | undefined,
  toleranceDeg: number = DEFAULT_TOLERANCE_DEG
): DialModel {
  const pointerCompass = normalizeAzimuth(azimuthDeg ?? 0);

  if (desiredAzimuthDeg === undefined || !Number.isFinite(desiredAzimuthDeg)) {
    return emptyModel('rotation', pointerCompass);
  }

  const delta = shortestDelta(azimuthDeg ?? 0, desiredAzimuthDeg);
  const inBand = Math.abs(delta) <= toleranceDeg;
  const bandLow = normalizeAzimuth(desiredAzimuthDeg - toleranceDeg);
  const bandHigh = normalizeAzimuth(desiredAzimuthDeg + toleranceDeg);

  return {
    kind: 'rotation',
    hasBand: true,
    // 起点写成「期望 - 容差」而非归一化后的值：跨度 2×容差 可能跨 0°，
    // donutSectorPath 的「起点 + 正跨度」写法天然支持，归一化反而会画反。
    bandStartCompass: desiredAzimuthDeg - toleranceDeg,
    bandSpanCompass: toleranceDeg * 2,
    pointerCompass,
    inBand,
    deltaDeg: delta,
    action: inBand ? 'aligned' : 'rotate',
    direction: inBand ? 'none' : delta > 0 ? 'cw' : 'ccw',
    adjustDeg: inBand ? null : Math.abs(delta),
    bandLowDeg: bandLow,
    bandHighDeg: bandHigh,
    nudgeClockwise: inBand ? null : delta > 0,
  };
}

/** 仰角 → 罗盘角（仰角 0° = 水平 = 罗盘 90°；仰角 90° = 垂直 = 罗盘 0°） */
export function elevationToCompass(elevationDeg: number): number {
  return 90 - elevationDeg;
}

/**
 * 倾斜/仰角盘：指针 = 波束仰角，带 = 期望仰角 ± 容差。
 *
 * 指针取 `boresightElevationDeg` 而不是 `tiltAngleDeg`：两者差一个固定安装
 * 偏移，而推荐带（desiredBoresightElevationDeg）是同一个 boresight 坐标系下的
 * 值 —— 拿物理倾斜角去和波束期望值比，会得到一个恒定的假偏差。
 * `tiltAngleDeg` 仍在页面参数表里如实展示。
 */
export function elevationModel(
  elevationDeg: number | undefined,
  desiredElevationDeg: number | undefined,
  toleranceDeg: number = DEFAULT_TOLERANCE_DEG
): DialModel {
  const pointerCompass = elevationToCompass(elevationDeg ?? 0);

  if (desiredElevationDeg === undefined || !Number.isFinite(desiredElevationDeg)) {
    return emptyModel('elevation', pointerCompass);
  }

  // 仰角空间的差值：正 = 需要抬高
  const delta = desiredElevationDeg - (elevationDeg ?? 0);
  const inBand = Math.abs(delta) <= toleranceDeg;
  const lowElevation = desiredElevationDeg - toleranceDeg;
  const highElevation = desiredElevationDeg + toleranceDeg;

  return {
    kind: 'elevation',
    hasBand: true,
    // 仰角越高 → 罗盘角越小，所以带起点取「期望 + 容差」的罗盘角
    bandStartCompass: elevationToCompass(highElevation),
    bandSpanCompass: toleranceDeg * 2,
    pointerCompass,
    inBand,
    deltaDeg: delta,
    action: inBand ? 'aligned' : delta > 0 ? 'raise' : 'lower',
    // 抬高 = 罗盘角变小 = 逆时针；降低 = 顺时针
    direction: inBand ? 'none' : delta > 0 ? 'ccw' : 'cw',
    adjustDeg: inBand ? null : Math.abs(delta),
    bandLowDeg: lowElevation,
    bandHighDeg: highElevation,
    // 抬高 = 罗盘角变小 = 逆时针；降低 = 顺时针
    nudgeClockwise: inBand ? null : delta < 0,
  };
}

export interface PendingAdjustment {
  action: MoveAction;
  direction: GuidanceDirection;
  /** 需要调整的角度绝对值（度） */
  adjustDeg: number;
}

export type AlignmentVerdictCode = 'calibrating' | 'missing_expected' | 'aligned' | 'almost';

export interface AlignmentVerdict {
  /** 三件事同时成立才算对齐：滤波器收敛 + 两个盘都进带 */
  aligned: boolean;
  /** 结论语义码，视图层据此选顶部横幅主文案 */
  code: AlignmentVerdictCode;
  /** 还没到位的动作，视图层按 action/direction/adjustDeg 组装副文案 */
  pending: PendingAdjustment[];
}

/**
 * 综合结论。
 *
 * 顺序刻意如此：先看姿态滤波器，再看两个机械维度。滤波器没收敛时，
 * 盘上的指针本身就是漂的，此时催用户「向东转 15°」只会让人白费力气 ——
 * 那是最容易让用户骂人的一种错误引导。
 */
export function judgeAlignment(
  converged: boolean,
  rotation: DialModel,
  tilt: DialModel
): AlignmentVerdict {
  if (!converged) {
    return { aligned: false, code: 'calibrating', pending: [] };
  }

  if (!rotation.hasBand || !tilt.hasBand) {
    return { aligned: false, code: 'missing_expected', pending: [] };
  }

  if (rotation.inBand && tilt.inBand) {
    return { aligned: true, code: 'aligned', pending: [] };
  }

  const pending: PendingAdjustment[] = [rotation, tilt]
    .filter((model) => !model.inBand && model.action !== 'aligned' && model.action !== 'no_expected')
    .map((model) => ({
      action: model.action as MoveAction,
      direction: model.direction,
      adjustDeg: model.adjustDeg ?? 0,
    }));

  return { aligned: false, code: 'almost', pending };
}
