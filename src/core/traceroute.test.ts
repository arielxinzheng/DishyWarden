/**
 * traceroute.ts 单元测试
 * 
 * 覆盖：Unix/Windows traceroute 输出解析
 */

import { describe, it, expect } from 'vitest';
import {
  parseUnixTraceroute,
  parseWindowsTraceroute,
  parseTargetIpFromHeader,
  buildTraceCommand,
  enrichHopHostnames,
} from './traceroute';

describe('traceroute.ts - Unix 输出解析', () => {
  describe('parseUnixTraceroute', () => {
    it('正常输出解析', () => {
      const output = `
 1  192.168.100.1 (192.168.100.1)  1.234 ms  1.456 ms  1.789 ms
 2  10.0.0.1 (10.0.0.1)  5.678 ms  5.789 ms  5.890 ms
 3  example.com (198.51.100.7)  12.345 ms  12.456 ms  12.567 ms
`;
      const hops = parseUnixTraceroute(output);
      
      expect(hops).toHaveLength(3);
      expect(hops[0]).toEqual({
        hop: 1,
        ip: '192.168.100.1',
        hostname: '192.168.100.1',
        rtt: 1.234,
      });
      expect(hops[2]).toEqual({
        hop: 3,
        ip: '198.51.100.7',
        hostname: 'example.com',
        rtt: 12.345,
      });
    });

    it('超时跳解析', () => {
      const output = `
 1  192.168.100.1 (192.168.100.1)  1.234 ms
 2  * * *
 3  example.com (198.51.100.7)  12.345 ms
`;
      const hops = parseUnixTraceroute(output);
      
      expect(hops).toHaveLength(3);
      expect(hops[1]).toEqual({
        hop: 2,
        ip: null,
        hostname: '* (超时)',
        rtt: null,
      });
    });

    it('主机名与 IP 不同时显示主机名', () => {
      const output = `
 1  router.local (192.168.1.1)  1.234 ms
 2  gateway.isp.com (203.0.113.1)  5.678 ms
`;
      const hops = parseUnixTraceroute(output);
      
      expect(hops[0].hostname).toBe('router.local');
      expect(hops[0].ip).toBe('192.168.1.1');
      expect(hops[1].hostname).toBe('gateway.isp.com');
    });

    it('只有 IP 没有主机名', () => {
      const output = ` 1  192.168.1.1  1.234 ms  1.456 ms  1.789 ms`;
      const hops = parseUnixTraceroute(output);
      
      expect(hops).toHaveLength(1);
      expect(hops[0].ip).toBe('192.168.1.1');
      expect(hops[0].hostname).toBe('192.168.1.1');
    });

    it('忽略标题行和空行', () => {
      const output = `
traceroute to example.com (198.51.100.7), 20 hops max, 60 byte packets

 1  192.168.100.1 (192.168.100.1)  1.234 ms

 2  example.com (198.51.100.7)  12.345 ms
`;
      const hops = parseUnixTraceroute(output);
      
      expect(hops).toHaveLength(2);
      expect(hops[0].hop).toBe(1);
      expect(hops[1].hop).toBe(2);
    });

    it('处理跳号不连续的情况', () => {
      const output = `
 1  192.168.1.1 (192.168.1.1)  1.234 ms
 5  example.com (198.51.100.7)  12.345 ms
`;
      const hops = parseUnixTraceroute(output);
      
      expect(hops).toHaveLength(2);
      expect(hops[0].hop).toBe(1);
      expect(hops[1].hop).toBe(5);
    });

    it('空输出返回空数组', () => {
      expect(parseUnixTraceroute('')).toEqual([]);
      expect(parseUnixTraceroute('\n\n\n')).toEqual([]);
    });

    // 多地址跳：macOS 会把第 2、3 个探测的响应换行成以 IP 开头的续行。
    // 旧正则把这些续行当成新跳，跳号取到 IP 首段（199/219），界面上就出现
    // 「序号 219」和「IP 显示成 13335.」这类错位。
    it('多地址跳的续行不应产生伪跳', () => {
      const output = `
 1  * * *
 2  10.11.80.1 (10.11.80.1)  14.258 ms
    10.11.80.2 (10.11.80.2)  7.841 ms
 3  xe-0-1-0.gw8.sjc7.alter.net (219.158.103.34)  296.760 ms
    219.158.103.35 (219.158.103.35)  308.265 ms
    * * *
`;
      const hops = parseUnixTraceroute(output);

      // 只有 3 跳，不是 6 跳
      expect(hops).toHaveLength(3);
      expect(hops.map((h) => h.hop)).toEqual([1, 2, 3]);
      // 续行里的 IP 首段不该变成跳号
      expect(hops.some((h) => h.hop > 3)).toBe(false);
    });

    it('同一跳号重复出现只保留首次响应', () => {
      const output = `
 4  124.65.194.101 (124.65.194.101)  38.8 ms
 4  124.65.194.89 (124.65.194.89)  34.1 ms
`;
      const hops = parseUnixTraceroute(output);

      expect(hops).toHaveLength(1);
      expect(hops[0].hop).toBe(4);
      expect(hops[0].ip).toBe('124.65.194.101');
    });

    it('首探测超时、后续有响应时主机名回退为 IP（不显示 "*"）', () => {
      const output = ` 6  * 124.65.194.156 (124.65.194.156)  28.753 ms`;
      const hops = parseUnixTraceroute(output);

      expect(hops).toHaveLength(1);
      expect(hops[0].ip).toBe('124.65.194.156');
      expect(hops[0].hostname).toBe('124.65.194.156');
      expect(hops[0].rtt).toBe(28.753);
    });
  });
});

