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
import { promisify } from 'util';
import type {
  RouterProbeConfig,
  RouterProbeResult,
} from './routerProbeTypes';

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

    return {
      reachable: pingResult.reachable,
      rttMs: pingResult.rttMs,
      packetLoss: pingResult.packetLoss,
      httpOk,
      timestamp: timestamp.getTime(),
      trusted: trust.trusted,
      trustNote: trust.note,
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
   * 对指定地址做 ICMP Ping
   */
  private async icmpPingTo(
    address: string,
    count: number,
    timeoutMs: number
  ): Promise<{ reachable: boolean; rttMs: number | null; packetLoss: number }> {
    try {
      const timeoutSec = Math.ceil(timeoutMs / 1000);

      // macOS/Linux ping 命令格式不同
      const isMac = process.platform === 'darwin';
      const cmd = isMac
        ? `ping -c ${count} -W ${timeoutSec * 1000} ${address}`
        : `ping -c ${count} -W ${timeoutSec} ${address}`;

      const { stdout } = await execAsync(cmd, { timeout: timeoutMs + 1000 });

      // 解析 ping 输出
      // macOS: "round-trip min/avg/max/stddev = 1.234/2.345/3.456/0.789 ms"
      // Linux: "rtt min/avg/max/mdev = 1.234/2.345/3.456/0.789 ms"
      const rttMatch = stdout.match(/min\/avg\/max\/[^=]+=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/);
      const avgRtt = rttMatch ? parseFloat(rttMatch[2]) : null;

      // 解析丢包率："3 packets transmitted, 3 received, 0% packet loss"
      const lossMatch = stdout.match(/([\d.]+)%\s+packet loss/);
      const packetLoss = lossMatch ? parseFloat(lossMatch[1]) / 100 : 0;

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