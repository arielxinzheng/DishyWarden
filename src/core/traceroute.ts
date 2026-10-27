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
 *
 * ⚠️ **不能 slice(1) 跳过标题行** —— macOS 的 traceroute 把标题
 * (`traceroute to ... hops max ...`) 写到 **stderr**, stdout 里只有 hop 行。
 * slice(1) 会把唯一的数据行当标题丢掉, 结果 0 hops。
 * 标题行本来就能被 hopMatch 过滤掉, 所以不过滤。
 */
export function parseUnixTraceroute(output: string): TraceHop[] {
  const lines = output.split('\n');
  const hops: TraceHop[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    // 匹配跳数 (标题行没有开头的数字, 会被这里过滤掉)
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
    //
    // ⚠️ IP 正则不能写成 /\(?([\d.]+)\)?/ —— 那会先匹配到**行首的跳号**
    // (如 "1  localhost (127.0.0.1)" 里的 "1"), 把跳号当成 IP。
    // 正确: 优先取括号里的 IP, 没有括号才取「跳号之后的第一个 token」。
    const ipMatch = line.match(/\(([\d.]+)\)|^\s*\d+\s+([\d.]+)/);
    const hostnameMatch = line.match(/^\s*\d+\s+([^\s(]+)/);
    const timeMatch = line.match(/([\d.]+)\s*ms/);

    if (ipMatch) {
      const ip = ipMatch[1] ?? ipMatch[2];
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
 *
 * ⚠️ **不要 slice(4) 跳过前 4 行** —— 标题行数不固定(本地化、语言版本、
 * 是否输出统计段都会变), 硬编码行数会随机吃掉数据行。
 * 标题行没有开头的数字, 会被 hopMatch 过滤掉, 所以不过滤。
 */
export function parseWindowsTraceroute(output: string): TraceHop[] {
  const lines = output.split('\n');
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

    // 主机名: 剥掉行尾的 IP 之后, 取**最后一个** token。
    //
    // ⚠️ 不能用 /ms\s+(\S+)/ —— Windows 格式里 "ms" 后面紧跟的是**下一个时间值**
    // ("12 ms    12 ms    12 ms  example.com"), 不是主机名。
    const withoutIp = ipMatch ? line.slice(0, line.lastIndexOf(ipMatch[0])).trim() : line;
    const tokens = withoutIp.split(/\s+/).filter(Boolean);
    // 剥掉末尾的时间 token 们("12", "ms", "<1", ...)
    while (
      tokens.length > 0 &&
      (tokens[tokens.length - 1] === 'ms' || /^<?\d+$/.test(tokens[tokens.length - 1]))
    ) {
      tokens.pop();
    }
    const hostnameCandidate = tokens[tokens.length - 1];

    if (ipMatch) {
      const ip = ipMatch[1];
      const hostname =
        hostnameCandidate && hostnameCandidate !== ip ? hostnameCandidate : ip;
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