/**
 * ping 输出解析测试 —— 三平台 + 中文 Windows + GBK 乱码。
 *
 * 之前 routerProbe 在 Windows 上的丢包正则永远失配 ⇒ packetLoss 兜底成 0
 * ⇒ 目标不通也显示"可达"。这里的用例把那次 bug 钉死。
 */

import { describe, it, expect } from 'vitest';
import { parsePingStats, parsePingRtt, parsePingLoss } from './pingParse';

const MAC_OUTPUT = `
PING 192.168.22.1 (192.168.22.1): 56 data bytes
64 bytes from 192.168.22.1: icmp_seq=0 ttl=64 time=5.123 ms
64 bytes from 192.168.22.1: icmp_seq=1 ttl=64 time=8.234 ms
64 bytes from 192.168.22.1: icmp_seq=2 ttl=64 time=6.345 ms

--- 192.168.22.1 ping statistics ---
3 packets transmitted, 3 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 5.123/6.567/8.234/1.301 ms
`;

const LINUX_OUTPUT = `
64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=205.3 ms
3 packets transmitted, 3 received, 0% packet loss, time 2003ms
rtt min/avg/max/mdev = 204.812/205.301/206.110/0.512 ms
`;

const WIN_EN = `
Pinging 192.168.1.1 with 32 bytes of data:
Reply from 192.168.1.1: bytes=32 time=2ms TTL=64
Reply from 192.168.1.1: bytes=32 time=1ms TTL=64
Reply from 192.168.1.1: bytes=32 time=2ms TTL=64

Ping statistics for 192.168.1.1:
    Packets: Sent = 3, Received = 3, Lost = 0 (0% loss),
Approximate round trip times in milli-seconds:
    Minimum = 1ms, Maximum = 2ms, Average = 1ms
`;

// 中文 Windows 的真实输出
const WIN_CN = `
正在 Ping 192.168.1.1 具有 32 字节的数据:
来自 192.168.1.1 的回复: 字节=32 时间=2ms TTL=64
来自 192.168.1.1 的回复: 字节=32 时间=1ms TTL=64
来自 192.168.1.1 的回复: 字节=32 时间=2ms TTL=64

192.168.1.1 的 Ping 统计信息:
    数据包: 已发送 = 3，已接收 = 3，丢失 = 0 (0% 丢失)，
往返行程的估计时间(以毫秒为单位):
    最短 = 1ms，最长 = 2ms，平均 = 1ms
`;

// 中文 Windows 输出按 GBK 编码、Node 按 UTF-8 解码 ⇒ 中文全变 U+FFFD 乱码。
// ASCII 部分（=、ms、%、括号、数字）原样保留 —— 解析只锚定这些。
const WIN_CN_MOJIBAKE = WIN_CN.replace(/[\u4e00-\u9fff\uff0c\uff1a]/g, '\ufffd');

// Windows 全部超时: 退出码 1, 但 stdout 里仍有统计
const WIN_TIMEOUT_EN = `
Pinging 203.0.113.9 with 32 bytes of data:
Request timed out.
Request timed out.
Request timed out.

Ping statistics for 203.0.113.9:
    Packets: Sent = 3, Received = 0, Lost = 3 (100% loss),
`;

const WIN_TIMEOUT_CN = `
正在 Ping 203.0.113.9 具有 32 字节的数据:
请求超时。
请求超时。
请求超时。

203.0.113.9 的 Ping 统计信息:
    数据包: 已发送 = 3，已接收 = 0，丢失 = 3 (100% 丢失)，
`.replace(/[\u4e00-\u9fff\uff0c\uff1a]/g, '\ufffd');

describe('pingParse · macOS', () => {
  it('延迟与丢包', () => {
    const s = parsePingStats(MAC_OUTPUT);
    expect(s.rttMs).toBeCloseTo(6.567, 3);
    expect(s.lossRatio).toBe(0);
  });
});

describe('pingParse · Linux', () => {
  it('延迟与丢包', () => {
    const s = parsePingStats(LINUX_OUTPUT);
    expect(s.rttMs).toBeCloseTo(205.301, 3);
    expect(s.lossRatio).toBe(0);
  });
});

describe('pingParse · Windows 英文', () => {
  it('取 Average、解析 (0% loss)', () => {
    const s = parsePingStats(WIN_EN);
    expect(s.rttMs).toBe(1);
    expect(s.lossRatio).toBe(0);
  });
});

describe('pingParse · Windows 中文', () => {
  it('中文标签能解析', () => {
    const s = parsePingStats(WIN_CN);
    expect(s.rttMs).toBe(1);
    expect(s.lossRatio).toBe(0);
  });

  it('GBK 乱码也能解析（只锚定 ASCII 结构）', () => {
    const s = parsePingStats(WIN_CN_MOJIBAKE);
    expect(s.rttMs).toBe(1);
    expect(s.lossRatio).toBe(0);
  });
});

describe('pingParse · Windows 全部超时', () => {
  it('英文: 100% 丢包、无延迟', () => {
    const s = parsePingStats(WIN_TIMEOUT_EN);
    expect(s.rttMs).toBeNull();
    expect(s.lossRatio).toBe(1);
  });

  it('中文乱码: 100% 丢包（routerProbe 旧 bug 就死在这）', () => {
    // 旧代码: 正则失配 ⇒ packetLoss 兜底 0 ⇒ 不可达的目标显示"可达"
    const s = parsePingStats(WIN_TIMEOUT_CN);
    expect(s.lossRatio).toBe(1);
  });
});

describe('pingParse · 边界', () => {
  it('空输出 / 无法解析 → 双 null（调用方按"不可达"兜底）', () => {
    expect(parsePingStats('')).toEqual({ rttMs: null, lossRatio: null });
    expect(parsePingStats('完全无关的输出')).toEqual({ rttMs: null, lossRatio: null });
  });

  it('Windows <1ms 按 1 算', () => {
    expect(parsePingRtt('最短 = 0ms，最长 = 0ms，平均 = <1ms'.replace(/[\u4e00-\u9fff\uff0c]/g, '\ufffd'))).toBe(1);
  });

  it('单函数可用', () => {
    expect(parsePingLoss('0.0% packet loss')).toBe(0);
    expect(parsePingLoss('(33% loss)')).toBeCloseTo(0.33);
    expect(parsePingLoss('(100% \ufffd\ufffd\ufffd)')).toBe(1);
  });
});
