/**
 * Traceroute 实现 - 跨平台路由追踪
 * 
 * 执行 traceroute 命令并解析结果为结构化数据。
 * 
 * 平台差异:
 *   macOS/Linux: traceroute 命令
 *   Windows: tracert 命令
 * 
 * 超时策略:
 *   - 单跳超时: 2s
 *   - 最大跳数: 20
 *   - 总超时: 45s
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface TraceHop {
  hop: number;          // 跳数
  ip: string | null;    // IP 地址，超时为 null
  hostname: string;     // 主机名或描述性名称
  rtt: number | null;   // 往返时延(ms)，超时为 null
}

export interface TracerouteResult {
  target: string;
  hops: TraceHop[];
  completed: boolean;   // 是否到达目标
  duration: number;     // 执行耗时(ms)
}

/**
 * 执行 traceroute
 */
export async function traceroute(
  target: string,
  options: {
    maxHops?: number;
    timeout?: number;      // 总超时(ms)
    hopTimeout?: number;   // 单跳超时(s)
  } = {}
): Promise<TracerouteResult> {
  const startTime = Date.now();
  const maxHops = options.maxHops ?? 20;
  const timeout = options.timeout ?? 45000;
  const hopTimeout = options.hopTimeout ?? 2;

  const platform = process.platform;

  let command: string;
  if (platform === 'win32') {
    // Windows: tracert -h maxHops -w timeout_ms target
    command = `tracert -h ${maxHops} -w ${hopTimeout * 1000} ${target}`;
  } else {
    // macOS/Linux: traceroute -m maxHops -w timeout_sec target
    command = `traceroute -m ${maxHops} -w ${hopTimeout} ${target}`;
  }

  try {
    const { stdout } = await execAsync(command, {
      timeout,
      maxBuffer: 1024 * 1024, // 1MB
    });

    const hops = platform === 'win32' 
      ? parseWindowsTraceroute(stdout)
      : parseUnixTraceroute(stdout);

    const completed = hops.length > 0 && hops[hops.length - 1].ip !== null;
    const duration = Date.now() - startTime;

    return {
      target,
      hops,
      completed,
      duration,
    };
  } catch (error: any) {
    // 超时或命令失败，返回空结果
    console.error('[Traceroute] Failed:', error.message);
    return {
      target,
      hops: [],
      completed: false,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * 解析 Unix (macOS/Linux) traceroute 输出
 * 
 * 格式示例:
 *   1  192.168.100.1 (192.168.100.1)  1.234 ms  1.456 ms  1.789 ms
 *   2  * * *
 *   3  example.com (93.184.216.34)  12.345 ms  12.456 ms  12.567 ms
 */
function parseUnixTraceroute(output: string): TraceHop[] {
  const lines = output.split('\n').slice(1); // 跳过第一行标题
  const hops: TraceHop[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    // 匹配跳数
    const hopMatch = line.match(/^\s*(\d+)/);
    if (!hopMatch) continue;

    const hopNum = parseInt(hopMatch[1], 10);

    // 检查是否超时 (* * *)
    if (line.includes('* * *')) {
      hops.push({
        hop: hopNum,
        ip: null,
        hostname: '* (超时)',
        rtt: null,
      });
      continue;
    }

    // 匹配 IP 和主机名
    // 格式: hostname (ip) time ms 或 ip time ms
    const ipMatch = line.match(/\(?([\d.]+)\)?/);
    const hostnameMatch = line.match(/^\s*\d+\s+([^\s(]+)/);
    const timeMatch = line.match(/([\d.]+)\s*ms/);

    if (ipMatch) {
      const ip = ipMatch[1];
      const hostname = hostnameMatch?.[1] !== ip ? (hostnameMatch?.[1] ?? ip) : ip;
      const rtt = timeMatch ? parseFloat(timeMatch[1]) : null;

      hops.push({
        hop: hopNum,
        ip,
        hostname,
        rtt,
      });
    }
  }

  return hops;
}

/**
 * 解析 Windows tracert 输出
 * 
 * 格式示例:
 *   1    <1 ms    <1 ms    <1 ms  192.168.100.1
 *   2     *        *        *     请求超时。
 *   3    12 ms    12 ms    12 ms  example.com [93.184.216.34]
 */
function parseWindowsTraceroute(output: string): TraceHop[] {
  const lines = output.split('\n').slice(4); // 跳过前4行标题
  const hops: TraceHop[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    // 匹配跳数
    const hopMatch = line.match(/^\s*(\d+)/);
    if (!hopMatch) continue;

    const hopNum = parseInt(hopMatch[1], 10);

    // 检查是否超时
    if (line.includes('请求超时') || line.includes('Request timed out') || line.includes('* * *')) {
      hops.push({
        hop: hopNum,
        ip: null,
        hostname: '* (超时)',
        rtt: null,
      });
      continue;
    }

    // 匹配时间和 IP
    const timeMatch = line.match(/<?\s*(\d+)\s*ms/);
    const ipMatch = line.match(/\[?([\d.]+)\]?$/);
    const hostnameMatch = line.match(/ms\s+([^\s\[]+)/);

    if (ipMatch) {
      const ip = ipMatch[1];
      const hostname = hostnameMatch?.[1] ?? ip;
      const rtt = timeMatch ? parseFloat(timeMatch[1]) : null;

      hops.push({
        hop: hopNum,
        ip,
        hostname,
        rtt,
      });
    }
  }

  return hops;
}