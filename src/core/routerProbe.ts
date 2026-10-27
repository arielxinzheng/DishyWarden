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

const execAsync = promisify(exec);

export interface RouterProbeConfig {
  address: string;      // 路由器地址，默认 192.168.100.1
  httpPort?: number;    // HTTP 健康检查端口（可选）
  timeout?: number;     // 超时（毫秒），默认 5000
  pingCount?: number;   // ping 次数，默认 3
}

export interface RouterProbeResult {
  reachable: boolean;          // 路由器可达性（0/1）
  rttMs: number | null;        // 往返延迟（ms），不可达时为 null
  packetLoss: number;          // 丢包率（0-1）
  httpOk: boolean | null;      // HTTP 健康检查结果（未启用时为 null）
  timestamp: Date;
}

/**
 * 路由器探活客户端
 */
export class RouterProbe {
  private config: Required<RouterProbeConfig>;

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

    return {
      reachable: pingResult.reachable,
      rttMs: pingResult.rttMs,
      packetLoss: pingResult.packetLoss,
      httpOk,
      timestamp,
    };
  }

  /**
   * ICMP Ping 探测
   */
  private async icmpPing(): Promise<{ reachable: boolean; rttMs: number | null; packetLoss: number }> {
    try {
      const count = this.config.pingCount;
      const timeoutSec = Math.ceil(this.config.timeout / 1000);
      
      // macOS/Linux ping 命令格式不同
      const isMac = process.platform === 'darwin';
      const cmd = isMac
        ? `ping -c ${count} -W ${timeoutSec * 1000} ${this.config.address}`
        : `ping -c ${count} -W ${timeoutSec} ${this.config.address}`;

      const { stdout } = await execAsync(cmd, { timeout: this.config.timeout + 1000 });

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