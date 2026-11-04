/**
 * 探针节点执行器
 *
 * 对应需求文档 2.1.3「网络连通性探测」: 主动探测网络各层连通性, 辅助故障定位。
 *
 * 三种探测类型, 各自回答不同的问题:
 *
 * | 类型 | 回答的问题 | 实现 |
 * |---|---|---|
 * | ICMP | 网络层通不通? 延迟多少? | ping 命令 |
 * | DNS  | 域名能不能解析? 解析器正常吗? | dns.promises.resolve4 |
 * | TLS  | 证书链正不正常? 有没有被劫持? | tls.connect |
 *
 * ## 为什么 ICMP 用 ping 命令而不是原生 socket
 *
 * Node 没有内置 ICMP —— 发 ping 包需要 raw socket, 要 root 权限。
 * macOS/Linux 有 `ping` 命令, Windows 有 `ping` 但参数不同。
 * 所以走子进程, 各平台拼各自的命令行(见 buildPingCommand)。
 *
 * ⚠️ **ICMP 可能被环境篡改**: 某些 VPN / 隧道 / 安全软件会应答所有 ICMP,
 * 连 RFC 5737 保留地址都 ping 得通。此时"可达"是假象 ——
 * 所以路由器状态那一块另有基线自检(见 routerProbe.ts)。
 */

import { exec } from 'child_process';
import { promises as dns } from 'dns';
import tls from 'tls';
import { EventEmitter } from 'events';
import type { ProbeConfig, ProbeNodeConfig } from '../config/manager';

const execAsync = (cmd: string, timeoutMs: number) =>
  new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      // exec 的错误 code 可能是退出码(number), 也可能是 errno 字符串(如 'ENOENT')
      const raw = error?.code;
      const code = typeof raw === 'number' ? raw : error ? 1 : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });

/** 一次探测的结果 */
export interface ProbeResult {
  /** 节点 id */
  nodeId: string;
  /** 探测成功(可达 / 能解析 / 握手成功) */
  ok: boolean;
  /** 往返延迟 ms(DNS/TLS 也有) */
  rttMs: number | null;
  /** 错误信息(失败时) */
  error?: string;
  /** 附加信息: DNS 解析出的 IP / TLS 证书信息 */
  detail?: string;
  /** 探测时刻 epoch ms */
  ts: number;
  /** 双轨 DNS 探测数据(仅 dns_dual 类型) */
  dualDns?: {
    /** 用户态探测(使用系统默认 DNS) */
    user: {
      ok: boolean;
      rttMs: number | null;
      error?: string;
      resolvedIp?: string;
    };
    /** 基准态探测(使用公网 DNS 如 8.8.8.8) */
    baseline: {
      ok: boolean;
      rttMs: number | null;
      error?: string;
      resolvedIp?: string;
    };
  };
}

/** 节点的最新状态(给 UI 显示) */
export interface ProbeNodeState {
  nodeId: string;
  /** 最近一次结果 */
  last: ProbeResult | null;
  /** 当前是否可达(UI 状态灯) */
  reachable: boolean;
  /** 连续失败次数(需求文档: 故障确认次数, 默认 3 次才确认故障) */
  consecutiveFailures: number;
}

/**
 * 按平台拼 ping 命令。
 *
 * macOS: `ping -c N -W timeoutSec target`  (-W 单位是秒)
 * Linux: `ping -c N -W timeoutSec target`  (-W 单位也是秒)
 * Windows: `ping -n N -w timeoutMs target` (-w 单位是毫秒)
 */
function buildPingCommand(target: string, count: number, timeoutSec: number): string {
  if (process.platform === 'win32') {
    return `ping -n ${count} -w ${timeoutSec * 1000} ${target}`;
  }
  return `ping -c ${count} -W ${timeoutSec} ${target}`;
}

/** 从 ping 输出里解析平均延迟 */
function parsePingRtt(output: string): number | null {
  // macOS: "round-trip min/avg/max/stddev = 0.043/0.052/0.062/0.008 ms"
  const mac = output.match(/=\s*[\d.]+\/([\d.]+)\/[\d.]+\/[\d.]+\s*ms/);
  if (mac) return parseFloat(mac[1]);
  // Linux: "rtt min/avg/max/mdev = 0.043/0.052/0.062/0.008 ms"
  const linux = output.match(/=\s*[\d.]+\/([\d.]+)\/[\d.]+\/[\d.]+\s*ms/);
  if (linux) return parseFloat(linux[1]);
  // Windows: "Average = 12ms" / "平均 = 12ms"
  const win = output.match(/(?:Average|平均)\s*=\s*(\d+)\s*ms/i);
  if (win) return parseInt(win[1], 10);
  return null;
}

