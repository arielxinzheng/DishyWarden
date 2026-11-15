/**
 * 路由器探活检查
 * 
 * 按需求文档 2.1.2「路由器状态监控」实现：
 * - ICMP Ping 探测可达性
 * - HTTP 健康检查（可选）
 * - 响应时间统计
 * 
 * 不使用 gRPC 遥测（DishyMock proto 无 router 分支）
 */

import { exec } from 'child_process';
import net from 'net';
import { promisify } from 'util';
import type {
  RouterProbeConfig,
  RouterProbeResult,
} from './routerProbeTypes';
import { parsePingStats } from './pingParse';

export type { RouterProbeConfig, RouterProbeResult } from './routerProbeTypes';

const execAsync = promisify(exec);

/**
 * ICMP 基线自检用的保留地址 (RFC 5737 TEST-NET-1)。
 *
 * 这个地址在正常网络里**永远 ping 不通**。如果它 ping 得通, 说明当前环境
 * (VPN / 隧道 / 安全软件) 在应答所有 ICMP —— 此时对真实路由器的探测结果
 * 也是假的, 不能当设备实测值展示。
 */
const ICMP_BASELINE_PROBE_ADDRESS = '192.0.2.1';

/**
 * 路由器探活客户端
 */
export class RouterProbe {
  private config: Required<RouterProbeConfig>;
  /** ICMP 基线自检结果缓存 —— 只做一次, 避免每 30s 多 ping 一轮 */
  private icmpTrustCache: { trusted: boolean; note: string } | null = null;

  constructor(config: Partial<RouterProbeConfig> = {}) {
    this.config = {
      address: config.address || '192.168.100.1',
      httpPort: config.httpPort || 0,
      timeout: config.timeout || 5000,
      pingCount: config.pingCount || 3,
    };
  }

  /**
   * 执行一次完整探测（ICMP Ping + HTTP）
   */
  async probe(): Promise<RouterProbeResult> {
    const timestamp = new Date();
    const pingResult = await this.icmpPing();
    const httpOk = this.config.httpPort > 0 ? await this.httpCheck() : null;

    // ICMP 基线自检 —— 判断这次探测结果能不能当实测值用
    const trust = await this.checkIcmpTrust();

    // ⚠️ ICMP 不可信时（VPN/隧道应答所有 ICMP），**不能直接判"未知"**：
    // TCP 握手不受 ICMP 篡改影响 ⇒ 用它独立判定"路由器到底在不在"。
    // 这样界面能给出真实的可达结论，而不是永远灰着。
    let tcpFallback: { reachable: boolean; port?: number; rttMs?: number } | null = null;
    if (!trust.trusted) {
      tcpFallback = await this.tcpReachability(this.config.address, this.config.timeout);
      console.log(
        `[RouterProbe] ICMP 不可信 ⇒ 改用 TCP 判定: ` +
        `${tcpFallback.reachable ? `可达(:${tcpFallback.port}, ${tcpFallback.rttMs}ms)` : '不可达'}`,
      );
    }

    // ICMP 可信 ⇒ 直接用 ICMP 结论；
    // ICMP 不可信 ⇒ 用 TCP 结论（真实协议交互），丢包率标 0（TCP 连上就是通的）
    const useTcp = !trust.trusted && tcpFallback !== null;
    return {
      reachable: useTcp ? tcpFallback!.reachable : pingResult.reachable,
      rttMs: useTcp ? (tcpFallback!.rttMs ?? null) : pingResult.rttMs,
      packetLoss: useTcp ? 0 : pingResult.packetLoss,
      httpOk,
      timestamp: timestamp.getTime(),
      trusted: trust.trusted,
      trustNote: trust.note,
      // 用了 TCP 独立判定 ⇒ 结论可信，标记出来给渲染层区分
      evidence: useTcp ? 'tcp' : 'icmp',
    };
  }

  /**
   * ICMP 基线自检。
   *
   * 用 RFC 5737 保留地址 `192.0.2.1` 做对照: 正常网络里它永远 ping 不通。
   * 如果它 ping 得通, 说明当前环境在应答所有 ICMP —— 此时的「可达 / 0% 丢包 /
   * RTT 0.3ms」全是环境造出来的, 不能当路由器实测值展示。
   *
   * 自检**只做一次**并缓存结果 —— 每 30s 采一次样, 没必要每次都多 ping 一轮。
   */
  private async checkIcmpTrust(): Promise<{ trusted: boolean; note: string }> {
    if (this.icmpTrustCache) {
      return this.icmpTrustCache;
    }

    const baseline = await this.icmpPingTo(ICMP_BASELINE_PROBE_ADDRESS, 1, 1500);

    this.icmpTrustCache = baseline.reachable
      ? {
          trusted: false,
          note:
            `探测结果不可信：当前网络环境应答了保留地址 ${ICMP_BASELINE_PROBE_ADDRESS} 的 ICMP ` +
            `（可能是 VPN / 隧道 / 安全软件），下面的可达性与延迟并非路由器真实状态`,
        }
      : { trusted: true, note: '' };

    if (!this.icmpTrustCache.trusted) {
      console.warn(`[RouterProbe] ${this.icmpTrustCache.note}`);
    }

    return this.icmpTrustCache;
  }

