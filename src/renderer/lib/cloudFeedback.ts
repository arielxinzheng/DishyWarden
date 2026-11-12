/**
 * 误报反馈上报（渲染层）
 *
 * 需求：用户标记「误报」后，把这条告警的**快照**匿名上报到 SL Cloud，
 * 用来反哺告警阈值的调优（误报 = 阈值偏紧的负样本）。
 *
 * ## 隐私口径（DESIGN §6）
 *
 * - 上报前**明示一次**：首次上报弹确认框，文案写清楚上报什么、不含什么
 * - 用户随时可在设置页关闭「上报告警误报样本」
 * - 白名单由服务端再过滤一次（客户端只发已知字段，见 CloudClient）
 *
 * ## 为什么放在渲染层而不是主进程
 *
 * 因为「要不要问用户」这件事需要 UI 交互。主进程只负责把已经决定要发的
 * 数据送出去 —— 分工清楚，也避免主进程弹原生对话框打断用户。
 */

/** 一次性确认的本地标记：确认过就不再问 */
const ACK_KEY = 'slmonitor.false_positive_upload_ack';

export type FalsePositiveUploadResult =
  | 'reported'    // 已上报
  | 'declined'    // 用户拒绝上报（本地标记仍然生效）
  | 'skipped'     // 没开启开关 / 浏览器环境没有该能力
  | 'failed';     // 上报失败（本地标记仍然生效）

export interface FalsePositiveReport {
  alertKey: string;
  severity?: string;
  title?: string;
  /** 触发瞬间的遥测快照（对象） */
  evidence?: unknown;
}

/**
 * 误报上报（在本地标记成功后调用）。
 *
 * @param report  要上报的内容
 * @param confirmMessage 首次上报的确认文案（由调用方用 i18n 生成）
 */
export async function uploadFalsePositive(
  report: FalsePositiveReport,
  confirmMessage: string,
): Promise<FalsePositiveUploadResult> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!api?.reportFalsePositive) return 'skipped';

  // 开关没开就不问、不发 —— 用户没同意的事不做
  let enabled = false;
  try {
    const config = await api.getConfig();
    enabled = !!config?.cloud?.feedbackEnabled;
  } catch {
    return 'skipped';
  }
  if (!enabled) return 'skipped';

  // 首次上报要明示；确认过之后就静默发
  try {
    const acknowledged = localStorage.getItem(ACK_KEY) === '1';
    if (!acknowledged) {
      const accepted = window.confirm(confirmMessage);
      if (!accepted) return 'declined';
      localStorage.setItem(ACK_KEY, '1');
    }
  } catch {
    // localStorage 不可用（隐私模式等）⇒ 不阻断主流程，直接尝试上报
  }

  try {
    const result = await api.reportFalsePositive({
      alertKey: report.alertKey,
      severity: report.severity,
      title: report.title,
      evidence: report.evidence,
    });
    return result?.success ? 'reported' : 'failed';
  } catch {
    return 'failed';
  }
}