/**
 * 执行一次 ICMP 探测。
 */
async function probeIcmp(node: ProbeNodeConfig): Promise<ProbeResult> {
  const started = Date.now();
  const count = 3;
  const { stdout, code } = await execAsync(
    buildPingCommand(node.target, count, node.timeoutSec),
    node.timeoutSec * 1000 + 2000
  );

  if (code !== 0 && !/\d+\s+packets received/.test(stdout)) {
    return {
      nodeId: node.id,
      ok: false,
      rttMs: null,
      error: '目标不可达',
      ts: Date.now(),
    };
  }

  const rttMs = parsePingRtt(stdout);
  // 100% 丢包时 ping 退出码非 0 但仍可能有输出
  const lossMatch = stdout.match(/([\d.]+)%\s*packet loss/);
  const loss = lossMatch ? parseFloat(lossMatch[1]) : 0;

  if (loss >= 100) {
    return {
      nodeId: node.id,
      ok: false,
      rttMs: null,
      error: '目标不可达 (100% 丢包)',
      ts: Date.now(),
    };
  }

  return {
    nodeId: node.id,
    ok: true,
    rttMs: rttMs ?? Date.now() - started,
    detail: loss > 0 ? `丢包 ${loss}%` : undefined,
    ts: Date.now(),
  };
}

/**
 * 执行一次 DNS 解析探测。
 *
 * target 填的是 DNS 服务器地址(如 8.8.8.8)时, 意思是"用这个解析器解析
 * example.com 能不能成功"; 填域名时, 意思是"这个域名能不能解析"。
 */
async function probeDns(node: ProbeNodeConfig): Promise<ProbeResult> {
  const started = Date.now();
  const isServer = /^\d+\.\d+\.\d+\.\d+$/.test(node.target);
  const query = isServer ? 'example.com' : node.target;

  try {
    const resolver = new dns.Resolver({ timeout: node.timeoutSec * 1000, tries: 1 });
    if (isServer) resolver.setServers([node.target]);
    const addresses = await resolver.resolve4(query);
    return {
      nodeId: node.id,
      ok: true,
      rttMs: Date.now() - started,
      detail: `${query} → ${addresses[0]}`,
      ts: Date.now(),
    };
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    return {
      nodeId: node.id,
      ok: false,
      rttMs: null,
      error: err?.code || err?.message || '解析失败',
      ts: Date.now(),
    };
  }
}

/**
 * 执行双轨 DNS 探测(用户态 vs 基准态)。
 *
 * 用于诊断：DNS 解析失败是【用户本地 DNS 故障】还是【域名本身/网络问题】。
 *
 * ## 探针逻辑
 * - **用户态探针**：使用系统默认 DNS 解析目标域名
 * - **基准态探针**：强制使用公网可靠 DNS(如 8.8.8.8/1.1.1.1) 解析相同域名
 *
 * ## 判定规则
 * - 用户态失败 + 基准态成功 ⇒ 本地 DNS 配置问题
 * - 两者都失败 ⇒ 网络层故障或域名不存在
 * - 用户态成功但延迟明显高于基准态 ⇒ 本地 DNS 性能差
 *
 * ## node.target 约定
 * 对于 `dns_dual` 类型，target 格式为 `domain|baseline_dns`，例如：
 * - `google.com|8.8.8.8`
 * - `apple.com|1.1.1.1`
 *
 * 也支持第三段 `domain|baseline_dns|user_dns`，显式指定**用户态**解析器：
 * - `example.com|127.0.0.1:9254|127.0.0.1:9253`
 *
 * 第三段的作用是**测试**用的 —— 让被测方能打到假 DNS 服务器,
 * 从而造出「用户态坏 / 基准态好」这种组合。
 * 生产环境不填第三段 ⇒ 用户态走系统默认 DNS（真实语义）。
 *
 * ⚠️ `user_dns` 支持 `ip:port` 语法（Node 的 `dns.Resolver.setServers` 支持），
 *   所以假 DNS 可以跑在非标准端口上。
 */