describe('traceroute.ts - Windows 输出解析', () => {
  describe('parseWindowsTraceroute', () => {
    it('正常输出解析', () => {
      const output = `
Tracing route to example.com [198.51.100.7]
over a maximum of 20 hops:

  1    <1 ms    <1 ms    <1 ms  192.168.100.1
  2     5 ms     5 ms     5 ms  10.0.0.1
  3    12 ms    12 ms    12 ms  example.com [198.51.100.7]

Trace complete.
`;
      const hops = parseWindowsTraceroute(output);
      
      expect(hops).toHaveLength(3);
      expect(hops[0]).toEqual({
        hop: 1,
        ip: '192.168.100.1',
        hostname: '192.168.100.1',
        rtt: 1, // <1 ms 被解析为 1
      });
      expect(hops[2].hostname).toBe('example.com');
      expect(hops[2].ip).toBe('198.51.100.7');
    });

    it('超时跳解析', () => {
      const output = `
  1    <1 ms    <1 ms    <1 ms  192.168.100.1
  2     *        *        *     请求超时。
  3    12 ms    12 ms    12 ms  example.com [198.51.100.7]
`;
      const hops = parseWindowsTraceroute(output);
      
      expect(hops).toHaveLength(3);
      expect(hops[1]).toEqual({
        hop: 2,
        ip: null,
        hostname: '* (超时)',
        rtt: null,
      });
    });

    it('处理不同语言的超时消息', () => {
      const output = `
  1    <1 ms    <1 ms    <1 ms  192.168.100.1
  2     *        *        *     Request timed out.
  3    12 ms    12 ms    12 ms  198.51.100.7
`;
      const hops = parseWindowsTraceroute(output);
      
      expect(hops[1].ip).toBeNull();
      expect(hops[1].hostname).toBe('* (超时)');
    });

    it('IP 在方括号中', () => {
      const output = `  3    12 ms    12 ms    12 ms  example.com [198.51.100.7]`;
      const hops = parseWindowsTraceroute(output);
      
      expect(hops).toHaveLength(1);
      expect(hops[0].ip).toBe('198.51.100.7');
      expect(hops[0].hostname).toBe('example.com');
    });

    it('忽略标题和尾部统计', () => {
      const output = `
Tracing route to example.com [198.51.100.7]
over a maximum of 20 hops:

  1    <1 ms    <1 ms    <1 ms  192.168.100.1

Trace complete.
`;
      const hops = parseWindowsTraceroute(output);
      
      expect(hops).toHaveLength(1);
    });

    it('< 1ms 的延迟解析为 1', () => {
      const output = `  1    <1 ms    <1 ms    <1 ms  192.168.1.1`;
      const hops = parseWindowsTraceroute(output);
      
      expect(hops[0].rtt).toBe(1);
    });

    it('空输出返回空数组', () => {
      expect(parseWindowsTraceroute('')).toEqual([]);
      expect(parseWindowsTraceroute('\n\n\n')).toEqual([]);
    });

    // 真机 tracert 输出是 **CRLF**。之前按 '\n' 切行，每行尾巴带 '\r'，
    // IP 正则 `...\]?$` 永远不匹配 ⇒ 每一跳都被丢掉 ⇒ 界面「无法获取路由信息」。
    it('CRLF 换行（Windows 真机输出）照样解析', () => {
      const output = [
        '',
        'Tracing route to example.com [198.51.100.7]',
        'over a maximum of 15 hops:',
        '',
        '  1    <1 ms    <1 ms    <1 ms  192.168.100.1',
        '  2     *        *        *     Request timed out.',
        '  3    12 ms    12 ms    12 ms  198.51.100.7',
        '',
        'Trace complete.',
        '',
      ].join('\r\n');
      const hops = parseWindowsTraceroute(output);
      expect(hops).toHaveLength(3);
      expect(hops[0].ip).toBe('192.168.100.1');
      expect(hops[1].ip).toBeNull();
      expect(hops[2].ip).toBe('198.51.100.7');
    });

    it('超时行文案乱码/未知语言时，靠三个 * 识别', () => {
      const hops = parseWindowsTraceroute('  2     *        *        *     ÇëÇó³¬Ê±¡£\r\n');
      expect(hops).toEqual([{ hop: 2, ip: null, hostname: '* (超时)', rtt: null }]);
    });

    // 第 4 轮真机反馈：失败原因只剩「到 example.com [...] 的路由:」、0 跳。
    // 中文 Windows tracert 的真实形态：CRLF、亚毫秒写成「<1 毫秒」、
    // **每个跳行行尾带一个空格**、前面有「通过最多 N 个跃点跟踪」「到 … 的路由:」两行说明。
    const ZH_WIN_OUTPUT = [
      '',
      '通过最多 15 个跃点跟踪',
      '到 example.com [203.0.113.5] 的路由:',
      '',
      '  1    <1 毫秒   <1 毫秒   <1 毫秒 192.168.1.1 ',
      '  2     3 ms     2 ms     2 ms  10.11.80.1 ',
      '  3     *        *        *     请求超时。',
      '  4    31 ms    *       29 ms  100.64.0.1 ',
      '  5    40 ms    41 ms    40 ms  203.0.113.5 ',
      '',
      '跟踪完成。',
      '',
    ].join('\r\n');

    it('中文 Windows 真实输出（毫秒 / 行尾空格 / CRLF / 说明行）⇒ 5 跳', () => {
      const hops = parseWindowsTraceroute(ZH_WIN_OUTPUT);
      expect(hops).toEqual([
        { hop: 1, ip: '192.168.1.1', hostname: '192.168.1.1', rtt: 1 },
        { hop: 2, ip: '10.11.80.1', hostname: '10.11.80.1', rtt: 3 },
        { hop: 3, ip: null, hostname: '* (超时)', rtt: null },
        { hop: 4, ip: '100.64.0.1', hostname: '100.64.0.1', rtt: 31 },
        { hop: 5, ip: '203.0.113.5', hostname: '203.0.113.5', rtt: 40 },
      ]);
    });

    it('「<1 ms」里的 1 不会被当成 IP，也不会被当成主机名', () => {
      const [hop] = parseWindowsTraceroute('  1    <1 ms    <1 ms    <1 ms  192.168.1.1 \r\n');
      expect(hop.ip).toBe('192.168.1.1');
      expect(hop.hostname).toBe('192.168.1.1');
      expect(hop.rtt).toBe(1);
    });

    it('行尾空格不影响解析（旧正则 …]?$ 在这里全部失配）', () => {
      const hops = parseWindowsTraceroute('  3    12 ms    12 ms    12 ms  example.com [198.51.100.7] \r\n');
      expect(hops).toEqual([{ hop: 3, ip: '198.51.100.7', hostname: 'example.com', rtt: 12 }]);
    });

    it('说明行不算跳：无法访问目标主机或路由。/ 到 … 的路由: / 通过最多 … 跃点', () => {
      const out = [
        '无法访问目标主机或路由。',
        '通过最多 15 个跃点跟踪',
        '到 example.com [203.0.113.5] 的路由:',
        'Tracing route to example.com [203.0.113.5]',
        'over a maximum of 15 hops:',
        'Trace complete.',
        '跟踪完成。',
      ].join('\r\n');
      expect(parseWindowsTraceroute(out)).toEqual([]);
    });

    it('前置说明行之后的跳照常解析', () => {
      const out = [
        '无法访问目标主机或路由。',
        '到 example.com [203.0.113.5] 的路由:',
        '  1    <1 ms    <1 ms    <1 ms  192.168.1.1 ',
        '  2     3 ms     2 ms     2 ms  10.0.0.1 ',
      ].join('\r\n');
      expect(parseWindowsTraceroute(out).map((h) => h.ip)).toEqual(['192.168.1.1', '10.0.0.1']);
    });

    it('首探测 * 时 RTT 取第一个有响应的探测', () => {
      const [hop] = parseWindowsTraceroute('  4     *       29 ms    30 ms  100.64.0.1 ');
      expect(hop).toEqual({ hop: 4, ip: '100.64.0.1', hostname: '100.64.0.1', rtt: 29 });
    });

    it('「报告: 无法访问目标主机。」的跳仍记下回报的 IP', () => {
      const [hop] = parseWindowsTraceroute('  6    45 ms    44 ms    44 ms  198.51.100.9 报告: 无法访问目标主机。');
      expect(hop.ip).toBe('198.51.100.9');
    });
  });
});

