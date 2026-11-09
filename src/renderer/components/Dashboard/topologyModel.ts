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
 * ## i18n 约定（重要）
 *
 * 本文件**不产出任何用户可见文案**，只产出**语义码**：
 *   - 颜色：`TopologyTone`
 *   - 文字：`TopologyMessage` = 字典键 + i18n 插值参数，由渲染层（TopologyChain）
 *     用 `t()` 翻译。
 *   - 结论：`TopologyVerdictHeadline` 语义枚举，具体句子由渲染层按语言拼。
 * 这样单测不用被界面语言绑架，翻译集中在视图层一处。
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

/**
 * 一条待翻译的消息：`dashboard:` 命名空间下的字典键 + 插值参数。
 *
 * ⚠️ 参数必须与字典模板里的 `{{var}}` 一一对应，否则页面上会残留
 * `{{rate}}` 这种原文 —— 这是最严重的一类显示缺陷。
 */
export interface TopologyMessage {
  key: string;
  params?: Record<string, string | number>;
}

/** 挂到链路上的活跃告警（只取展示需要的字段） */
export interface TopologyAlertRef {
  alertKey: string;
  severity: 'critical' | 'warning' | 'info';
  summary: string;
}

export interface TopologyLinkState {
  id: TopologyLinkId;
  tone: TopologyTone;
  /** 为什么是这个颜色 —— 悬停可见（渲染层翻译） */
  detail: TopologyMessage;
  alerts: TopologyAlertRef[];
}

export interface TopologyNodeState {
  id: TopologyNodeId;
  tone: TopologyTone;
  /** 状态行：在线 · 已对准（渲染层翻译） */
  status: TopologyMessage;
  /**
   * 实测小字：网关 4.2 ms（渲染层翻译）。
   * `null` = 没有可信读数（判据不允许摆残留数据时），渲染层显示占位符。
   */
  metric: TopologyMessage | null;
  /** 一句话解释（悬停可见）—— 去掉全局标题栏后，理由必须就近挂在节点上 */
  detail: TopologyMessage;
  alerts: TopologyAlertRef[];
}

/**
 * 结论的**语义枚举**（不是句子）。
 *
 * `down` / `degraded` 带 `linkId`，渲染层据此把链路名插进本地化模板：
 * 「链路中断 · {{link}}」。
 */
export type TopologyVerdictHeadline =
  | { kind: 'down'; linkId: TopologyLinkId }
  | { kind: 'degraded'; linkId: TopologyLinkId }
  | { kind: 'unknown' }
  | { kind: 'ok' };

export interface TopologyVerdict {
  tone: TopologyTone;
  headline: TopologyVerdictHeadline;
  detail: TopologyMessage;
}

