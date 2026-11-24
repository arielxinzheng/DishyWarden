/**
 * 默认网关：解析 + 节点约定。
 *
 * 两件事，都很底层、都没有状态：
 * 1. 从操作系统的路由表里读出「当前默认网关 IP」（不 ping、不重试、不缓存）
 * 2. 定义「本地网关探针节点」长什么样（ID 与配置构造）
 *
 * ## 依赖方向
 *
 * 这个文件不 import 任何业务模块，所以谁都能安全地依赖它：
 *
 *   defaultGateway  ←  probeRunner   （探测前把 target 换成当前网关）
 *                   ←  historian     （无探针可用时自己测一次的兜底）
 *
 * 反过来则会成环：probeRunner 需要解析网关，若解析逻辑放在需要
 * `runProbe` 的模块里，就变成 probeRunner → X → probeRunner。
 *
 * ## Windows 为什么不能只取第一条 0.0.0.0
 *
 * 真机（Starlink + 远程桌面）上装过虚拟机/VPN 的机器会有多条默认路由，
 * 第一条往往属于虚拟网卡，ping 过去不通。旧实现只看第一条，于是
 * 「网关检测成功、但 ping 不通」⇒ 整个本地网关延迟指标静默为空。
 * 现在按跃点数(metric)排序取最小，并跳过回环/On-link。
 */

import { exec } from 'child_process';
import type { ProbeNodeConfig } from '../config/manager';

/**
 * 「本地网关」探针节点的 ID。
 *
 * 这个字符串是一条跨模块约定：`probeRunner` 靠它决定「这个节点的 target
 * 要在每次探测前重新从路由表解析」，`main` 靠它从探针状态里取出网关延迟。
 * 写死在多处会出现「改了一处、另一处静默不生效」，所以只在这里定义一次。
 */
export const LOCAL_GATEWAY_NODE_ID = 'local-gateway';

/**
 * 构造一个「本地网关」探针节点配置。
 *
 * `target` 故意留空：真实目标由 `probeRunner` 每轮从路由表解析。
 * 不填一个猜的 IP（比如 `192.168.1.1`）是刻意的 —— 猜错时 ping 会失败，
 * 失败原因看起来像「网关不通」，会把「路由表解析失败」这个真正的
 * 故障掩盖掉。空 target 让 `probeRunner` 直接报「无法解析默认网关」。
 */
export function localGatewayNode(timeoutSec: number = 5): ProbeNodeConfig {
  return {
    id: LOCAL_GATEWAY_NODE_ID,
    name: '本地网关',
    target: '',
    type: 'icmp',
    intervalSec: 30,
    timeoutSec,
    enabled: true,
  };
}

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
export function parseNetstatGateway(output: string): string | null {
  for (const line of output.split('\n')) {
    if (line.match(/^(default|0\.0\.0\.0)\s+/)) {
      const match = line.match(/\s+(\d+\.\d+\.\d+\.\d+)\s+/);
      if (match) return match[1];
    }
  }
  return null;
}

/**
 * 从 Linux 的 ip route 输出中提取默认网关。
 *
 * ```
 * default via 192.168.100.1 dev eth0 proto dhcp metric 100
 * ```
 */
export function parseIpRouteGateway(output: string): string | null {
  const match = output.match(/default\s+via\s+(\d+\.\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * 从 Windows 的 route print 输出中提取默认网关。
 *
 * 输出形如（英文/中文都一样，列顺序固定：目标 掩码 网关 接口 跃点）：
 * ```
 *   0.0.0.0          0.0.0.0      192.168.100.1    192.168.100.123     25
 *   0.0.0.0          0.0.0.0      On-link          192.168.56.1       281
 * ```
 *
 * 一条 `0.0.0.0` 可能有很多条（物理网卡 + 虚拟网卡 + VPN）。
 * 必须按跃点数取最小，取第一条会选中虚拟网卡。
 */
export function parseWindowsRouteGateway(output: string): string | null {
  const candidates: Array<{ gateway: string; metric: number }> = [];

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('0.0.0.0')) continue;

    const parts = trimmed.split(/\s+/);
    // 目标 掩码 网关 接口 跃点
    if (parts.length < 5) continue;
    if (parts[1] !== '0.0.0.0') continue;

    const gateway = parts[2];
    // On-link 表示直连网段、没有下一跳 —— 不能当网关
    if (!IPV4.test(gateway)) continue;
    if (gateway === '0.0.0.0') continue;

    const metric = Number(parts[parts.length - 1]);
    candidates.push({ gateway, metric: Number.isFinite(metric) ? metric : Number.MAX_SAFE_INTEGER });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.metric - b.metric);
  return candidates[0].gateway;
}

/**
 * 获取系统默认网关 IP。
 *
 * @returns 网关 IP，获取失败时返回 null
 */
export async function getDefaultGateway(): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout, code } = await execAsync('route print', 5000);
      if (code !== 0) return null;
      return parseWindowsRouteGateway(stdout);
    }

    // macOS 没有 ip 命令，Linux 有；先试 ip，再回落 netstat
    try {
      const { stdout: ipOutput, code: ipCode } = await execAsync('ip route show default', 3000);
      if (ipCode === 0) {
        const gateway = parseIpRouteGateway(ipOutput);
        if (gateway) return gateway;
      }
    } catch {
      // ip 命令不存在（macOS 或老版 Linux），继续尝试 netstat
    }

    const { stdout, code } = await execAsync('netstat -rn', 5000);
    if (code !== 0) return null;
    return parseNetstatGateway(stdout);
  } catch (error) {
    console.error('[DefaultGateway] 解析默认网关失败:', error);
    return null;
  }
}