/**
 * 姿态估计状态 —— 底层枚举到「语义码」的唯一翻译层。
 *
 * ## 为什么必须集中在一处
 *
 * 枚举值来自 dish proto 的 `AttitudeEstimationState`：
 *
 *   FILTER_RESET / FILTER_INITIALIZING / FILTER_CONVERGED
 *   FILTER_CONVERGENCE_WARNING / INVALID_STATE
 *
 * 历史版本校准页写的是 `attitudeEstimationState === 'VALID'` —— **这个值在
 * 协议里根本不存在**。真实设备返回 FILTER_CONVERGED，于是恒等于「未对齐」，
 * 而且页面直接把这个字符串抛给用户看（`姿态估计: FILTER_CONVERGED`）。
 *
 * ## 为什么这里不返回文案
 *
 * 本模块是纯函数、无 React 依赖：页面、仪表盘卡片、将来的告警文案都能复用，
 * 保证同一台设备在三个地方不会被说成三种状态。
 * 但「说成哪句话」属于视图层 —— 这里只给**语义码**（state / tone）与原始数值，
 * 视图层用 `t()` 取当前语言。这样单元测试断言的是语义，不会被语言绑架。
 */

export type AttitudeTone = 'ok' | 'warn' | 'bad' | 'unknown';

/**
 * 姿态状态语义码。
 *
 * - unreported：设备压根没上报（undefined / 空串）
 * - unknown：上报了，但本软件不认识这个枚举值（固件差异，原文保留在 rawState）
 */
export type AttitudeStateCode =
  | 'converged'
  | 'convergence_warning'
  | 'initializing'
  | 'reset'
  | 'invalid'
  | 'unreported'
  | 'unknown';

export interface AttitudeStateView {
  /** 配色分级，UI 据此选颜色，不要自己再判一遍语义码 */
  tone: AttitudeTone;
  /** 图标字符，直接渲染（与语言无关） */
  icon: string;
  /** 语义码，视图层据此取 label / detail 文案 */
  state: AttitudeStateCode;
  /** 精度不确定度（度）；设备没给时为 undefined，视图层据此决定要不要加括号 */
  uncertaintyDeg?: number;
  /** state === 'unknown' 时的原始枚举值，仅用于展示以便现场排查固件差异 */
  rawState?: string;
  /** 滤波器是否已收敛 —— 判断「是否需要对用户喊话」的唯一依据 */
  converged: boolean;
}

const UNREPORTED_STATE: AttitudeStateView = {
  tone: 'unknown',
  icon: '⚪',
  state: 'unreported',
  converged: false,
};

/**
 * 枚举 → 语义码。
 *
 * `rawState` 大小写不敏感：主进程在不同固件上拿到的可能是
 * `FILTER_CONVERGED`，也可能是小写形式，不该因此在 UI 上分成两种状态。
 */
export function describeAttitudeState(
  rawState: string | undefined,
  uncertaintyDeg: number | undefined
): AttitudeStateView {
  const key = (rawState ?? '').trim().toUpperCase();
  if (!key) return UNREPORTED_STATE;

  // 精度只在设备真给了有效数字时才带出去，视图层据此渲染「(精度 ±x°)」
  const precision =
    uncertaintyDeg !== undefined && Number.isFinite(uncertaintyDeg)
      ? { uncertaintyDeg }
      : {};

  switch (key) {
    case 'FILTER_CONVERGED':
      return {
        tone: 'ok',
        icon: '🟢',
        state: 'converged',
        converged: true,
        ...precision,
      };

    case 'FILTER_CONVERGENCE_WARNING':
      return {
        tone: 'warn',
        icon: '🟡',
        state: 'convergence_warning',
        converged: false,
        ...precision,
      };

    case 'FILTER_INITIALIZING':
      return {
        tone: 'warn',
        icon: '🟡',
        state: 'initializing',
        converged: false,
        ...precision,
      };

    case 'FILTER_RESET':
      return {
        tone: 'warn',
        icon: '🟡',
        state: 'reset',
        converged: false,
        ...precision,
      };

    case 'INVALID_STATE':
      return {
        tone: 'bad',
        icon: '🔴',
        state: 'invalid',
        converged: false,
        ...precision,
      };

    default:
      // 未知枚举不做猜测，把原始值露出来，方便现场排查固件差异
      return {
        tone: 'unknown',
        icon: '⚪',
        state: 'unknown',
        rawState: rawState?.trim() || key,
        converged: false,
      };
  }
}