describe('traceroute.ts - 命令构造', () => {
  // -q 参数写错（例如写成 -Q/--queries）不会报错，只会静默走系统默认的 3 次探测，
  // 高延迟链路上必然撞总超时 —— 所以这里把命令串住。
  it('macOS/Linux 带 -q 每跳探测次数', () => {
    const cmd = buildTraceCommand('darwin', 'example.com', {
      maxHops: 15,
      hopTimeout: 2,
      probes: 1,
    });
    expect(cmd).toBe('traceroute -m 15 -q 1 -w 2 -n example.com');
  });

  it('Linux 同样是 traceroute 语法', () => {
    const cmd = buildTraceCommand('linux', '10.0.0.1', {
      maxHops: 10,
      hopTimeout: 3,
      probes: 2,
    });
    expect(cmd).toBe('traceroute -m 10 -q 2 -w 3 -n 10.0.0.1');
  });

  it('Windows 用 tracert，没有探测次数参数，但强制 IPv4', () => {
    const cmd = buildTraceCommand('win32', 'example.com', {
      maxHops: 15,
      hopTimeout: 2,
      probes: 1,
    });
    // ⚠️ -4 是必须的：目标同时有 AAAA 记录时（example.com 就是），
    // tracert 默认走 IPv4 会直接报"到 xxx [IPv6] 的路由:" 然后失败。
    expect(cmd).toBe('tracert -4 -h 15 -w 2000 -d example.com');
    expect(cmd).not.toContain('-q');
    expect(cmd).toContain('-4');
  });
});

