/**
 * 卫星切换事件的**身份有效性**判据。
 *
 * ## 为什么单独一个文件
 *
 * `satellite_handoffs` 的主键是 `rtc_ms`（设备时钟读数）。写入用的是
 * `INSERT OR REPLACE`，语义是「同一事件覆盖同一行」—— 这要求身份必须唯一且有效。
 *
 * 而 `rtcMs` 是从设备 `startTimestampNs` 经 `toEpochMs` 按数量级换算来的
 * （见 `core/outageAnalyzer.ts`）。固件换了字段名、或者数字量级判不出来时，
 * `toEpochMs` 会返回 0，于是**整窗事件的身份全都一样**，`INSERT OR REPLACE`
 * 让它们互相覆盖，库里只剩最后一条 —— 没有报错，历史静默消失。
 *
 * 现场日志出现过这条路径：`[outage] unit=null first_ts_magnitude=0.00e+0`。
 *
 * ## 为什么不是 telemetryStore 里的一个 filter
 *
 * 判据是领域规则（「设备时钟读数是什么样才算一次可标识的切换」），
 * 不是 SQL 实现细节。放这里的好处：
 *   - 诊断报告、未来其他写入方可以共用同一判据，不会各自漂移
 *   - `telemetryStore.ts` 顶部 import 了 better-sqlite3（Electron ABI），
 *     任何测试文件只要 import 它就会 ERR_DLOPEN；纯函数放这里才能被 vitest 覆盖
 */

import type { HandoffEvent } from '../core/outageAnalyzer';

export interface HandoffIdentitySplit {
  /** 身份有效的条目，可以写库 */
  identifiable: HandoffEvent[];
  /** 身份无效的条目（rtc_ms 为 0 / NaN / 负数），写进去会互相覆盖 */
  rejected: HandoffEvent[];
}

/**
 * 按身份有效性把一批切换事件分成「可写库」和「不可写库」。
 *
 * 判据只有一条：`rtcMs` 必须是有限正数。
 * 不设上限 —— 设备 RTC 可能比 host 早十年（真机实测如此），
 * 也可能略微超前，任何「像不像今天」的判断都会误伤。
 */
export function splitIdentifiableHandoffs(handoffs: HandoffEvent[]): HandoffIdentitySplit {
  const identifiable: HandoffEvent[] = [];
  const rejected: HandoffEvent[] = [];

  for (const handoff of handoffs) {
    const rtc = handoff.rtcMs;
    if (Number.isFinite(rtc) && rtc > 0) {
      identifiable.push(handoff);
    } else {
      rejected.push(handoff);
    }
  }

  return { identifiable, rejected };
}