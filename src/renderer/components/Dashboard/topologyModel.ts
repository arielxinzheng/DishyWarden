/**
 * 全链路拓扑状态的**纯逻辑层**。
 *
 * ┌──────────┐   LAN   ┌────────┐  gRPC   ┌──────────┐   WAN   ┌──────────┐
 * │ 用户终端  │ ──────▶ │ 本地路由 │ ──────▶ │ 星链天线  │ ─────▶ │ 互联网/公网│
 * └──────────┘         └────────┘         └──────────┘         └──────────┘
 *
 * ## 为什么要单独一层
 *
 * 「这条链路到底算不算断」是**判据**，不是像素。判据必须可单测、可复用
 * （将来 Prometheus 也想导出 `starlink_topology_link_up{link=...}`）。
 * 组件只负责把结果画出来。
 *
 * ## 判据的总原则
 *
 * 1. **没有证据 ≠ 正常**。拿不到探测结果、或探测本身不可信（VPN/隧道会应答
 *    所有 ICMP，见 `routerProbeShape.ts` 的说明），一律 `unknown`（灰），
 *    绝不因为「没报错」就点亮绿灯 —— 监控软件给假绿灯比给灰灯恶劣得多。
 * 2. **只认第一个断点**。上游断了，下游不是「也坏了」，而是「测不出来」。
 *    否则一次路由器掉线会让 3 条链路全红，用户根本不知道该修哪。
 * 3. **告警是证据，不是装饰**。活跃告警会被挂到对应链路上显示，
 *    但**颜色仍由实测数据决定**：告警可能刚 resolve，而探测已经恢复。
 */

import type { TelemetryData } from '../../../core/dishClient';
import type { RouterProbeResult } from '../../../core/routerProbeTypes';

export type TopologyTone = 'ok' | 'degraded' | 'down' | 'unknown';

export type TopologyLinkId = 'lan' | 'grpc' | 'wan';
export type TopologyNodeId = 'pc' | 'router' | 'dish' | 'internet';

/** 挂到链路上的活跃告警（只取展示需要的字段） */
export interface TopologyAlertRef {
  alertKey: string;
  severity: 'critical' | 'warning' | 'info';
  summary: string;
}

export interface TopologyLinkState {
  id: TopologyLinkId;
  /** 连线上的短标签：局域网 / gRPC 9200 / PoP 出口 */
  label: string;
  tone: TopologyTone;
  /** 为什么是这个颜色 —— 悬停可见 */
  detail: string;
  alerts: TopologyAlertRef[];
}

export interface TopologyNodeState {
  id: TopologyNodeId;
  title: string;
  tone: TopologyTone;
  /** 状态行：在线 · 已对准 */
  statusText: string;
  /** 实测小字：网关 4.2 ms */
  metricText: string;
  /** 一句话解释（悬停可见）—— 去掉全局标题栏后，理由必须就近挂在节点上 */
  detail: string;
  alerts: TopologyAlertRef[];
}

export interface TopologyModel {
  nodes: TopologyNodeState[];
  links: TopologyLinkState[];
  verdict: { tone: TopologyTone; headline: string; detail: string };
  /** 第一个断点；全绿时为 null */
  rootCause: { linkId: TopologyLinkId; label: string; reason: string } | null;
  /** 本次判定依赖到的活跃告警条数（用于右上角角标） */
  alertTotal: number;
}

export interface DnsProbeSnapshot {
  /** 本机系统解析器是否解析成功 */
  userOk: boolean;
  /** 基准解析器（8.8.8.8）是否解析成功 */
  baselineOk: boolean;
  userError?: string;
}

export interface TopologyInputs {
  telemetry: TelemetryData | null;
  /** 采集链路是否在持续推数据（useDish.isConnected） */
  dishConnected: boolean;
  dishError: string | null;
  routerProbe: RouterProbeResult | null;
  dnsProbe: DnsProbeSnapshot | null;
  /** 当前活跃告警（Dashboard 的 activeAlerts） */
  alerts: TopologyAlertRef[];
}

/* ------------------------------------------------------------------ */
/* 告警 → 链路 的归属                                                  */
/* ------------------------------------------------------------------ */

/**
 * 告警规则到链路的静态归属。
 *
 * 没列出的规则（如 `wifi_signal`、`gnss_positioning`）不参与拓扑着色 ——
 * 强行归类会让用户以为「WiFi 信号弱 = 网线断了」。
 */
const ALERT_LINK_MAP: Record<string, TopologyLinkId> = {
  // 局域网段
  router_offline: 'lan',

  // 路由器 → 天线：供电/网线/电机/采集器心跳
  cable_connectivity: 'grpc',
  dish_offline: 'grpc',
  motors_stowed: 'grpc',
  poe_power: 'grpc',
  collector_heartbeat_lost: 'grpc',
  alignment_issue: 'grpc',

  // 天线 → 公网：信号质量、遮挡、服务状态、DNS
  high_latency: 'wan',
  high_packet_loss: 'wan',
  low_throughput: 'wan',
  low_snr: 'wan',
  obstruction_detected: 'wan',
  severe_weather: 'wan',
  dns_failure: 'wan',
  frequent_searching: 'wan',
  service_restricted: 'wan',
  account_suspended: 'wan',
  service_not_activated: 'wan',
  location_policy_violation: 'wan',
  roaming: 'wan',
};

