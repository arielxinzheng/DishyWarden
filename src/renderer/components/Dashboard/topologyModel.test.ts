import { describe, expect, it } from 'vitest';
import { buildTopology, type TopologyInputs } from './topologyModel';
import type { TelemetryData } from '../../../core/dishClient';
import type { RouterProbeResult } from '../../../core/routerProbeTypes';

/** 网关探测：默认「可信 + 可达 + 0 丢包」 */
const probe = (over: Partial<RouterProbeResult> = {}): RouterProbeResult => ({
  reachable: true,
  rttMs: 4.2,
  packetLoss: 0,
  httpOk: null,
  timestamp: Date.now(),
  trusted: true,
  ...over,
});

const telemetry = (over: Partial<TelemetryData> = {}): TelemetryData =>
  ({
    state: 'ONLINE',
    uptime: 3600,
    popPingLatencyMs: 32,
    popPingDropRate: 0,
    downlinkThroughputBps: 150e6,
    uplinkThroughputBps: 15e6,
    snr: 12,
    attitudeEstimationState: 'FILTER_CONVERGED',
    alignmentStats: { attitudeUncertaintyDeg: 0.4 },
    ...over,
  }) as TelemetryData;

const inputs = (over: Partial<TopologyInputs> = {}): TopologyInputs => ({
  telemetry: telemetry(),
  dishConnected: true,
  dishError: null,
  routerProbe: probe(),
  dnsProbe: null,
  alerts: [],
  ...over,
});

describe('链路 1：用户终端 → 本地路由器', () => {
  it('网关通畅 → 绿色', () => {
    const m = buildTopology(inputs());
    expect(m.links[0].tone).toBe('ok');
    expect(m.nodes[1].tone).toBe('ok');
    expect(m.nodes[1].metricText).toBe('网关 4.2 ms');
  });

  it('网关不可达 → 红色，并成为断点', () => {
    const m = buildTopology(inputs({ routerProbe: probe({ reachable: false, rttMs: null }) }));
    expect(m.links[0].tone).toBe('down');
    expect(m.rootCause?.linkId).toBe('lan');
    expect(m.verdict.headline).toContain('局域网');
  });

  it('高丢包（≥50%）判为断，轻度丢包（10%-50%）判为降级', () => {
    expect(buildTopology(inputs({ routerProbe: probe({ packetLoss: 0.6 }) })).links[0].tone).toBe('down');
    expect(buildTopology(inputs({ routerProbe: probe({ packetLoss: 0.2 }) })).links[0].tone).toBe('degraded');
  });

  it('探测不可信（VPN/隧道假应答）→ 灰，既不报红也不点绿灯', () => {
    const m = buildTopology(
      inputs({ routerProbe: probe({ trusted: false, trustNote: '疑似 VPN 环境' }) }),
    );
    expect(m.links[0].tone).toBe('unknown');
    expect(m.links[0].detail).toContain('VPN');
  });

  it('没有任何探测结果 → 灰（没证据 ≠ 正常）', () => {
    expect(buildTopology(inputs({ routerProbe: null })).links[0].tone).toBe('unknown');
  });
});

describe('链路 2：本地路由器 → 星链天线', () => {
  it('gRPC 在推数据 → 绿色', () => {
    expect(buildTopology(inputs()).links[1].tone).toBe('ok');
  });

  it('有遥测但停止推送（gRPC 断开）→ 红色', () => {
    const m = buildTopology(inputs({ dishConnected: false }));
    expect(m.links[1].tone).toBe('down');
    expect(m.rootCause?.linkId).toBe('grpc');
  });

  it('从没拿到遥测且有错误 → 红色；没有错误只是还没来 → 灰', () => {
    expect(
      buildTopology(inputs({ telemetry: null, dishConnected: false, dishError: 'connect ECONNREFUSED' }))
        .links[1].tone,
    ).toBe('down');
    expect(
      buildTopology(inputs({ telemetry: null, dishConnected: false, dishError: null })).links[1].tone,
    ).toBe('unknown');
  });
});