describe('traceroute.ts - 目标 IP 与到达判定', () => {
  it('从 Unix 头部解析目标 IP', () => {
    const output = `traceroute to example.com (203.0.113.5), 15 hops max, 40 byte packets
 1  *`;
    expect(parseTargetIpFromHeader(output)).toBe('203.0.113.5');
  });

  it('从 Windows 头部解析目标 IP', () => {
    const output = `Tracing route to example.com [203.0.113.5]
over a maximum of 20 hops:`;
    expect(parseTargetIpFromHeader(output)).toBe('203.0.113.5');
  });

  it('头部没有 IP 时返回 null', () => {
    expect(parseTargetIpFromHeader('traceroute to example.com, 15 hops max')).toBeNull();
    expect(parseTargetIpFromHeader('')).toBeNull();
  });

  // -q 1 下目的地之前的跳丢单个包就是 "*"，用「最后一跳有没有 IP」判到达会误判
  it('任何一跳命中目标 IP 即判定到达（即使后面还有 * 跳）', () => {
    const output = `traceroute to example.com (198.51.100.7), 15 hops max, 40 byte packets
 12  example.com (198.51.100.7)  250.5 ms
 13  *
 14  *
`;
    const hops = parseUnixTraceroute(output);
    expect(hops).toHaveLength(3);
    expect(parseTargetIpFromHeader(output)).toBe('198.51.100.7');
    // 目标 IP 出现在第 12 跳 ⇒ 已到达（页面逻辑用这个判据）
    expect(hops.some((h) => h.ip === '198.51.100.7')).toBe(true);
  });
});