function alertsFor(alerts: TopologyAlertRef[], linkId: TopologyLinkId): TopologyAlertRef[] {
  return alerts.filter((a) => ALERT_LINK_MAP[a.alertKey] === linkId);
}

/* ------------------------------------------------------------------ */
/* 各段判定                                                            */
/* ------------------------------------------------------------------ */

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

/** 链路 1：用户终端 → 本地路由器（本地网关 ICMP 探针） */
function judgeLan(probe: RouterProbeResult | null): { tone: TopologyTone; detail: string } {
  if (!probe) return { tone: 'unknown', detail: '尚未拿到网关探测结果' };

  // 探测不可信时不能报警也不能报平安 —— VPN/隧道会把任何 ICMP 都回掉
  if (probe.trusted === false) {
    return { tone: 'unknown', detail: probe.trustNote ?? '探测结果不可信（VPN/隧道/安全软件干扰）' };
  }

  if (!probe.reachable) return { tone: 'down', detail: '网关不可达：ICMP 无响应' };
  if (probe.packetLoss >= 0.5) return { tone: 'down', detail: `网关丢包 ${pct(probe.packetLoss)}` };
  if (probe.packetLoss >= 0.1) return { tone: 'degraded', detail: `网关丢包 ${pct(probe.packetLoss)}` };

  return { tone: 'ok', detail: `网关可达 · 丢包 ${pct(probe.packetLoss)}` };
}

/** 链路 2：本地路由器 → 星链天线（gRPC 采集链路是否在推数据） */
function judgeGrpc(
  inputs: TopologyInputs,
  upstreamBroken: boolean,
): { tone: TopologyTone; detail: string } {
  // 局域网都断了，这一段必然是「测不出来」——不能因为手上有残留的旧遥测就点绿灯
  if (upstreamBroken) return { tone: 'unknown', detail: '上游（局域网）中断，无法判定' };

  if (!inputs.telemetry) {
    return {
      tone: inputs.dishError ? 'down' : 'unknown',
      detail: inputs.dishError ? `gRPC 采集失败：${inputs.dishError}` : '尚未收到遥测数据',
    };
  }

  if (!inputs.dishConnected) {
    // 有上一帧数据但当前不推了 —— 典型是 gRPC 断开（天线掉电/网线松/地址变了）
    return { tone: 'down', detail: 'gRPC 采集中断：天线无响应（检查网线/供电/地址）' };
  }

  return { tone: 'ok', detail: 'gRPC 正常，天线在持续上报遥测' };
}

/** 链路 3：星链天线 → 互联网/公网（PoP 链路 + DNS 解析） */
function judgeWan(
  inputs: TopologyInputs,
  upstreamBroken: boolean,
): { tone: TopologyTone; detail: string } {
  if (upstreamBroken) {
    // 上游已经断了，这一段「测不出来」，不是「也坏了」
    return { tone: 'unknown', detail: '上游链中断，无法判定' };
  }

  const t = inputs.telemetry;
  if (!t) return { tone: 'unknown', detail: '尚未收到遥测数据' };

  // 天线自己没锁上（开机/寻星/收起）时，公网测不通是**结果**不是**原因**
  if (t.state !== 'ONLINE') {
    return { tone: 'unknown', detail: `天线未锁定（状态 ${t.state}），公网暂不可用` };
  }

  const drop = t.popPingDropRate ?? 0;
  const rtt = t.popPingLatencyMs ?? 0;

  if (drop >= 0.99 || rtt <= 0) return { tone: 'down', detail: 'PoP 链路不通：100% 丢包或无延迟数据' };

  // DNS 是「通不通」之外的独立故障域：链路能通但解析挂了，属于降级不是断链
  const dns = inputs.dnsProbe;
  if (dns) {
    if (!dns.userOk && !dns.baselineOk) return { tone: 'down', detail: 'DNS 双轨解析均失败' };
    if (!dns.userOk && dns.baselineOk) {
      return {
        tone: 'degraded',
        detail: dns.userError ? `本机 DNS 解析失败：${dns.userError}` : '本机 DNS 解析失败（基准解析器正常）',
      };
    }
  }

  if (drop >= 0.1) return { tone: 'degraded', detail: `PoP 丢包 ${pct(drop)}` };

  return { tone: 'ok', detail: `公网可达 · 延迟 ${rtt.toFixed(0)} ms` };
}

/* ------------------------------------------------------------------ */
/* 汇总                                                               */
/* ------------------------------------------------------------------ */

/**
 * 把遥测 + 探针 + 告警汇总成一条拓扑。
 *
 * 节点颜色 = 它**前面那条链路**的颜色（链路断了，节点自然不可用）；
 * 链路断开后，其后的节点一律 `unknown`（灰），避免一次故障满屏飘红。
 */
