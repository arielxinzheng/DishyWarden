/**
 * 设置页「终端位置」的失败提示。
 *
 * 抽成纯函数是为了可测：用户反馈"获取不了位置"时界面只给一句笼统提示，
 * 看不出是"远程桌面里系统定位服务不可用"还是"dish 没开放位置"。
 * 现在每条提示都**带上真实的错误码**（PERMISSION_DENIED / POSITION_UNAVAILABLE /
 * TIMEOUT，或 dish 侧的 gRPC 原因），并告诉用户下一步该做什么。
 */

type T = (key: string, opts?: Record<string, unknown>) => string;

/** GeolocationPositionError.code → 规范名（W3C 定义：1/2/3） */
export function geolocationCodeName(code: number): string {
  switch (code) {
    case 1: return 'PERMISSION_DENIED';
    case 2: return 'POSITION_UNAVAILABLE';
    case 3: return 'TIMEOUT';
    default: return `UNKNOWN(${code})`;
  }
}

/**
 * 浏览器定位失败的提示：`<原因说明>（错误码 NAME：系统给的 message）`。
 *
 * error.message 是 Chromium 给的原文（如 "Network location provider at
 * 'https://www.googleapis.com/' : No response received."），对定位问题很有诊断价值，
 * 一起显示。
 */
export function geolocationFailureText(
  t: T,
  error: { code: number; message?: string },
): string {
  const name = geolocationCodeName(error.code);
  const key =
    error.code === 1 ? 'settings:location.permission_denied'
    : error.code === 2 ? 'settings:location.position_unavailable'
    : error.code === 3 ? 'settings:location.timeout'
    : 'settings:location.fetch_failed';
  const detail = error.message?.trim();
  return `${t(key)} ${t('settings:location.error_code', { code: name })}${detail ? `: ${detail}` : ''}`;
}

export type DishLocationReason =
  | 'permission_denied'
  | 'unsupported'
  | 'unreachable'
  | 'no_fix'
  | 'other';

/** dish 侧读取位置失败的提示 */
export function dishLocationFailureText(
  t: T,
  result: { reason?: DishLocationReason; error?: string },
): string {
  const reason = result.reason ?? 'other';
  const head = t(`settings:location.dish_${reason}`);
  const detail = result.error?.trim();
  return detail ? `${head} (${detail})` : head;
}
