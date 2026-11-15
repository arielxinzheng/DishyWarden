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
import { promises as dnsPromises } from 'dns';
import { promisify } from 'util';

const execAsyncRaw = promisify(exec);

/**
 * 把命令输出（Buffer）解码成字符串。
 *
 * ⚠️ 中文 Windows 的 tracert 按 **OEM 代码页（936/GBK）** 输出，不是 UTF-8。
 * exec 默认按 UTF-8 解码 ⇒ "请求超时"/"无法解析目标系统名称" 全变乱码 ⇒
 * 超时跳识别不到、界面上的失败原因也是乱码。
 * 策略：先按 UTF-8 严格解码，失败（含非法序列）再按 GBK 解。
 */
export function decodeCommandOutput(buf: Buffer | string | undefined): string {
  if (buf === undefined || buf === null) return '';
  if (typeof buf === 'string') return buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

/** exec 包一层：拿 Buffer 再自行解码；抛错时也把 stdout/stderr 解码好挂回 error 上 */
async function execAsync(
  command: string,
  options: { timeout: number; maxBuffer: number; windowsHide: boolean },
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsyncRaw(command, { ...options, encoding: 'buffer' });
    return { stdout: decodeCommandOutput(stdout), stderr: decodeCommandOutput(stderr) };
  } catch (err: any) {
    if (err && typeof err === 'object') {
      err.stdout = decodeCommandOutput(err.stdout);
      err.stderr = decodeCommandOutput(err.stderr);
      // message 里拼的是 UTF-8 解码的 stderr（可能乱码）⇒ 用解码后的重拼
      if (err.stderr && typeof err.message === 'string') {
        err.message = `Command failed: ${command}\n${err.stderr}`;
      }
    }
    throw err;
  }
}

/**
 * 从 stdout/stderr 里挑一条**对人类有意义**的报错行。
 *
 * 为什么不直接把整段 stderr 丢给用户：
 *   · tracert 的 stderr 常常是空的，报错在 stdout 里（Windows 把
 *     "无法解析目标系统名称"、"Unable to resolve target" 都打到 stdout）
 *   · 完整 stdout 里混杂了"Tracing route to ..." 这种无信息头部
 * 所以：**只挑含关键字的行**；都没有就取首行非空；都空就返回 null。
 */