describe('traceroute.ts - 单探测的超时跳（-q 1）', () => {
  it('只有一个 "*" 的跳也要记成超时跳，不能丢（否则跳号出空洞）', () => {
    const output = `
 1  10.0.0.1 (10.0.0.1)  2.1 ms
 2  *
 3  example.com (198.51.100.7)  12.3 ms
`;
    const hops = parseUnixTraceroute(output);

    expect(hops).toHaveLength(3);
    expect(hops.map((h) => h.hop)).toEqual([1, 2, 3]);
    expect(hops[1]).toEqual({ hop: 2, ip: null, hostname: '* (超时)', rtt: null });
  });
});


describe('traceroute.ts - 应用侧反查补全主机名', () => {
  const hops = () => [
    { hop: 1, ip: null, hostname: '* (超时)', rtt: null },
    { hop: 2, ip: '10.11.80.1', hostname: '10.11.80.1', rtt: 5.2 },
    { hop: 3, ip: '203.0.113.9', hostname: '203.0.113.9', rtt: 30.1 },
    { hop: 4, ip: '198.51.100.4', hostname: '198.51.100.4', rtt: 40.2 },
  ];

  it('查到的填主机名，查不到的保持 IP', async () => {
    const reverse = async (ip: string) => {
      if (ip === '10.11.80.1') return 'gw.local';
      throw new Error('SERVFAIL');
    };
    const out = await enrichHopHostnames(hops(), { reverse, timeoutMs: 200 });

    expect(out[1].hostname).toBe('gw.local');
    expect(out[2].hostname).toBe('203.0.113.9'); // 查不到 ⇒ 还是 IP
    expect(out[3].hostname).toBe('198.51.100.4');
  });

  it('超时跳不参与反查', async () => {
    const calls: string[] = [];
    const reverse = async (ip: string) => {
      calls.push(ip);
      return `name-${ip}`;
    };
    const out = await enrichHopHostnames(hops(), { reverse, timeoutMs: 200 });

    // 第 1 跳没有 IP（超时），不该被查
    expect(calls).toEqual(['10.11.80.1', '203.0.113.9', '198.51.100.4']);
    expect(out[0].hostname).toBe('* (超时)');
  });

  it('反查挂住时按超时收手，不影响其它跳', async () => {
    const reverse = (ip: string) =>
      ip === '10.11.80.1' ? new Promise<string>(() => {}) : Promise.resolve('slow-ok');
    const started = Date.now();
    const out = await enrichHopHostnames(hops(), { reverse, timeoutMs: 50 });

    expect(Date.now() - started).toBeLessThan(500); // 没有干等
    expect(out[1].hostname).toBe('10.11.80.1');      // 挂住的那个保持 IP
    expect(out[2].hostname).toBe('slow-ok');         // 其它照常补上
  });

  it('解析器把 IP 原样返回时不当作主机名', async () => {
    const reverse = async (ip: string) => ip;
    const out = await enrichHopHostnames(hops(), { reverse, timeoutMs: 200 });
    expect(out[1].hostname).toBe('10.11.80.1');
  });

  it('没有可查的跳时原样返回（不发起查询）', async () => {
    const reverse = async () => {
      throw new Error('不该被调用');
    };
    const input = [{ hop: 1, ip: null, hostname: '* (超时)', rtt: null }];
    expect(await enrichHopHostnames(input, { reverse })).toEqual(input);
  });
});
