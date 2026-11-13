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
 *
 * 超时 ≠ 失败:
 *   命令被 kill 时, 它已经走过的跳还在 stdout 里 —— 那是有价值的信息
 *   ("走到了第 5 跳但没到目的地")。所以超时时会把已收到的输出解析出来,
 *   返回部分结果而不是空结果。详见 traceroute() 的 catch 分支。
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
 * 构造平台对应的 traceroute 命令。
 *
 * 单独抽出来是为了可测 —— 参数写错（比如把 -q 写成 -Q）不会报错，
 * 只会在运行时静默走默认值，靠肉眼看日志很难发现。
 */
export interface TraceCommandOptions {
  maxHops: number;
  hopTimeout: number;
  /** 每跳探测次数 */
  probes: number;
}

export function buildTraceCommand(
  platform: NodeJS.Platform,
  target: string,
  opts: TraceCommandOptions,
): string {
  if (platform === 'win32') {
    // Windows 的 tracert **没有**探测次数参数，固定 3 次 —— 降不下来
    return `tracert -h ${opts.maxHops} -w ${opts.hopTimeout * 1000} ${target}`;
  }
  // macOS/Linux: -m 最大跳数, -q 每跳探测次数, -w 单跳超时(秒)
  return `traceroute -m ${opts.maxHops} -q ${opts.probes} -w ${opts.hopTimeout} ${target}`;
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
    probes?: number;       // 每跳探测次数, 默认 1
  } = {}
): Promise<TracerouteResult> {
  const startTime = Date.now();
  const maxHops = options.maxHops ?? 20;
  const timeout = options.timeout ?? 45000;
  const hopTimeout = options.hopTimeout ?? 2;
  // 每跳只探一次。系统 traceroute 默认 3 次：
  //   · 无响应的跳要等 3×hopTimeout（2s 超时下就是 6s/跳）
  //   · 三个探测本身也要串行跑完
  // 星链这类高延迟链路（每跳 200–300ms）走 10–15 跳时，3 次探测必然撞上总超时，
  // 结果只有半截路径、结论永远是「未到达」。降到 1 次后几秒就能跑完。
  const probes = Math.max(1, Math.floor(options.probes ?? 1));

  const platform = process.platform;
  const command = buildTraceCommand(platform, target, { maxHops, hopTimeout, probes });

  try {
    const { stdout } = await execAsync(command, {
      timeout,
      maxBuffer: 1024 * 1024, // 1MB
    });

    const hops = platform === 'win32'
      ? parseWindowsTraceroute(stdout)
      : parseUnixTraceroute(stdout);

    // 「是否到达目的地」不能只看最后一跳有没有 IP。
    // 每跳只探 1 次时，目的地之前的跳丢一个包就是 "*"，把结论误判成"未到达"。
    // 输出头部写着目标 IP，只要**任何一跳命中它**就是真的到达了。
    const targetIp = parseTargetIpFromHeader(stdout);
    const completed = targetIp
      ? hops.some((h) => h.ip === targetIp)
      : hops.length > 0 && hops[hops.length - 1].ip !== null;
    const duration = Date.now() - startTime;

    return {
      target,
      hops,
      completed,
      duration,
    };
  } catch (error: any) {
    // ⚠️ **超时 ≠ 没有数据**。
    //
    // 被 kill 的那一刻, traceroute 已经输出了它走过的跳 —— 那些数据在
    // error.stdout 里(实测: " 1  * * *\n")。直接返回空结果等于把
    // "走到了第 5 跳但没到目的地" 这个**有意义的信息**丢成"什么都没查到"。
    //
    // 典型场景: 目标不可达 / 中间有跳不响应 / 网络受限。
    // 这时命令会跑满总超时被 SIGTERM, exit code 非 0。
    //
    // 所以: 优先解析已收到的输出, 解析出跳数就用, 一跳都没有才算真失败。
    const partial = extractPartialOutput(error);
    const hops = partial
      ? (platform === 'win32'
          ? parseWindowsTraceroute(partial)
          : parseUnixTraceroute(partial))
      : [];

    if (hops.length > 0) {
      const duration = Date.now() - startTime;
      const reached = hops.length > 0 && hops[hops.length - 1].ip !== null;
      console.warn(
        `[Traceroute] 超时(${duration}ms), 已取得 ${hops.length} 跳的部分结果` +
        (reached ? '' : ' (未到达目标)')
      );
      return {
        target,
        hops,
        completed: reached,
        duration,
      };
    }

    // 真失败: 没有任何可解析的输出
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
 * 从错误对象里取出**已收到的**命令输出。
 *
 * Node 的 exec 超时会抛错, 但 stdout/stderr 里已经有内容了。
 * 优先用 stdout(跳数数据在 macOS/Linux 的 stdout 里);
 * Windows 的 tracert 把数据也放 stdout, 标题在 stderr。
 * 两者都空 ⇒ 真的什么都没拿到。
 */
function extractPartialOutput(error: any): string | null {
  const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';

  if (stdout.trim()) return stdout;
  if (stderr.trim()) return stderr;
  return null;
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
/** 从输出头部解析目标 IP —— 判断「是否真的到达目的地」的唯一可靠依据 */
export function parseTargetIpFromHeader(output: string): string | null {
  // Unix:  traceroute to example.com (203.0.113.5), 15 hops max, 40 byte packets
  const unix = output.match(/traceroute to .*?\(([\d.]+)\)/);
  if (unix?.[1]) return unix[1];
  // Windows: Tracing route to example.com [203.0.113.5]
  const win = output.match(/[Tt]racing route to .*?\[([\d.]+)\]/);
  return win?.[1] ?? null;
}

export function parseUnixTraceroute(output: string): TraceHop[] {
  const lines = output.split('\n');
  const hops: TraceHop[] = [];
  /** 已见过的跳号 —— 多地址跳的续行要去重, 见下面的注释 */
  const seen = new Set<number>();

  for (const line of lines) {
    if (!line.trim()) continue;

    // ⚠️ 跳行必须以「跳号 + 空白」开头，不能只写 /^\s*(\d+)/。
    //
    // macOS 的 traceroute 在**多地址跳**（一个跳有多个应答设备）上会把
    // 第 2、3 个探测的响应换行成续行：
    //
    //     6  aaa (203.0.113.7)  28.753 ms
    //         bbb (198.51.100.3)  25.444 ms
    //
    // 续行以 IP/主机名开头。旧正则会把 IP 的首段当成跳号（"219.158.3.22"
    // ⇒ 跳号 219），产出一堆伪跳记录，界面上表现为「序号 219」「IP 显示成
    // 13335.」这种错位。加上 \s 之后：跳号后面必须是空白，而 IP 首段后面
    // 是 "."，续行自然被排除。
    const hopMatch = line.match(/^\s*(\d+)\s+/);
    if (!hopMatch) continue;

    const hopNum = parseInt(hopMatch[1], 10);

    // 同一跳号重复出现只保留首次响应（续行若被错误识别时的兜底）
    if (seen.has(hopNum)) continue;
    seen.add(hopNum);

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
      const rawHost = hostnameMatch?.[1];
      // 首个探测超时、后续探测有响应时，行首 token 是 "*" —— 别把它当主机名
      const hostname = rawHost && rawHost !== '*' && rawHost !== ip ? rawHost : ip;
      const rtt = timeMatch ? parseFloat(timeMatch[1]) : null;

      hops.push({
        hop: hopNum,
        ip,
        hostname,
        rtt,
      });
    } else {
      // -q 1 时完全无响应的跳只输出一个 "*"（不是 "* * *"），
      // 也要记成超时跳 —— 直接丢弃会让跳号出现空洞（1,2,4,5…）
      hops.push({
        hop: hopNum,
        ip: null,
        hostname: '* (超时)',
        rtt: null,
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