async function probeDnsDual(node: ProbeNodeConfig): Promise<ProbeResult> {
  const [domain, baselineDns, userDns] = node.target.split('|');
  if (!domain || !baselineDns) {
    return {
      nodeId: node.id,
      ok: false,
      rttMs: null,
      error: 'dns_dual 类型的 target 格式错误，应为 "domain|baseline_dns"',
      ts: Date.now(),
    };
  }

  // 并行执行双轨探测
  //
  // 用户态: 显式指定了 user_dns 就用它, 否则用系统默认 DNS(null)。
  const [userResult, baselineResult] = await Promise.all([
    probeDnsSingle(domain, userDns?.trim() || null, node.timeoutSec),
    probeDnsSingle(domain, baselineDns.trim(), node.timeoutSec),
  ]);

  // 整体判定：用户态成功才算成功(基准态仅用于对照)
  const ok = userResult.ok;
  const rttMs = userResult.rttMs;
  const error = userResult.error;

  // 生成详情文案
  let detail = '';
  if (ok && baselineResult.ok) {
    const delta = (userResult.rttMs ?? 0) - (baselineResult.rttMs ?? 0);
    if (delta > 100) {
      detail = `用户 DNS 延迟明显高于基准 (+${delta.toFixed(0)}ms)`;
    } else {
      detail = `双轨探测正常`;
    }
  } else if (!ok && baselineResult.ok) {
    detail = `用户 DNS 故障，但基准 DNS 正常 → 本地 DNS 配置问题`;
  } else if (!ok && !baselineResult.ok) {
    detail = `双轨探测均失败 → 网络层故障或域名不存在`;
  }

  return {
    nodeId: node.id,
    ok,
    rttMs,
    error,
    detail,
    ts: Date.now(),
    dualDns: {
      user: {
        ok: userResult.ok,
        rttMs: userResult.rttMs,
        error: userResult.error,
        resolvedIp: userResult.resolvedIp,
      },
      baseline: {
        ok: baselineResult.ok,
        rttMs: baselineResult.rttMs,
        error: baselineResult.error,
        resolvedIp: baselineResult.resolvedIp,
      },
    },
  };
}

/**
 * 单次 DNS 解析(内部辅助函数，供 probeDnsDual 调用)。
 *
 * @param domain 要解析的域名
 * @param server DNS 服务器地址(null 表示使用系统默认)
 * @param timeoutSec 超时秒数
 */
async function probeDnsSingle(
  domain: string,
  server: string | null,
  timeoutSec: number
): Promise<{
  ok: boolean;
  rttMs: number | null;
  error?: string;
  resolvedIp?: string;
}> {
  const started = Date.now();
  try {
    const resolver = new dns.Resolver({ timeout: timeoutSec * 1000, tries: 1 });
    if (server) resolver.setServers([server]);
    const addresses = await resolver.resolve4(domain);
    return {
      ok: true,
      rttMs: Date.now() - started,
      resolvedIp: addresses[0],
    };
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    return {
      ok: false,
      rttMs: null,
      error: err?.code || err?.message || '解析失败',
    };
  }
}

/**
 * 执行一次 TLS 握手探测。
 *
 * 握手成功 + 证书有效 ⇒ 通; 证书过期 / 主机名不匹配 ⇒ 失败(这正是要抓的)。
 */
async function probeTls(node: ProbeNodeConfig): Promise<ProbeResult> {
  const started = Date.now();
  const host = node.target.replace(/^https?:\/\//, '').split('/')[0];
  const port = node.target.match(/^https?:\/\/[^/]+:(\d+)/)?.[1] ?? '443';

  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host,
        port: parseInt(port, 10),
        servername: host,
        rejectUnauthorized: true,   // 证书有问题要报错, 这才是探测的意义
        timeout: node.timeoutSec * 1000,
      },
      () => {
        const cert = socket.getPeerCertificate();
        const issuer = cert?.issuer?.O || cert?.issuer?.CN || '未知';
        socket.destroy();
        resolve({
          nodeId: node.id,
          ok: true,
          rttMs: Date.now() - started,
          detail: `证书签发者 ${issuer}`,
          ts: Date.now(),
        });
      }
    );

    socket.on('timeout', () => {
      socket.destroy();
      resolve({
        nodeId: node.id,
        ok: false,
        rttMs: null,
        error: `TLS 握手超时 (${node.timeoutSec}s)`,
        ts: Date.now(),
      });
    });

    socket.on('error', (error: Error & { code?: string }) => {
      resolve({
        nodeId: node.id,
        ok: false,
        rttMs: null,
        error: error?.code || error?.message || 'TLS 握手失败',
        ts: Date.now(),
      });
    });
  });
}

/** 按类型分发 */
export async function runProbe(node: ProbeNodeConfig): Promise<ProbeResult> {
  switch (node.type) {
    case 'icmp':
      return probeIcmp(node);
    case 'dns':
      return probeDns(node);
    case 'dns_dual':
      return probeDnsDual(node);
    case 'tls':
      return probeTls(node);
    default:
      return {
        nodeId: node.id,
        ok: false,
        rttMs: null,
        error: `未知探测类型: ${node.type}`,
        ts: Date.now(),
      };
  }
}

/**
 * 探针节点管理器
 *
 * 按每个节点自己的间隔周期性探测, 维护各节点状态。
 * 事件:
 *   - `result`  —— 每次探测完成
 *   - `state`   —— 节点可达状态变化
 */
