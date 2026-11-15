/**
 * 路由器探测的对外纯类型
 *
 * 刻意不 import child_process —— `routerProbe.ts` 用了 `exec` 跑 ping,
 * 渲染进程 import 它会把 node 内建模块带进 renderer bundle 导致打包失败。
 * 所以类型单独放这里, 主进程与渲染层共用。
 */

/** 探测配置 */
export interface RouterProbeConfig {
  /** 路由器地址，默认 192.168.100.1 */
  address: string;
  /** HTTP 健康检查端口（可选，0=不启用） */
  httpPort?: number;
  /** 超时（毫秒），默认 5000 */
  timeout?: number;
  /** ping 次数，默认 3 */
  pingCount?: number;
}

/** 单次探测结果 */
export interface RouterProbeResult {
  /** 路由器可达性（0/1） */
  reachable: boolean;
  /** 往返延迟（ms），不可达时为 null */
  rttMs: number | null;
  /** 丢包率（0-1） */
  packetLoss: number;
  /** HTTP 健康检查结果（未启用时为 null） */
  httpOk: boolean | null;
  /** 采集时刻（epoch ms） */
  timestamp: number;
  /**
   * **探测结果是否可信**
   *
   * 某些网络环境（VPN / 隧道 / 安全软件）会**应答所有 ICMP 请求** ——
   * 实测连保留地址 `192.0.2.1` 都能 ping 通。此时「可达 / 0% 丢包 /
   * RTT 0.3ms」全是环境造出来的假象，不能当设备实测值展示。
   *
   * 判据: 用一个 RFC 5737 TEST-NET 保留地址做基线自检。
   *   - 保留地址 ping 不通 → 环境正常，探测结果可信
   *   - 保留地址 ping 得通 → 环境在篡改 ICMP，结果不可信
   *
   * `undefined` 表示还没做过自检（首次探测前）。
   */
  trusted?: boolean;
  /** 自检说明（不可信时给用户看原因） */
  trustNote?: string;
  /**
   * 本次结论的**证据来源**。
   *
   * 为什么需要它：`trusted: false` 只说明「ICMP 不可信」，但**不可信 ≠ 没有结论**。
   * 路由器探针在 ICMP 不可信时会改用 **TCP 握手**判定可达性 ——
   * TCP 是真实协议交互，VPN/隧道替不了 ⇒ 那份结论是可信的。
   *
   * 渲染层据此区分两种"不可信"：
   *   - `icmp`  ⇒ 只有一份被篡改的 ICMP 结果 ⇒ **没有结论**，界面必须灰
   *   - `tcp`   ⇒ 已经用 TCP 独立判定过 ⇒ **有结论**，界面照常显示
   *
   * 缺省（undefined）按 `icmp` 处理 —— 保守优先：没有证据就不给结论。
   */
  evidence?: 'icmp' | 'tcp';
}