export interface TopologyModel {
  nodes: TopologyNodeState[];
  links: TopologyLinkState[];
  verdict: TopologyVerdict;
  /** 第一个断点；全绿时为 null */
  rootCause: { linkId: TopologyLinkId; reason: TopologyMessage } | null;
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

/** 比率 → 百分比数字字符串（模板里再补 `%`，避免小数点噪声） */
const ratePct = (v: number) => (v * 100).toFixed(0);

/** 链路 1：用户终端 → 本地路由器（本地网关 ICMP 探针） */
function judgeLan(probe: RouterProbeResult | null): { tone: TopologyTone; detail: TopologyMessage } {
  if (!probe) {
    return { tone: 'unknown', detail: { key: 'topology.lan_no_probe' } };
  }

  // 探测不可信时不能报警也不能报平安 —— VPN/隧道会把任何 ICMP 都回掉
  if (probe.trusted === false) {
    return { tone: 'unknown', detail: { key: 'topology.lan_untrusted' } };
  }

  if (!probe.reachable) {
    return { tone: 'down', detail: { key: 'topology.lan_unreachable' } };
  }
  if (probe.packetLoss >= 0.5) {
    return {
      tone: 'down',
      detail: { key: 'topology.lan_packet_loss', params: { rate: ratePct(probe.packetLoss) } },
    };
  }
  if (probe.packetLoss >= 0.1) {
    return {
      tone: 'degraded',
      detail: { key: 'topology.lan_packet_loss', params: { rate: ratePct(probe.packetLoss) } },
    };
  }

  return {
    tone: 'ok',
    detail: { key: 'topology.lan_ok', params: { rate: ratePct(probe.packetLoss) } },
  };
}

/** 链路 2：本地路由器 → 星链天线（gRPC 采集链路是否在推数据） */
function judgeGrpc(
  inputs: TopologyInputs,
  upstreamBroken: boolean,
): { tone: TopologyTone; detail: TopologyMessage } {
  // 局域网都断了，这一段必然是「测不出来」——不能因为手上有残留的旧遥测就点绿灯
  if (upstreamBroken) {
    // 因果必须写清楚：只说「未知」等于把问题丢回给用户
    return { tone: 'unknown', detail: { key: 'topology.grpc_upstream' } };
  }

  if (!inputs.telemetry) {
    return {
      tone: inputs.dishError ? 'down' : 'unknown',
      detail: inputs.dishError
        ? { key: 'topology.grpc_collect_error', params: { error: inputs.dishError } }
        : { key: 'topology.grpc_no_telemetry' },
    };
  }

  if (!inputs.dishConnected) {
    // 有上一帧数据但当前不推了 —— 典型是 gRPC 断开（天线掉电/网线松/地址变了）
    return { tone: 'down', detail: { key: 'topology.grpc_interrupted' } };
  }

  return { tone: 'ok', detail: { key: 'topology.grpc_ok' } };
}

/** 链路 3：星链天线 → 互联网/公网（PoP 链路 + DNS 解析） */
function judgeWan(
  inputs: TopologyInputs,
  upstreamBroken: boolean,
): { tone: TopologyTone; detail: TopologyMessage } {
  if (upstreamBroken) {
    // 上游已经断了，这一段「测不出来」，不是「也坏了」
    return { tone: 'unknown', detail: { key: 'topology.wan_upstream' } };
  }

  const t = inputs.telemetry;
  if (!t) return { tone: 'unknown', detail: { key: 'topology.wan_no_telemetry' } };

  // 天线自己没锁上（开机/寻星/收起）时，公网测不通是**结果**不是**原因**
  if (t.state !== 'ONLINE') {
    return {
      tone: 'unknown',
      detail: { key: 'topology.wan_dish_not_locked', params: { state: t.state } },
    };
  }

  const drop = t.popPingDropRate ?? 0;
  const rtt = t.popPingLatencyMs ?? 0;

  if (drop >= 0.99 || rtt <= 0) {
    return { tone: 'down', detail: { key: 'topology.wan_down' } };
  }

  // DNS 是「通不通」之外的独立故障域：链路能通但解析挂了，属于降级不是断链
  const dns = inputs.dnsProbe;
  if (dns) {
    if (!dns.userOk && !dns.baselineOk) {
      return { tone: 'down', detail: { key: 'topology.wan_dns_both_failed' } };
    }
    if (!dns.userOk && dns.baselineOk) {
      return {
        tone: 'degraded',
        detail: dns.userError
          ? { key: 'topology.wan_dns_user_failed', params: { error: dns.userError } }
          : { key: 'topology.wan_dns_user_only' },
      };
    }
  }

  if (drop >= 0.1) {
    return {
      tone: 'degraded',
      detail: { key: 'topology.wan_packet_loss', params: { rate: ratePct(drop) } },
    };
  }

  return {
    tone: 'ok',
    detail: { key: 'topology.wan_ok', params: { rtt: rtt.toFixed(0) } },
  };
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
    { id: 'lan', tone: lan.tone, detail: lan.detail, alerts: alertsFor(inputs.alerts, 'lan') },
    { id: 'grpc', tone: grpc.tone, detail: grpc.detail, alerts: alertsFor(inputs.alerts, 'grpc') },
    {
      id: 'wan',
      tone: wan.tone,
      detail:
        wan.tone === 'unknown' && (lanBroken || grpcBroken)
          ? { key: 'topology.upstream_node_unreachable' }
          : wan.detail,
      alerts: alertsFor(inputs.alerts, 'wan'),
    },
  ];

  const t = inputs.telemetry;
  const probe = inputs.routerProbe;

