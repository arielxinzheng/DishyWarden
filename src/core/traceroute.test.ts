/**
 * traceroute.ts 单元测试
 * 
 * 覆盖：Unix/Windows traceroute 输出解析
 */

import { describe, it, expect } from 'vitest';
import { parseUnixTraceroute, parseWindowsTraceroute } from './traceroute';

describe('traceroute.ts - Unix 输出解析', () => {
  describe('parseUnixTraceroute', () => {
    it('正常输出解析', () => {
      const output = `
 1  192.168.100.1 (192.168.100.1)  1.234 ms  1.456 ms  1.789 ms
 2  10.0.0.1 (10.0.0.1)  5.678 ms  5.789 ms  5.890 ms
 3  example.com (93.184.216.34)  12.345 ms  12.456 ms  12.567 ms
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
        ip: '93.184.216.34',
        hostname: 'example.com',
        rtt: 12.345,
      });
    });

    it('超时跳解析', () => {
      const output = `
 1  192.168.100.1 (192.168.100.1)  1.234 ms
 2  * * *
 3  example.com (93.184.216.34)  12.345 ms
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
traceroute to example.com (93.184.216.34), 20 hops max, 60 byte packets

 1  192.168.100.1 (192.168.100.1)  1.234 ms

 2  example.com (93.184.216.34)  12.345 ms
`;
      const hops = parseUnixTraceroute(output);
      
      expect(hops).toHaveLength(2);
      expect(hops[0].hop).toBe(1);
      expect(hops[1].hop).toBe(2);
    });

    it('处理跳号不连续的情况', () => {
      const output = `
 1  192.168.1.1 (192.168.1.1)  1.234 ms
 5  example.com (93.184.216.34)  12.345 ms
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
Tracing route to example.com [93.184.216.34]
over a maximum of 20 hops:

  1    <1 ms    <1 ms    <1 ms  192.168.100.1
  2     5 ms     5 ms     5 ms  10.0.0.1
  3    12 ms    12 ms    12 ms  example.com [93.184.216.34]

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
      expect(hops[2].ip).toBe('93.184.216.34');
    });

    it('超时跳解析', () => {
      const output = `
  1    <1 ms    <1 ms    <1 ms  192.168.100.1
  2     *        *        *     请求超时。
  3    12 ms    12 ms    12 ms  example.com [93.184.216.34]
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
  3    12 ms    12 ms    12 ms  93.184.216.34
`;
      const hops = parseWindowsTraceroute(output);
      
      expect(hops[1].ip).toBeNull();
      expect(hops[1].hostname).toBe('* (超时)');
    });

    it('IP 在方括号中', () => {
      const output = `  3    12 ms    12 ms    12 ms  example.com [93.184.216.34]`;
      const hops = parseWindowsTraceroute(output);
      
      expect(hops).toHaveLength(1);
      expect(hops[0].ip).toBe('93.184.216.34');
      expect(hops[0].hostname).toBe('example.com');
    });

    it('忽略标题和尾部统计', () => {
      const output = `
Tracing route to example.com [93.184.216.34]
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
  });
});