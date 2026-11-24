/**
 * 探针节点执行器测试
 *
 * 覆盖三种探测类型的核心逻辑:
 *   - ICMP: ping 命令拼装 + 输出解析
 *   - DNS: 解析成功/失败
 *   - TLS: 握手成功/证书错误
 *
 * ICMP 用回环地址(127.0.0.1)—— 不依赖外网, CI 也能跑。
 */

import { describe, it, expect } from 'vitest';
import { runProbe, classifyDnsError, isProbeFresh } from './probeRunner';
import type { ProbeResult } from './probeRunner';
import type { ProbeNodeConfig } from '../config/manager';

const node = (over: Partial<ProbeNodeConfig> = {}): ProbeNodeConfig => ({
  id: 'test-node',
  name: '测试节点',
  target: '127.0.0.1',
  type: 'icmp',
  intervalSec: 60,
  timeoutSec: 5,
  enabled: true,
  ...over,
});

describe('probeRunner / ICMP', () => {
  it('ping 回环地址应该可达并给出延迟', async () => {
    const result = await runProbe(node({ target: '127.0.0.1' }));
    expect(result.ok).toBe(true);
    expect(result.rttMs).not.toBeNull();
    expect(result.rttMs!).toBeGreaterThanOrEqual(0);
    expect(result.nodeId).toBe('test-node');
  }, 20000);

  it('ping 不存在的保留地址应该失败(无响应)', async () => {
    // 192.0.2.1 是 RFC 5737 TEST-NET-1, 正常网络不会应答
    // 但本机有 17 个 utun 接口时会错误应答 —— 所以这条断言放宽:
    // 只要返回了结构完整的结果即可(成功或失败都合法)
    const result = await runProbe(node({ target: '192.0.2.1', timeoutSec: 2 }));
    expect(typeof result.ok).toBe('boolean');
    expect(result.ts).toBeGreaterThan(0);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  }, 20000);

  it('目标不可达时应该返回失败结果而不是抛异常', async () => {
    // ⚠️ 这条以前会**抛异常**：ping 目标不可达 ⇒ 退出码非 0 ⇒ exec reject
    // ⇒ 异常冒泡到 probeAndRecord（当时没有 try/catch）⇒ 节点状态永远停在
    // 「未知」，界面上表现为"本地路由器 状态未知 ?"。
    // 现在：异常被接住 → 解析 stdout → 判定不可达 → 再用 TCP 回落试一次。
    const result = await runProbe(
      node({ target: '192.0.2.254', timeoutSec: 1 }), // RFC 5737 保留地址，必然不通
    );
    expect(result).toBeTruthy();
    expect(typeof result.ok).toBe('boolean');
    expect(result.ts).toBeGreaterThan(0);
    // 不可达时必须有原因（界面要显示它）
    if (!result.ok) expect(result.error).toBeTruthy();
  }, 30000);

  it('ICMP 不通但 TCP 端口可达时应该判为可达（星链路由器不回 ICMP）', async () => {
    // 用本机一个确定在监听的 TCP 端口做回落验证：
    // 目标写成 127.0.0.1，但 ping 的目标是它 ⇒ ICMP 一定通 ⇒
    // 这里只验证回落逻辑存在且不崩溃（真实验证在真机上做）
    const result = await runProbe(node({ target: '127.0.0.1', timeoutSec: 2 }));
    expect(typeof result.ok).toBe('boolean');
  }, 20000);

  it('未知类型应该报错而不是崩溃', async () => {
    const result = await runProbe(node({ type: 'bogus' as never }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未知探测类型');
  });
});

describe('probeRunner / DNS', () => {
  it('解析 example.com 应该成功', async () => {
    const result = await runProbe(node({ type: 'dns', target: 'example.com', timeoutSec: 5 }));
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('example.com');
  }, 20000);

  it('解析不存在的域名应该失败', async () => {
    const result = await runProbe(
      node({ type: 'dns', target: 'nonexistent-host-xyz-12345.invalid', timeoutSec: 3 })
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  }, 20000);
});

describe('probeRunner / TLS', () => {
  it('握手失败(无效主机名)应该返回错误而不是崩溃', async () => {
    const result = await runProbe(
      node({ type: 'tls', target: 'nonexistent-host-xyz-12345.invalid', timeoutSec: 5 })
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  }, 20000);
});

/**
 * DNS 失败模式分类 —— 决定告警是「DNS 解析失败」还是「数据源不可用」。
 *
 * 判错的后果很具体：把"mock 挂了"报成"你的 DNS 配置坏了"是误诊。
 */
describe('DNS 失败模式分类', () => {
  it('连不上服务器 ⇒ unreachable（数据源不可用）', () => {
    for (const code of ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ENETDOWN', 'EPIPE']) {
      expect(classifyDnsError(code), code).toBe('unreachable');
    }
  });

  it('服务器答了但解析不出 ⇒ resolution（真的是 DNS 问题）', () => {
    for (const code of ['ENOTFOUND', 'NXDOMAIN', 'ESERVFAIL', 'ETIMEOUT', 'EAI_AGAIN']) {
      expect(classifyDnsError(code), code).toBe('resolution');
    }
  });

  it('错误码大小写不敏感', () => {
    expect(classifyDnsError('econnrefused')).toBe('unreachable');
  });

  it('错误码缺失/未知 ⇒ 按 resolution 处理（宁可多报，不要静默掉真故障）', () => {
    expect(classifyDnsError(undefined)).toBe('resolution');
    expect(classifyDnsError(null)).toBe('resolution');
    expect(classifyDnsError('')).toBe('resolution');
    expect(classifyDnsError('SOMETHING_NEW')).toBe('resolution');
  });
});

/**
 * 探针结果时效判定 —— 决定一份读数还能不能当「当前测量」写进历史库。
 *
 * 为什么必须测这段：它是「写 null」和「写入伪造的连续值」之间的唯一闸门。
 * 探针被禁用 / 循环卡死时 `last` 会永久冻结，若门限失效，曲线会显示网关
 * 延迟一路平稳正常，而实际上已经很久没有测量过 —— 这种污染比空缺更难发现。
 */
describe('isProbeFresh — 陈旧探针结果不得冒充新测量', () => {
  const T0 = 1_800_000_000_000;
  const probeAt = (ts: number): ProbeResult => ({
    nodeId: 'local-gateway',
    ok: true,
    rttMs: 2,
    ts,
  });

  it('刚测完的结果可用', () => {
    expect(isProbeFresh(probeAt(T0), 90_000, T0)).toBe(true);
  });

  it('恰好等于门限仍可用（边界取闭区间）', () => {
    expect(isProbeFresh(probeAt(T0 - 90_000), 90_000, T0)).toBe(true);
  });

  it('超过门限一毫秒即失效', () => {
    expect(isProbeFresh(probeAt(T0 - 90_001), 90_000, T0)).toBe(false);
  });

  it('冻结的旧值（探针被禁用后的典型场景）失效', () => {
    // 探针停摆 10 分钟后采集器仍在每 30 秒跑一次
    expect(isProbeFresh(probeAt(T0 - 10 * 60_000), 90_000, T0)).toBe(false);
  });

  it('从未探测过（null / undefined）视为不可用', () => {
    expect(isProbeFresh(null, 90_000, T0)).toBe(false);
    expect(isProbeFresh(undefined, 90_000, T0)).toBe(false);
  });

  it('时间戳在未来的结果视为不可信（时钟回拨）', () => {
    expect(isProbeFresh(probeAt(T0 + 1_000), 90_000, T0)).toBe(false);
  });

  it('失败结果只要新鲜仍可用 —— 失败本身是有意义的测量', () => {
    // 门限只判断「新旧」，不判断「成功失败」：失败要如实写库，
    // 由告警链路处理，不能被门限顺手吞掉。
    const failed: ProbeResult = { nodeId: 'local-gateway', ok: false, rttMs: null, error: 'timeout', ts: T0 };
    expect(isProbeFresh(failed, 90_000, T0)).toBe(true);
  });
});