  /**
   * 强制重做 ICMP 自检（配置变更或用户手动触发时用）
   */
  resetTrustCheck(): void {
    this.icmpTrustCache = null;
  }

  /**
   * ICMP Ping 探测（目标 = 配置的路由器地址）
   */
  private async icmpPing(): Promise<{ reachable: boolean; rttMs: number | null; packetLoss: number }> {
    return this.icmpPingTo(this.config.address, this.config.pingCount, this.config.timeout);
  }

  /**
   * TCP 可达性回落（**不受 ICMP 篡改影响**）。
   *
   * 为什么需要它：ICMP 基线自检发现 VPN/隧道会应答**所有** ICMP 时，
   * 整条局域网链路就被判成「不可信」⇒ 界面永远灰着
   * （用户看到的「本地路由器 状态未知」）。
   *
   * 但 **TCP 握手是真实的协议交互** —— VPN 不会替你对 192.168.1.1:80
   * 建立连接。所以用 TCP 探一次，能独立判定"路由器真的在不在"，
   * 也就没必要因为 ICMP 可疑而把结论整个丢掉。
   *
   * 端口：路由器 HTTP(80) / gRPC(9001) / HTTPS(443) / DNS(53)
   */
  private async tcpReachability(
    address: string,
    timeoutMs: number,
  ): Promise<{ reachable: boolean; port?: number; rttMs?: number }> {
    const ports = [80, 9001, 443, 53];
    // 总预算封顶：采集周期 30s，不能被回落拖死
    const perPort = Math.max(500, Math.min(2000, Math.floor(timeoutMs / ports.length)));
    const deadline = Date.now() + timeoutMs;

    for (const port of ports) {
      if (Date.now() >= deadline) break;
      const started = Date.now();
      const ok = await new Promise<boolean>((resolve) => {
        const socket = net.connect({ host: address, port });
        const done = (v: boolean) => {
          socket.removeAllListeners();
          socket.destroy();
          resolve(v);
        };
        socket.setTimeout(perPort, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
      });
      if (ok) return { reachable: true, port, rttMs: Date.now() - started };
    }
    return { reachable: false };
  }

  /**
   * 对指定地址做 ICMP Ping
   */
  private async icmpPingTo(
    address: string,
    count: number,
    timeoutMs: number
  ): Promise<{ reachable: boolean; rttMs: number | null; packetLoss: number }> {
    try {
      const timeoutSec = Math.ceil(timeoutMs / 1000);

      // 三平台命令各不相同:
      //   macOS:   ping -c N -W <ms>   (-W 是毫秒)
      //   Linux:   ping -c N -W <sec>  (-W 是秒)
      //   Windows: ping -n N -w <ms>   (次数用 -n, 超时用 -w 毫秒)
      // 之前没有 win32 分支 —— Windows 上跑 `ping -c ...` 直接参数错误,
      // 路由器状态永远"不可达"(probeRunner 的 buildPingCommand 有分支, 这里漏了)。
      let cmd: string;
      if (process.platform === 'win32') {
        cmd = `ping -n ${count} -w ${timeoutMs} ${address}`;
      } else if (process.platform === 'darwin') {
        cmd = `ping -c ${count} -W ${timeoutSec * 1000} ${address}`;
      } else {
        cmd = `ping -c ${count} -W ${timeoutSec} ${address}`;
      }

      // windowsHide: GUI 应用里不设会闪黑色控制台窗口
      const { stdout } = await execAsync(cmd, {
        timeout: timeoutMs + 1000,
        windowsHide: true,
      });

      // 解析统一走 pingParse —— Windows 输出是本地化的(中文系统打"丢失/平均"),
      // 且 GBK→UTF8 解码后中文变乱码, 只锚定 ASCII 结构的正则才能三平台通吃。
      const { rttMs: avgRtt, lossRatio } = parsePingStats(stdout);

      // 解析不出来按 100% 丢包算 —— 宁可显示"不可达", 也不能像旧代码那样
      // 兜底成 0(旧代码在 Windows 上丢包正则永远失配 ⇒ packetLoss=0 ⇒
      // 目标明明不通也显示"可达", 是把"不知道"谎报成"一切正常")。
      const packetLoss = lossRatio ?? 1;

      return {
        reachable: packetLoss < 1, // 丢包率 < 100% 视为可达
        rttMs: avgRtt,
        packetLoss,
      };
    } catch (error) {
      // ping 失败（超时、主机不可达等）
      return {
        reachable: false,
        rttMs: null,
        packetLoss: 1, // 100% 丢包
      };
    }
  }

  /**
   * HTTP 健康检查
   */
  private async httpCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const response = await fetch(
        `http://${this.config.address}:${this.config.httpPort}/`,
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);

      return response.ok;
    } catch (error) {
      return false;
    }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<RouterProbeConfig>) {
    this.config = { ...this.config, ...config };
    // 换了目标地址, 之前的环境自检结论不再适用
    this.resetTrustCheck();
  }

  /**
   * 获取当前配置
   */
  getConfig(): RouterProbeConfig {
    return { ...this.config };
  }
}

/**
 * 创建默认的 RouterProbe 实例
 */
export function createRouterProbe(config?: Partial<RouterProbeConfig>): RouterProbe {
  return new RouterProbe(config);
}