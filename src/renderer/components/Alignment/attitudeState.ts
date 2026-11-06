/**
 * 姿态估计状态 —— 底层枚举到「人话」的唯一翻译层。
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
 * ## 约束
 *
 * 这里是纯函数、无 React 依赖：页面、仪表盘卡片、将来的告警文案都能复用，
 * 保证同一台设备在三个地方不会被说成三种状态。
 */

import { formatDeg } from './format';

export type AttitudeTone = 'ok' | 'warn' | 'bad' | 'neutral';

export interface AttitudeStateView {
  /** 配色分级，UI 据此选颜色，不要自己再判一遍字符串 */
  tone: AttitudeTone;
  /** 图标字符，直接渲染 */
  icon: string;
  /** 主文案：「姿态传感器已就绪 (精度 ±0.4°)」 */
  label: string;
  /** 补充说明，用于 tooltip / 状态行副文案 */
  detail: string;
  /** 滤波器是否已收敛 —— 判断「是否需要对用户喊话」的唯一依据 */
  converged: boolean;
}

/** 精度括号：`(精度 ±0.4°)`；拿不到精度时为空串 */
function precisionNote(uncertaintyDeg: number | undefined): string {
  if (uncertaintyDeg === undefined || !Number.isFinite(uncertaintyDeg)) return '';
  return ` (精度 ±${formatDeg(uncertaintyDeg)})`;
}

const UNKNOWN_STATE: AttitudeStateView = {
  tone: 'neutral',
  icon: '⚪',
  label: '暂未收到姿态状态',
  detail: '设备尚未上报姿态估计结果，请确认已连接到天线',
  converged: false,
};

/**
 * 枚举 → 人话。
 *
 * `rawState` 大小写不敏感：主进程在不同固件上拿到的可能是
 * `FILTER_CONVERGED`，也可能是小写形式，不该因此在 UI 上分成两种状态。
 */
export function describeAttitudeState(
  rawState: string | undefined,
  uncertaintyDeg: number | undefined
): AttitudeStateView {
  const key = (rawState ?? '').trim().toUpperCase();
  if (!key) return UNKNOWN_STATE;

  switch (key) {
    case 'FILTER_CONVERGED':
      return {
        tone: 'ok',
        icon: '🟢',
        label: `姿态传感器已就绪${precisionNote(uncertaintyDeg)}`,
        detail: '姿态滤波器已收敛，读数可用于判断天线朝向',
        converged: true,
      };

    case 'FILTER_CONVERGENCE_WARNING':
      return {
        tone: 'warn',
        icon: '🟡',
        label: `姿态传感器正在收敛${precisionNote(uncertaintyDeg)}`,
        detail: '滤波器还没稳定，读数会持续漂移，请稍等十几秒',
        converged: false,
      };

    case 'FILTER_INITIALIZING':
      return {
        tone: 'warn',
        icon: '🟡',
        label: `姿态传感器初始化中${precisionNote(uncertaintyDeg)}`,
        detail: '天线刚上电，正在建立姿态基准',
        converged: false,
      };

    case 'FILTER_RESET':
      return {
        tone: 'warn',
        icon: '🟡',
        label: `姿态传感器已重置${precisionNote(uncertaintyDeg)}`,
        detail: '设备检测到移动或重启，正在重新校准',
        converged: false,
      };

    case 'INVALID_STATE':
      return {
        tone: 'bad',
        icon: '🔴',
        label: `姿态数据异常${precisionNote(uncertaintyDeg)}`,
        detail: '设备自检未通过，建议断电重启天线',
        converged: false,
      };

    default:
      // 未知枚举不做猜测，把原始值露出来，方便现场排查固件差异
      return {
        tone: 'neutral',
        icon: '⚪',
        label: `姿态状态未知（${rawState}）`,
        detail: '当前固件上报了本软件未识别的状态值',
        converged: false,
      };
  }
}