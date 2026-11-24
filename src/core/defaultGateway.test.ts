/**
 * 默认网关解析测试。
 *
 * 这些纯函数是「网关延迟整列空白」的首要嫌疑点：解析出来的 IP 若指向
 * 虚拟网卡，ping 会失败，而失败在采集侧过去是静默的。所以这里逐个平台
 * 用**真实命令输出**（含 CRLF、中文表头、On-link 行）做断言。
 */

import { describe, it, expect } from 'vitest';
import {
  parseNetstatGateway,
  parseIpRouteGateway,
  parseWindowsRouteGateway,
  localGatewayNode,
  LOCAL_GATEWAY_NODE_ID,
} from './defaultGateway';

/** Windows 命令输出一定是 CRLF —— 用 \r\n 拼，防止解析只兼容 \n */
const win = (...lines: string[]) => lines.join('\r\n');

describe('defaultGateway / Windows route print', () => {
  it('单条默认路由', () => {
    const output = win(
      '===========================================================================',
      'IPv4 路由表',
      '===========================================================================',
      '活动路由:',
      '网络目标        网络掩码          网关       接口   跃点数',
      '          0.0.0.0          0.0.0.0     192.168.100.1    192.168.100.123     25',
      '        127.0.0.0        255.0.0.0            在链路上         127.0.0.1    331',
    );
    expect(parseWindowsRouteGateway(output)).toBe('192.168.100.1');
  });

  it('多条默认路由时按跃点数取最小，而不是取第一条', () => {
    // 真机形态：虚拟机网卡排在前面且跃点数更大。
    // 旧实现取第一条 ⇒ ping 虚拟网卡 ⇒ 不通 ⇒ 指标静默为空。
    const output = win(
      '活动路由:',
      '网络目标        网络掩码          网关       接口   跃点数',
      '          0.0.0.0          0.0.0.0      10.0.2.2         10.0.2.15    281',
      '          0.0.0.0          0.0.0.0     192.168.100.1    192.168.100.123     25',
    );
    expect(parseWindowsRouteGateway(output)).toBe('192.168.100.1');
  });

  it('跳过 On-link（直连网段没有下一跳）', () => {
    const output = win(
      '          0.0.0.0          0.0.0.0      On-link          192.168.56.1    281',
      '          0.0.0.0          0.0.0.0     192.168.100.1    192.168.100.123     25',
    );
    expect(parseWindowsRouteGateway(output)).toBe('192.168.100.1');
  });

  it('只有 On-link 时应返回 null 而不是把 On-link 当网关', () => {
    const output = win('          0.0.0.0          0.0.0.0      On-link          192.168.56.1    281');
    expect(parseWindowsRouteGateway(output)).toBeNull();
  });

  it('英文表头同样是数据行优先', () => {
    const output = win(
      'Active Routes:',
      'Network Destination        Netmask          Gateway       Interface  Metric',
      '          0.0.0.0          0.0.0.0     192.168.100.1    192.168.100.123     25',
    );
    expect(parseWindowsRouteGateway(output)).toBe('192.168.100.1');
  });

  it('没有默认路由时返回 null', () => {
    const output = win(
      '活动路由:',
      '        127.0.0.0        255.0.0.0            在链路上         127.0.0.1    331',
      '      192.168.1.0    255.255.255.0            在链路上      192.168.1.5    281',
    );
    expect(parseWindowsRouteGateway(output)).toBeNull();
  });

  it('掩码不是 0.0.0.0 的行不算默认路由', () => {
    const output = win('          0.0.0.0    255.0.0.0     192.168.100.1    192.168.100.123     25');
    expect(parseWindowsRouteGateway(output)).toBeNull();
  });
});

describe('defaultGateway / macOS & Linux', () => {
  it('macOS netstat -rn', () => {
    const output = win(
      'Routing tables',
      '',
      'Internet:',
      'Destination        Gateway            Flags        Netif Expire',
      'default            192.168.100.1      UGSc           en0',
      '127                127.0.0.1          UCS            lo0',
    );
    expect(parseNetstatGateway(output)).toBe('192.168.100.1');
  });

  it('Linux netstat -rn', () => {
    const output = win(
      'Kernel IP routing table',
      'Destination     Gateway         Genmask         Flags   MSS Window  irtt Iface',
      '0.0.0.0         192.168.100.1   0.0.0.0         UG        0 0          0 eth0',
    );
    expect(parseNetstatGateway(output)).toBe('192.168.100.1');
  });

  it('Linux ip route', () => {
    expect(
      parseIpRouteGateway('default via 192.168.100.1 dev eth0 proto dhcp metric 100'),
    ).toBe('192.168.100.1');
  });

  it('没有默认路由时两边都返回 null', () => {
    expect(parseNetstatGateway('Internet:\n127 127.0.0.1 UCS lo0')).toBeNull();
    expect(parseIpRouteGateway('192.168.1.0/24 dev eth0 scope link')).toBeNull();
  });
});

describe('defaultGateway / 节点约定', () => {
  it('target 留空 —— 由 probeRunner 每轮从路由表解析', () => {
    // 刻意不给兜底 IP：猜错的 IP 会让「解析失败」伪装成「网关不通」
    expect(localGatewayNode().target).toBe('');
    expect(localGatewayNode().id).toBe(LOCAL_GATEWAY_NODE_ID);
    expect(localGatewayNode().type).toBe('icmp');
  });

  it('超时可透传', () => {
    expect(localGatewayNode(9).timeoutSec).toBe(9);
    expect(localGatewayNode().timeoutSec).toBe(5);
  });
});