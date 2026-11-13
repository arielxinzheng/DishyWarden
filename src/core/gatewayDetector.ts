/**
 * 默认网关检测与 Ping 探测模块
 * 
 * 跨平台（macOS/Linux/Windows）获取系统默认网关 IP，
 * 并对其发起 ICMP Ping 测试，用于 Local 延迟监控。
 * 
 * ## 实现策略
 * 
 * - macOS/Linux: 解析 `netstat -rn` 或 `ip route` 输出
 * - Windows: 解析 `route print` 输出
 * - Ping 使用已有的 `probeRunner.ts` 中的 ICMP 探测逻辑
 * 
 * ## 为什么不用第三方库
 * 
 * - default-gateway npm 包已 4 年未更新，对新版 macOS 支持不佳
 * - 我们已有成熟的跨平台 ping 实现（probeRunner.ts），只需获取网关 IP
 */

import { exec } from 'child_process';
import { runProbe, type ProbeResult } from './probeRunner';
import type { ProbeNodeConfig } from '../config/manager';

const execAsync = (cmd: string, timeoutMs: number = 5000) =>
  new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    // windowsHide: GUI 应用里不设会闪黑色控制台窗口
    exec(cmd, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const raw = error?.code;
      const code = typeof raw === 'number' ? raw : error ? 1 : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });

/**
 * 从 macOS/Linux 的 netstat 输出中提取默认网关。
 * 
 * macOS netstat -rn 示例：
 * ```
 * default            192.168.100.1      UGSc           en0
 * ```
 * 
 * Linux netstat -rn 示例：
 * ```
 * 0.0.0.0         192.168.100.1   0.0.0.0         UG    0      0        0 eth0
 * ```
 */
function parseNetstatGateway(output: string): string | null {
  const lines = output.split('\n');
  for (const line of lines) {
    // 找 default 或 0.0.0.0 开头的行
    if (line.match(/^(default|0\.0\.0\.0)\s+/)) {
      // 提取第二列（网关 IP）
      const match = line.match(/\s+(\d+\.\d+\.\d+\.\d+)\s+/);
      if (match) return match[1];
    }
  }
  return null;
}

/**
 * 从 Linux 的 ip route 输出中提取默认网关。
 * 
 * ip route 示例：
 * ```
 * default via 192.168.100.1 dev eth0 proto dhcp metric 100
 * ```
 */
function parseIpRouteGateway(output: string): string | null {
  const match = output.match(/default\s+via\s+(\d+\.\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

/**
 * 从 Windows 的 route print 输出中提取默认网关。
 * 
 * route print 示例（英文）：
 * ```
 *   0.0.0.0          0.0.0.0      192.168.100.1    192.168.100.123     25
 * ```
 * 
 * route print 示例（中文）：
 * ```
 * 活动路由:
 * 网络目标        网络掩码          网关       接口            跃点数
 *   0.0.0.0          0.0.0.0      192.168.100.1    192.168.100.123     25
 * ```
 */
function parseWindowsRouteGateway(output: string): string | null {
  const lines = output.split('\n');
  for (const line of lines) {
    // 找 0.0.0.0 开头的行
    if (line.trim().startsWith('0.0.0.0')) {
      // 第三列是网关（Windows route print 输出：目标 掩码 网关 接口 跃点）
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3 && parts[2].match(/^\d+\.\d+\.\d+\.\d+$/)) {
        return parts[2];
      }
    }
  }
  return null;
}

/**
 * 获取系统默认网关 IP。
 * 
 * @returns 网关 IP，获取失败时返回 null
 */
export async function getDefaultGateway(): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      // Windows: route print
      const { stdout, code } = await execAsync('route print', 5000);
      if (code !== 0) return null;
      return parseWindowsRouteGateway(stdout);
    } else {
      // macOS/Linux: 先尝试 ip route，失败再用 netstat
      try {
        const { stdout: ipOutput, code: ipCode } = await execAsync('ip route show default', 3000);
        if (ipCode === 0) {
          const gateway = parseIpRouteGateway(ipOutput);
          if (gateway) return gateway;
        }
      } catch {
        // ip 命令不存在（macOS 或老版 Linux），继续尝试 netstat
      }

      // 回退到 netstat -rn
      const { stdout, code } = await execAsync('netstat -rn', 5000);
      if (code !== 0) return null;
      return parseNetstatGateway(stdout);
    }
  } catch (error) {
    console.error('[GatewayDetector] Failed to get default gateway:', error);
    return null;
  }
}

/**
 * 对默认网关执行一次 ICMP Ping 探测。
 * 
 * @param timeoutSec 单次探测超时（秒），默认 5 秒
 * @returns Ping 结果，包含延迟（rttMs）和是否可达（ok）
 */
export async function pingDefaultGateway(timeoutSec: number = 5): Promise<ProbeResult | null> {
  const gateway = await getDefaultGateway();
  if (!gateway) {
    return {
      nodeId: 'local-gateway',
      ok: false,
      rttMs: null,
      error: '无法获取默认网关',
      ts: Date.now(),
    };
  }

  // 构造临时探针配置
  const probeConfig: ProbeNodeConfig = {
    id: 'local-gateway',
    name: '本地网关',
    target: gateway,
    type: 'icmp',
    intervalSec: 30,
    timeoutSec,
    enabled: true,
  };

  try {
    return await runProbe(probeConfig);
  } catch (error) {
    return {
      nodeId: 'local-gateway',
      ok: false,
      rttMs: null,
      error: error instanceof Error ? error.message : '探测失败',
      ts: Date.now(),
    };
  }
}

/**
 * 获取默认网关的可读描述（用于日志和 UI）。
 * 
 * @returns 如 "192.168.100.1 (默认网关)" 或 "未检测到网关"
 */
export async function getGatewayDescription(): Promise<string> {
  const gateway = await getDefaultGateway();
  return gateway ? `${gateway} (默认网关)` : '未检测到网关';
}