  const nodes: TopologyNodeState[] = [
    {
      id: 'pc',
      // 本机永远在线（页面都打开了），它没有独立探针
      tone: 'ok',
      status: { key: 'topology.pc_status' },
      metric: { key: 'topology.pc_metric' },
      detail: { key: 'topology.pc_detail' },
      alerts: [],
    },
    {
      id: 'router',
      tone: lan.tone,
      status: {
        key:
          lan.tone === 'down'
            ? 'topology.router_down'
            : lan.tone === 'unknown'
              ? 'topology.router_unknown'
              : lan.tone === 'degraded'
                ? 'topology.router_degraded'
                : 'topology.router_ok',
      },
      // 探测不可信时不要把假 RTT 摆出来 —— 「状态未知 + 网关 0.1ms」自相矛盾
      metric:
        probe == null || probe.trusted === false
          ? { key: 'topology.router_metric_na' }
          : probe.rttMs != null
            ? { key: 'topology.router_metric', params: { rtt: probe.rttMs.toFixed(1) } }
            : { key: 'topology.router_metric_na' },
      detail: lan.detail,
      alerts: links[0].alerts,
    },
    {
      id: 'dish',
      tone: lanBroken ? 'unknown' : grpc.tone,
      status: {
        key: lanBroken
          ? 'topology.dish_pending'
          : grpcBroken
            ? 'topology.dish_grpc_down'
            : t
              ? t.state === 'ONLINE'
                ? 'topology.dish_online'
                : 'topology.dish_state'
              : 'topology.dish_unknown',
        params: lanBroken || grpcBroken
          ? undefined
          : t && t.state !== 'ONLINE'
            ? { state: t.state }
            : undefined,
      },
      // 判不出来时不要摆残留读数：旧遥测的「误差 0.4°」会让用户以为天线还在正常工作
      metric:
        lanBroken || grpcBroken
          ? null
          : t?.attitudeEstimationState === 'FILTER_CONVERGED'
            ? {
                key: 'topology.dish_metric_uncertainty',
                params: { value: (t.alignmentStats?.attitudeUncertaintyDeg ?? 0).toFixed(1) },
              }
            : t
              ? { key: 'topology.dish_not_converged' }
              : { key: 'topology.dish_metric_na' },
      detail: lanBroken ? { key: 'topology.dish_upstream_detail' } : grpc.detail,
      alerts: links[1].alerts,
    },
    {
      id: 'internet',
      tone: wan.tone,
      status: {
        key:
          wan.tone === 'down'
            ? 'topology.internet_down'
            : wan.tone === 'unknown'
              ? 'topology.internet_pending'
              : wan.tone === 'degraded'
                ? 'topology.internet_degraded'
                : 'topology.internet_ok',
      },
      metric:
        wan.tone === 'unknown' || !(t && t.state === 'ONLINE')
          ? null
          : {
              key: 'topology.internet_metric',
              params: {
                rtt: (t.popPingLatencyMs ?? 0).toFixed(0),
                rate: ratePct(t.popPingDropRate ?? 0),
              },
            },
      detail:
        wan.tone === 'unknown' && (lanBroken || grpcBroken)
          ? { key: 'topology.upstream_node_unreachable' }
          : wan.detail,
      alerts: links[2].alerts,
    },
  ];

  const alertTotal = links.reduce((n, l) => n + l.alerts.length, 0);
  const firstDown = links.find((l) => l.tone === 'down') ?? null;

  return {
    nodes,
    links,
    verdict: judgeVerdict(links, alertTotal),
    rootCause: firstDown ? { linkId: firstDown.id, reason: firstDown.detail } : null,
    alertTotal,
  };
}

/** 一句话结论：先说断没断，再说断在哪，最后才是降级/未知 */
function judgeVerdict(links: TopologyLinkState[], alertTotal: number): TopologyVerdict {
  const down = links.find((l) => l.tone === 'down');
  if (down) {
    return {
      tone: 'down',
      headline: { kind: 'down', linkId: down.id },
      detail: down.detail,
    };
  }

  const degraded = links.find((l) => l.tone === 'degraded');
  if (degraded) {
    return {
      tone: 'degraded',
      headline: { kind: 'degraded', linkId: degraded.id },
      detail: degraded.detail,
    };
  }

  const unknown = links.find((l) => l.tone === 'unknown');
  if (unknown) {
    return {
      tone: 'unknown',
      headline: { kind: 'unknown' },
      detail: unknown.detail,
    };
  }

  return {
    tone: 'ok',
    headline: { kind: 'ok' },
    detail:
      alertTotal > 0
        ? { key: 'topology.verdict_ok_alerts', params: { count: alertTotal } }
        : { key: 'topology.verdict_ok_detail' },
  };
}