export function pickMeaningfulLine(
  stdout: string | undefined,
  stderr: string | undefined,
): string | null {
  const text = `${stderr ?? ''}\n${stdout ?? ''}`;
  const keywords = [
    '无法解析', '无法', '失败', '拒绝', '超时',
    'Unable', 'unable', 'cannot', 'Cannot', 'failed', 'denied', 'refused',
    'not recognized', '不是内部或外部命令',
    'Name or service not known', 'unknown host',
    'Network is unreachable', '网络不可达',
  ];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (keywords.some((k) => l.includes(k))) return l;
  }
  // 再退一步：取首个非空、不是 "跳号行"（以数字开头）、不是标题行的输出
  for (const l of lines) {
    if (/^(traceroute|Tracing|通过最多|over a maximum)/i.test(l)) continue;
    if (/^\s*\d+\s+/.test(l)) continue;
    return l;
  }
  return null;
}

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
  /**
   * 失败原因（可选）。
   *
   * 之前失败原因只写进主进程日志，界面只显示「无法获取路由信息」——
   * 用户无从判断是"tracert 命令没找到"还是"目标不可达"。
   * 现在把它带出来，界面直接显示。
   */
  error?: string;
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
    // -d: 不做反向 DNS 解析（理由同 Unix 的 -n）
    //
    // ⚠️ **-4 必须加**：tracert 默认走 IPv4，但目标域名常同时有 AAAA 记录
    // （example.com 就有）。解析到 IPv6 时 tracert 直接报
    //   "到 example.com [2606:4700:10:ac42:93f3] 的路由:" 然后失败 ——
    //   这不是网络不通，是**协议族不匹配**。强制 IPv4 才拿得到跳。
    //   （macOS/Linux 的 traceroute 默认双栈，不需要这个开关。）
    return `tracert -4 -h ${opts.maxHops} -w ${opts.hopTimeout * 1000} -d ${target}`;
  }
  // macOS/Linux: -m 最大跳数, -q 每跳探测次数, -w 单跳超时(秒), -n 不做反向 DNS
  //
  // ⚠️ -n 是刻意的：系统自带的逐跳反查在应用进程里实测每跳约 2.4s
  //   （15 跳就是 30s+，必然撞总超时，只拿到半截路径）。
  //   反查改由应用侧并发做，见 enrichHopHostnames。
  return `traceroute -m ${opts.maxHops} -q ${opts.probes} -w ${opts.hopTimeout} -n ${target}`;
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

  // Windows 上 GUI 进程的执行环境可能拿不到 PATH 里的系统工具
  // （'tracert' 不是内部或外部命令）⇒ 命令找不到时用绝对路径再试一次。
  const windowsFallback =
    platform === 'win32'
      ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\tracert` +
        ` -4 -h ${maxHops} -w ${hopTimeout * 1000} -d ${target}`
      : null;

  try {
    // ⚠️ exec 的成功路径**也要拿 stderr** ——
    // tracert 在 "无法解析目标系统名称" 这类情况下 **exit code 可能是 0**，
    // 真·报错行在 stderr 或 stdout 的非跳行里。只拿 stdout 的话，hops 解析出 0 条、
    // 界面只能给一句"无法获取路由信息"，用户无从判断是 DNS 还是防火墙。
    // 所以这里把 stderr 一并留下，`hops.length === 0` 的分支用它构造 error。
    let stdout: string;
    let stderr: string;
    try {
      ({ stdout, stderr } = await execAsync(command, {
        timeout,
        maxBuffer: 1024 * 1024, // 1MB
        // windowsHide: Windows 上 GUI 应用执行 tracert 会闪黑色控制台窗口
        windowsHide: true,
      }));
    } catch (err: any) {
      const msg = String(err?.message ?? '');
      const notFound = /不是内部或外部命令|not recognized as an internal/i.test(msg);
      if (!windowsFallback || !notFound) throw err;
      console.warn('[Traceroute] PATH 里找不到 tracert，改用绝对路径重试');
      ({ stdout, stderr } = await execAsync(windowsFallback, {
        timeout,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }));
    }

    const rawHops = platform === 'win32'
      ? parseWindowsTraceroute(stdout)
      : parseUnixTraceroute(stdout);

    // 补主机名：命令用 -n 跳过了系统反查，这里并发补一次（总预算 1.5s）
    const hops = await enrichHopHostnames(rawHops, { timeoutMs: 1500 });

    // 「是否到达目的地」不能只看最后一跳有没有 IP。
    // 每跳只探 1 次时，目的地之前的跳丢一个包就是 "*"，把结论误判成"未到达"。
    // 输出头部写着目标 IP，只要**任何一跳命中它**就是真的到达了。
    const targetIp = parseTargetIpFromHeader(stdout);
    const completed = targetIp
      ? hops.some((h) => h.ip === targetIp)
      : hops.length > 0 && hops[hops.length - 1].ip !== null;
    const duration = Date.now() - startTime;

    // hops 为空 = 命令成功但"没走出去一跳"。原因在 stdout/stderr 里 ——
    // 必须带原因回去（规则：**只要 hops 为空就必须有 error**）。
    const error =
      hops.length === 0
        ? pickMeaningfulLine(stdout, stderr) ?? 'tracert 没有返回任何跳（stdout/stderr 均为空）'
        : undefined;

    return {
      target,
      hops,
      completed,
      duration,
      ...(error ? { error } : {}),
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

    // 真失败: 没有任何可解析的跳
    console.error('[Traceroute] Failed:', error?.message);
    return {
      target,
      hops: [],
      completed: false,
      duration: Date.now() - startTime,
      // 把原因带出去 —— 界面直接显示，不再只有一句「无法获取路由信息」
      error: describeExecFailure(error, timeout),
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
/**
 * 把 exec 的失败对象翻成一句**用户看得懂**的原因。
 *
 * 优先级：超时 > 输出里的报错行 > exit code > error.message 首行。
 * `error.message` 是 "Command failed: tracert -h 15 ..." —— 只有命令行本身，
 * 原来直接显示它，等于没给原因。
 */
export function describeExecFailure(error: any, timeoutMs: number): string {
  const parts: string[] = [];
  if (error?.killed || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT') {
    parts.push(`超时（${Math.round(timeoutMs / 1000)}s 内没有任何跳返回）`);
  }
  const line = pickMeaningfulLine(
    typeof error?.stdout === 'string' ? error.stdout : '',
    typeof error?.stderr === 'string' ? error.stderr : '',
  );
  if (line) parts.push(line);
  if (typeof error?.code === 'number') parts.push(`exit code ${error.code}`);
  if (typeof error?.code === 'string' && error.code !== 'ETIMEDOUT') parts.push(error.code);
  if (parts.length === 0) {
    const msg = String(error?.message ?? error ?? '').split(/\r?\n/)[0].trim();
    parts.push(msg || 'traceroute 执行失败');
  }
  return parts.join('；').slice(0, 300);
}

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
/**
 * 反查单个 IP 的 PTR 记录；超时或失败返回 null。
 *
 * 用 Promise.race 套一层超时 —— 系统解析器没有超时参数，遇到慢 DNS 会一直挂着。
 */
async function reverseOne(
  reverse: (ip: string) => Promise<string>,
  ip: string,
  timeoutMs: number,
): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    const settled = await Promise.race([reverse(ip).catch(() => null), timeout]);
    if (!settled) return null;
    const name = settled.trim();
    // 有的解析器失败时会把 IP 原样返回，那不是主机名
    return name && name !== ip ? name : null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 默认反查实现 */
async function defaultReverse(ip: string): Promise<string> {
  const names = await dnsPromises.reverse(ip);
  return names[0] ?? ip;
}

export interface HostnameEnrichOptions {
  /** 每个反查等待多久（并发执行，总耗时≈这个值），默认 1500ms */
  timeoutMs?: number;
  /** 注入用：默认 dns.promises.reverse */
  reverse?: (ip: string) => Promise<string>;
}

/**
 * 给跳补主机名（应用侧反查）。
 *
 * 背景：traceroute 命令用 `-n` 不做反查（系统逐跳反查在应用进程里太慢，
 * 15 跳能干到 30s+）。这里对**有响应且还没名字**的跳并发查一次 PTR，
 * 总预算 timeoutMs 一到就收手：查到填主机名，查不到保持 IP。
 */
export async function enrichHopHostnames(
  hops: TraceHop[],
  options: HostnameEnrichOptions = {},
): Promise<TraceHop[]> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const reverse = options.reverse ?? defaultReverse;

  // 只查有 IP 但还没名字的跳（超时跳的 hostname 是 '* (超时)'，跳过）
  const pending = hops.filter((h) => h.ip !== null && h.hostname === h.ip);
  if (pending.length === 0) return hops;

  const names = await Promise.all(
    pending.map((h) => reverseOne(reverse, h.ip as string, timeoutMs)),
  );

  const resolved = new Map<number, string>();
  pending.forEach((h, index) => {
    const name = names[index];
    if (name) resolved.set(h.hop, name);
  });
  if (resolved.size === 0) return hops;

  return hops.map((h) => {
    const name = resolved.get(h.hop);
    return name ? { ...h, hostname: name } : h;
  });
}

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
  const lines = output.split(/\r?\n/);
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
  const lines = output.split(/\r?\n/);
  const hops: TraceHop[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    // 匹配跳数
    const hopMatch = line.match(/^\s*(\d+)/);
    if (!hopMatch) continue;

    const hopNum = parseInt(hopMatch[1], 10);

    // 检查是否超时
    // ⚠️ tracert 的超时行是 "  2     *        *        *     请求超时。" —— 星号之间是**多个空格**，
    // 只认 '* * *' 会漏；文案又随系统语言/代码页变化。⇒ 以"三个探测位全是 *"为准。
    const allStars = /^\s*\d+\s+\*\s+\*\s+\*/.test(line);
    if (allStars || line.includes('请求超时') || line.includes('Request timed out')) {
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