export function buildTopology(inputs: TopologyInputs): TopologyModel {
  const lan = judgeLan(inputs.routerProbe);
  const lanBroken = lan.tone === 'down';

  // 上游中断必须传进去：否则下游会拿残留遥测点亮绿灯，出现「上游红 ✕ + 下游绿箭头」
  const grpc = judgeGrpc(inputs, lanBroken);
  const grpcBroken = grpc.tone === 'down' || grpc.tone === 'unknown';
  const wan = judgeWan(inputs, grpcBroken || lanBroken);

  const links: TopologyLinkState[] = [
    {
      id: 'lan',
      label: '局域网',
      tone: lan.tone,
      detail: lan.detail,
      alerts: alertsFor(inputs.alerts, 'lan'),
    },
    {
      id: 'grpc',
      label: 'gRPC 9200',
      tone: grpc.tone,
      detail: grpc.detail,
      alerts: alertsFor(inputs.alerts, 'grpc'),
    },
    {
      id: 'wan',
      label: 'PoP 出口',
      tone: wan.tone,
      detail: wan.detail,
      alerts: alertsFor(inputs.alerts, 'wan'),
    },
  ];

  const t = inputs.telemetry;
  const probe = inputs.routerProbe;

  const nodes: TopologyNodeState[] = [
    {
      id: 'pc',
      title: '用户终端',
      // 本机永远在线（页面都打开了），它没有独立探针
      tone: 'ok',
      statusText: '在线 · 本机',
      metricText: '本机运行中',
      detail: '本机页面正在运行，无独立探针',
      alerts: [],
    },
    {
      id: 'router',
      title: '本地路由器',
      tone: lan.tone,
      statusText:
        lan.tone === 'down'
          ? '不可达'
          : lan.tone === 'unknown'
            ? '状态未知'
            : lan.tone === 'degraded'
              ? '丢包偏高'
              : '响应正常',
      // 探测不可信时不要把假 RTT 摆出来 —— 「状态未知 + 网关 0.1ms」自相矛盾
      metricText:
        probe == null || probe.trusted === false
          ? '网关 —'
          : probe.rttMs != null
            ? `网关 ${probe.rttMs.toFixed(1)} ms`
            : '网关 —',
      detail: lan.detail,
      alerts: links[0].alerts,
    },
    {
      id: 'dish',
      title: '星链天线 Dishy',
      tone: lanBroken ? 'unknown' : grpc.tone,
      statusText: lanBroken
        ? '待判定'
        : grpcBroken
        ? '采集中断'
        : t
          ? t.state === 'ONLINE'
            ? '在线 · 已对准'
            : `在线 · ${t.state}`
          : '状态未知',
      // 判不出来时不要摆残留读数：旧遥测的「误差 0.4°」会让用户以为天线还在正常工作
      metricText:
        lanBroken || grpcBroken
          ? '—'
          : t?.attitudeEstimationState === 'FILTER_CONVERGED'
            ? `误差 ${(t.alignmentStats?.attitudeUncertaintyDeg ?? 0).toFixed(1)}°`
            : t
              ? '姿态未收敛'
              : '遥测 —',
      detail: grpc.detail,
      alerts: links[1].alerts,
    },
    {
      id: 'internet',
      title: '互联网 / 公网',
      tone: wan.tone,
      statusText:
        wan.tone === 'down'
          ? '不可达'
          : wan.tone === 'unknown'
            ? '待判定'
            : wan.tone === 'degraded'
              ? '质量降级'
              : '可达',
      metricText:
        wan.tone === 'unknown'
          ? '—'
          : t && t.state === 'ONLINE'
            ? `${(t.popPingLatencyMs ?? 0).toFixed(0)} ms · 丢包 ${pct(t.popPingDropRate ?? 0)}`
            : '—',
      detail: wan.detail,
      alerts: links[2].alerts,
    },
  ];

  const alertTotal = links.reduce((n, l) => n + l.alerts.length, 0);
  const firstDown = links.find((l) => l.tone === 'down') ?? null;

  return {
    nodes,
    links,
    verdict: judgeVerdict(links, alertTotal),
    rootCause: firstDown
      ? { linkId: firstDown.id, label: firstDown.label, reason: firstDown.detail }
      : null,
    alertTotal,
  };
}

/** 一句话结论：先说断没断，再说断在哪，最后才是降级/未知 */
function judgeVerdict(
  links: TopologyLinkState[],
  alertTotal: number,
): TopologyModel['verdict'] {
  const down = links.find((l) => l.tone === 'down');
  if (down) {
    return {
      tone: 'down',
      headline: `链路中断 · ${down.label}`,
      detail: down.detail,
    };
  }

  const degraded = links.find((l) => l.tone === 'degraded');
  if (degraded) {
    return {
      tone: 'degraded',
      headline: `链路降级 · ${degraded.label}`,
      detail: degraded.detail,
    };
  }

  const unknown = links.find((l) => l.tone === 'unknown');
  if (unknown) {
    return {
      tone: 'unknown',
      headline: '部分链路不可判定',
      detail: unknown.detail,
    };
  }

  return {
    tone: 'ok',
    headline: '全链路正常',
    detail: alertTotal > 0 ? `仍有 ${alertTotal} 条活跃告警需要关注` : '端到端链路通畅',
  };
}