export class ProbeRunner extends EventEmitter {
  private config: ProbeConfig;
  private timers = new Map<string, NodeJS.Timeout>();
  private states = new Map<string, ProbeNodeState>();
  private running = false;
  /**
   * 已停止标记。
   *
   * ⚠️ `stop()` 只清掉**定时器**, 但**在飞的那次探测还在跑** ——
   * `runProbe()` 是异步的(带超时, 最长几秒), 它 resolve 之后
   * `probeAndRecord` 仍会 `emit('result')`。
   *
   * 退出时序:
   *   1. `before-quit` ⇒ `stopBackgroundServices()` ⇒ `probeRunner.stop()`
   *   2. 但窗口/渲染进程此时可能已被销毁(GPU 被 SIGTERM ⇒
   *      network service 重启 ⇒ frame 被回收)
   *   3. 在飞的那次探测 resolve ⇒ emit ⇒ 往已销毁的 frame 推
   *      ⇒ "Error sending from webFrameMain: Render frame was disposed"
   *
   * ⇒ 用这个标记让在飞的结果**直接丢弃**, 不再 emit。
   */
  private stopped = false;

  constructor(config: ProbeConfig) {
    super();
    this.config = config;
  }

  /** 应用新配置(增删改节点后重建定时器) */
  applyConfig(config: ProbeConfig): void {
    this.config = config;
    this.restart();
  }

  /** 启动所有启用节点的定时探测 */
  start(): void {
    if (this.running) return;
    this.running = true;
    // 重启 ⇒ 清掉停止标记(上一次 stop() 置的)
    this.stopped = false;
    this.scheduleAll();
  }

  /** 停止所有定时器 */
  stop(): void {
    this.running = false;
    // ⚠️ 置位 stopped ⇒ 在飞的那次探测 resolve 后**不再 emit**
    //    (否则会往已销毁的渲染层推, 见 stopped 字段的注释)
    this.stopped = true;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  /** 重建定时器(配置变了) */
  private restart(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    if (this.running) this.scheduleAll();
  }

  private scheduleAll(): void {
    for (const node of this.config.nodes) {
      if (!node.enabled) continue;
      this.scheduleNode(node);
    }
  }

  private scheduleNode(node: ProbeNodeConfig): void {
    // 已有定时器且间隔没变 ⇒ 不重建
    const existing = this.timers.get(node.id);
    if (existing) {
      const same = this.config.nodes.find((n) => n.id === node.id);
      if (same && same.intervalSec === node.intervalSec) return;
      clearInterval(existing);
      this.timers.delete(node.id);
    }

    const periodMs = Math.max(5, node.intervalSec) * 1000;
    // 立即探一次, 之后按间隔
    void this.probeAndRecord(node);
    const timer = setInterval(() => void this.probeAndRecord(node), periodMs);
    this.timers.set(node.id, timer);
  }

  private async probeAndRecord(node: ProbeNodeConfig): Promise<void> {
    const result = await runProbe(node);

    // ⚠️ 探测期间可能已经 stop() 了(退出流程) ——
    //   此时不该再 emit: 渲染层可能已销毁, 推过去会抛
    //   "Render frame was disposed before WebFrameMain could be accessed"。
    if (this.stopped) return;

    const prev = this.states.get(node.id);
    const consecutiveFailures = result.ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1;
    const state: ProbeNodeState = {
      nodeId: node.id,
      last: result,
      reachable: result.ok,
      consecutiveFailures,
    };
    this.states.set(node.id, state);

    this.emit('result', result, state);

    // 可达状态变化时才发 state 事件(UI 状态灯)
    if (!prev || prev.reachable !== state.reachable) {
      this.emit('state', state);
    }
  }

  /** 取所有节点的当前状态 */
  getStates(): ProbeNodeState[] {
    return this.config.nodes.map((n) =>
      this.states.get(n.id) ?? {
        nodeId: n.id,
        last: null,
        reachable: false,
        consecutiveFailures: 0,
      }
    );
  }

  /** 取某个节点的当前状态 */
  getState(nodeId: string): ProbeNodeState | null {
    return this.states.get(nodeId) ?? null;
  }

  /** 手动触发一次探测(设置页的"立即测试"按钮) */
  async probeNow(nodeId: string): Promise<ProbeResult | null> {
    const node = this.config.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    const result = await runProbe(node);
    const prev = this.states.get(node.id);
    this.states.set(node.id, {
      nodeId: node.id,
      last: result,
      reachable: result.ok,
      consecutiveFailures: result.ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1,
    });
    this.emit('result', result, this.states.get(node.id)!);
    return result;
  }
}