describe('链路 3：星链天线 → 互联网', () => {
  it('PoP 正常 → 绿色', () => {
    expect(buildTopology(inputs()).links[2].tone).toBe('ok');
  });

  it('PoP 100% 丢包 → 红色', () => {
    const m = buildTopology(inputs({ telemetry: telemetry({ popPingDropRate: 1 }) }));
    expect(m.links[2].tone).toBe('down');
    expect(m.rootCause?.linkId).toBe('wan');
  });

  it('天线在寻星/未锁定时判「测不出来」，而不是「公网挂了」', () => {
    const m = buildTopology(inputs({ telemetry: telemetry({ state: 'SEARCHING', popPingDropRate: 1 }) }));
    expect(m.links[2].tone).toBe('unknown');
    expect(m.links[2].detail).toContain('SEARCHING');
    expect(m.rootCause).toBeNull();
  });

  it('本机 DNS 挂了但基准解析器正常 → 降级，不是断链', () => {
    const m = buildTopology(
      inputs({ dnsProbe: { userOk: false, baselineOk: true, userError: 'SERVFAIL' } }),
    );
    expect(m.links[2].tone).toBe('degraded');
    expect(m.verdict.tone).toBe('degraded');
  });

  it('两路 DNS 全挂 → 红色', () => {
    const m = buildTopology(inputs({ dnsProbe: { userOk: false, baselineOk: false } }));
    expect(m.links[2].tone).toBe('down');
  });
});

describe('上下游传播与总判定', () => {
  it('上游断了，下游只显示「测不出来」，不跟着飘红', () => {
    const m = buildTopology(
      inputs({
        routerProbe: probe({ reachable: false, rttMs: null }),
        telemetry: null,
        dishConnected: false,
      }),
    );
    expect(m.links[0].tone).toBe('down');
    // 断点只有一处，下游两段都是「测不出来」
    expect(m.links.filter((l) => l.tone === 'down')).toHaveLength(1);
    expect(m.links[1].tone).toBe('unknown');
    expect(m.links[1].detail).toContain('上游');
    expect(m.links[2].tone).toBe('unknown');
    expect(m.rootCause?.linkId).toBe('lan');
    // 残留读数不展示（否则「采集中断」旁边挂着「误差 0.4°」会误导）
    expect(m.nodes[2].metricText).toBe('—');
    expect(m.nodes[3].metricText).toBe('—');
  });

  it('全绿时结论是「全链路正常」', () => {
    const m = buildTopology(inputs());
    expect(m.verdict.tone).toBe('ok');
    expect(m.verdict.headline).toBe('全链路正常');
  });

  it('全绿但仍有活跃告警时，结论里要点出告警数', () => {
    // 链路全绿（数据正常）但告警还在 —— 结论不能只说「正常」就完事
    const m = buildTopology(
      inputs({ alerts: [{ alertKey: 'high_latency', severity: 'warning', summary: '延迟偏高' }] }),
    );
    expect(m.verdict.tone).toBe('ok');
    expect(m.verdict.detail).toContain('1 条活跃告警');
    expect(m.alertTotal).toBe(1);
  });

  it('不参与拓扑着色的规则（如 WiFi 信号）不计入角标', () => {
    const m = buildTopology(
      inputs({ alerts: [{ alertKey: 'wifi_signal', severity: 'warning', summary: 'WiFi 信号弱' }] }),
    );
    expect(m.alertTotal).toBe(0);
    expect(m.verdict.detail).toBe('端到端链路通畅');
  });
});

describe('告警 → 链路 联动', () => {
  const alert = (alertKey: string) => ({
    alertKey,
    severity: 'critical' as const,
    summary: `${alertKey} 触发`,
  });

  it('路由器告警挂到局域网段', () => {
    const m = buildTopology(inputs({ alerts: [alert('router_offline')] }));
    expect(m.links[0].alerts.map((a) => a.alertKey)).toEqual(['router_offline']);
    expect(m.nodes[1].alerts).toHaveLength(1);
    expect(m.alertTotal).toBe(1);
  });

  it('天线/网线类告警挂到 gRPC 段', () => {
    const m = buildTopology(inputs({ alerts: [alert('cable_connectivity'), alert('dish_offline')] }));
    expect(m.links[1].alerts).toHaveLength(2);
    expect(m.links[0].alerts).toHaveLength(0);
  });

  it('公网质量类告警挂到 WAN 段', () => {
    const m = buildTopology(inputs({ alerts: [alert('high_latency'), alert('dns_failure')] }));
    expect(m.links[2].alerts).toHaveLength(2);
  });

  it('告警不改变颜色判据（颜色只由实测数据决定）', () => {
    const withAlert = buildTopology(inputs({ alerts: [alert('high_latency')] }));
    const without = buildTopology(inputs());
    expect(withAlert.links[2].tone).toBe(without.links[2].tone);
  });
});
