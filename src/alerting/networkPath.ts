/**
 * 底层网络路径判定：外网到底通不通、通在哪条链路上。
 *
 * ## 三种路径
 *
 * - `starlink`：星链正常，外网可达 —— 常规路径，直接发。
 * - `backup`：星链**不通**，但外网仍然可达 ⇒ 流量走了别的出口
 *   （多 WAN 路由 / 5G 备线 / 有线宽带）⇒ **照样直接发**，别浪费一条告警。
 * - `none`：外网完全不可达 ⇒ 公网通道的通知只能进离线队列。
 *
 * ## 为什么 `backup` 要单独分出来
 *
 * 单链路用户断网时收不到 Telegram，这是**预期内的物理限制**，不是 bug。
 * 但如果家里有 5G 备线 / 多 WAN，链路其实还通着 —— 这时把消息丢进队列
 * 就是在制造"明明能发却没发"的假故障。
 *
 * 判定依据都是**已经在采集的数据**，不需要额外的探测请求：
 * - 公网可达性 ← `public-ping` 探针（ICMP 1.1.1.1）
 * - 星链是否在线 ← 采集器的 dish state
 */

/** 外网路径 */
export type NetworkPath = 'starlink' | 'backup' | 'none';

/** 判定输入 */
export interface NetworkPathInput {
  /** 公网是否可达（public-ping 探针） */
  publicReachable: boolean;
  /** 星链终端是否在线 */
  starlinkOnline: boolean;
}

/**
 * 判定当前外网路径。
 *
 * 注意顺序：先看公网可达性，再看星链 —— 只要外网通，走哪条链路都无所谓。
 */
export function resolveNetworkPath(input: NetworkPathInput): NetworkPath {
  if (!input.publicReachable) return 'none';
  // 外网通但星链不在线 ⇒ 流量走了别的出口（多 WAN / 5G 备线）
  if (!input.starlinkOnline) return 'backup';
  return 'starlink';
}

/** 路径的人类可读描述 */
export function describeNetworkPath(path: NetworkPath): string {
  switch (path) {
    case 'starlink':
      return '星链链路';
    case 'backup':
      return '备用链路（多 WAN / 5G 备线）';
    case 'none':
      return '无外网';
  }
}
