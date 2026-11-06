/**
 * 全链路拓扑状态链 —— 仪表盘的「视觉锚点」。
 *
 * 位置：全局状态条（5 块 overview band）之下、折线图卡之上。
 *
 * ## 无容器、无标题（视觉降级）
 *
 * 早期版本外面套了一个带边框/渐变/网格的卡片，顶部还有一行
 * 「🛰️ 全链路状态 · 端到端拓扑」+ 右侧全局结论标签。问题有两个：
 *
 *   1. 首屏空间被吃掉：标题栏 + 内边距 ≈ 60px，只为说一句图里已经写明的事；
 *   2. 「图形自明性」被破坏：四个节点 + 三条连线本身就在表达拓扑，
 *      再顶一个大标题等于给折线图加一句「这是一张折线图」。
 *
 * 现在节点直接裸露在页面背景上，只用上下 margin 呼吸。
 * 结论不再全局显示，而是**就近**挂在出问题的那一处：
 *   - 断链 → 连线变红虚线 + ✕，节点状态写「不可达」
 *   - 测不出来 → 连线中央/节点图标角落出现微型 `?`，悬停给解释
 *
 * ## 两个颜色通道
 *
 *   图标 = 身份色（终端蓝 / 路由绿 / 天线银白 / 公网蓝），恒定，负责辨识度
 *   卡片底色 + 边框 + 状态点 + 状态文字 = 状态色，负责告警
 *
 * ## 分工
 *
 *   topologyModel.ts   纯判据（哪种情况算断、算降级、算测不出来）
 *   本文件             取数 + 画图（不参与任何判定）
 */

import { useEffect, useMemo, useState } from 'react';
import { useDish } from '../../hooks/useDish';
import { isValidProbe } from './routerProbeShape';
import type { RouterProbeResult } from '../../../core/routerProbeTypes';
import {
  buildTopology,
  type DnsProbeSnapshot,
  type TopologyAlertRef,
  type TopologyLinkState,
  type TopologyNodeId,
  type TopologyNodeState,
  type TopologyTone,
} from './topologyModel';

/** 仪表盘活跃告警的最小形态（AlertRecord 的子集） */
export interface TopologyAlertInput {
  alert_key: string;
  severity: string;
  summary: string;
  status?: string;
}

export interface TopologyChainProps {
  /** 活跃告警；有值时会挂到对应链路上并显示角标 */
  alerts?: TopologyAlertInput[];
  /** 点击角标/链路时的动作（通常是打开告警抽屉） */
  onOpenAlerts?: () => void;
}

/**
 * 节点「身份配色」—— 图标颜色**不随健康状态变化**。
 *
 * 两个颜色通道分工：
 *   图标 = 这是谁（终端/路由器/天线/公网），恒定，负责辨识度
 *   卡片底色 + 边框 + 状态点 + 状态文字 = 现在好不好，负责告警
 *
 * 若让图标跟着状态变色，一条健康链路的四个图标会变成同一个绿，
 * 节点之间失去辨识度，整块看起来像一排绿点。
 */
const NODE_IDENTITY: Record<TopologyNodeId, { stroke: string; accent: string; tint: string }> = {
  pc: { stroke: '#38bdf8', accent: '#7dd3fc', tint: 'rgba(56,189,248,.12)' },
  router: { stroke: '#34d399', accent: '#6ee7b7', tint: 'rgba(52,211,153,.12)' },
  dish: { stroke: '#e2e8f0', accent: '#38bdf8', tint: 'rgba(226,232,240,.10)' },
  internet: { stroke: '#60a5fa', accent: '#93c5fd', tint: 'rgba(96,165,250,.12)' },
};

const TONE_TEXT: Record<TopologyTone, string> = {
  ok: 'text-accent-green',
  degraded: 'text-warning-orange',
  down: 'text-danger-red',
  unknown: 'text-muted-foreground',
};

const TONE_TILE_BORDER: Record<TopologyTone, string> = {
  ok: 'border-border/60',
  degraded: 'border-warning-orange/45',
  down: 'border-danger-red/55',
  unknown: 'border-border/60',
};

const TONE_LINE: Record<TopologyTone, string> = {
  ok: 'bg-gradient-to-r from-accent-green/40 to-accent-green',
  degraded: 'bg-gradient-to-r from-warning-orange/40 to-warning-orange',
  down: 'bg-danger-red/70',
  unknown: 'bg-border',
};

const TONE_DOT: Record<TopologyTone, string> = {
  ok: 'bg-accent-green',
  degraded: 'bg-warning-orange',
  down: 'bg-danger-red',
  unknown: 'bg-muted-foreground',
};

/** 探针轮询间隔：与采集周期对齐 */
const PROBE_INTERVAL_MS = 30_000;

/**
 * 拉取两条非遥测探针（网关 ICMP / DNS 双轨）。
 *
 * 浏览器环境没有 electronAPI —— 此时保持 null，拓扑会如实显示「不可判定」，
 * 而不是拿 mock 假装一切正常。
 */
function useProbeSnapshot() {
  const [routerProbe, setRouterProbe] = useState<RouterProbeResult | null>(null);
  const [dnsProbe, setDnsProbe] = useState<DnsProbeSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
      if (!api) return;

      try {
        const raw = await api.getRouterProbe?.();
        // IPC 返回值的类型只在编译期存在，运行时必须校验（见 routerProbeShape.ts）
        if (!cancelled) setRouterProbe(isValidProbe(raw) ? raw : null);
      } catch {
        if (!cancelled) setRouterProbe(null);
      }

      try {
        const dns = await api.getLatestDnsProbe?.();
        if (!cancelled) {
          setDnsProbe(
            dns
              ? {
                  userOk: dns.user_dns?.ok === true,
                  baselineOk: dns.baseline_dns?.ok === true,
                  userError: dns.user_dns?.error,
                }
              : null,
          );
        }
      } catch {
        if (!cancelled) setDnsProbe(null);
      }
    };

    load();
    const timer = setInterval(load, PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return { routerProbe, dnsProbe };
}

export function TopologyChain({ alerts = [], onOpenAlerts }: TopologyChainProps) {
  const { telemetry, isConnected, error } = useDish();
  const { routerProbe, dnsProbe } = useProbeSnapshot();

  const alertRefs: TopologyAlertRef[] = useMemo(
    () =>
      alerts
        .filter((a) => !a.status || a.status === 'new' || a.status === 'ongoing')
        .map((a) => ({
          alertKey: a.alert_key,
          severity: (['critical', 'warning', 'info'].includes(a.severity)
            ? a.severity
            : 'info') as TopologyAlertRef['severity'],
          summary: a.summary,
        })),
    [alerts],
  );

  const model = useMemo(
    () =>
      buildTopology({
        telemetry,
        dishConnected: isConnected,
        dishError: error,
        routerProbe,
        dnsProbe,
        alerts: alertRefs,
      }),
    [telemetry, isConnected, error, routerProbe, dnsProbe, alertRefs],
  );

  return (
    // 无边框、无背景、无标题：四个节点直接裸露在页面背景上，只留轻量 margin。
    // 整体结论留给图形自己表达（红虚线 = 断，? = 测不出来）。
    <div
      className="my-1"
      aria-label={`全链路状态：${model.verdict.headline}，${model.verdict.detail}`}
      role="img"
    >
      <div className="overflow-x-auto">
        <div className="flex items-stretch min-w-[720px]">
          {model.nodes.map((node, i) => (
            <div key={node.id} className="flex items-stretch flex-1">
              <NodeCard node={node} onOpenAlerts={onOpenAlerts} />
              {i < model.links.length && (
                <LinkSegment link={model.links[i]} onOpenAlerts={onOpenAlerts} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 零件                                                                */
/* ------------------------------------------------------------------ */

function NodeCard({
  node,
  onOpenAlerts,
}: {
  node: TopologyNodeState;
  onOpenAlerts?: () => void;
}) {
  const hasAlert = node.alerts.length > 0;
  const tooltip = node.alerts.length
    ? [node.detail, ...node.alerts.map((a) => a.summary)].join('\n')
    : node.detail;

  return (
    <div
      className="relative flex flex-1 items-center gap-2.5 px-1.5 py-1 min-w-[168px]"
      title={tooltip}
    >
      <div className="relative shrink-0">
        <div
          className={`w-10 h-10 rounded-xl grid place-items-center border ${TONE_TILE_BORDER[node.tone]}`}
          style={{
            background:
              node.tone === 'down'
                ? 'rgba(239,68,68,.14)'
                : node.tone === 'degraded'
                  ? 'rgba(249,115,22,.12)'
                  : NODE_IDENTITY[node.id].tint,
          }}
        >
          <NodeIcon id={node.id} />
        </div>

        {/* 「测不出来」就地标记：微型 ? 徽章，悬停给原因 */}
        {node.tone === 'unknown' && <UnknownBadge detail={node.detail} />}
      </div>

      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold leading-tight whitespace-nowrap">
          {node.title}
        </div>
        <div
          className={`mt-0.5 flex items-center gap-1.5 text-[11px] font-medium leading-tight ${TONE_TEXT[node.tone]}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${TONE_DOT[node.tone]}`} />
          <span className="whitespace-nowrap">{node.statusText}</span>
        </div>
        <div className="mt-0.5 text-[10px] font-mono text-muted-foreground/80 whitespace-nowrap">
          {node.metricText}
        </div>
      </div>

      {hasAlert && (
        <button
          type="button"
          onClick={onOpenAlerts}
          disabled={!onOpenAlerts}
          className="absolute top-0 right-0 min-w-[18px] h-[18px] px-1 rounded-full bg-danger-red text-[10px] font-bold text-white grid place-items-center shadow-sm enabled:hover:brightness-110"
          title={node.alerts.map((a) => a.summary).join('\n')}
        >
          {node.alerts.length}
        </button>
      )}
    </div>
  );
}

function LinkSegment({
  link,
  onOpenAlerts,
}: {
  link: TopologyLinkState;
  onOpenAlerts?: () => void;
}) {
  const hasAlert = link.alerts.length > 0;
  const isDown = link.tone === 'down';
  const isUnknown = link.tone === 'unknown';

  return (
    <div
      className="flex w-[76px] shrink-0 flex-col items-center justify-center px-1"
      title={`${link.label}：${link.detail}`}
    >
      <span
        className={`text-[9.5px] mb-1 whitespace-nowrap ${
          isDown ? 'text-danger-red/90' : 'text-muted-foreground/80'
        }`}
      >
        {link.label}
      </span>

      <button
        type="button"
        onClick={hasAlert ? onOpenAlerts : undefined}
        disabled={!hasAlert || !onOpenAlerts}
        className={`relative w-full h-[2px] rounded-full ${TONE_LINE[link.tone]} ${
          hasAlert ? 'cursor-pointer' : 'cursor-default'
        }`}
        aria-label={`${link.label}：${link.detail}`}
      >
        {/* 正常/降级：箭头指向下游 */}
        {!isDown && !isUnknown && (
          <span className="absolute right-0 top-1/2 -translate-y-1/2 border-l-[5px] border-y-[3.5px] border-y-transparent border-l-accent-green" />
        )}

        {/* 断链：红虚线 + SVG 叉 */}
        {isDown && (
          <>
            <span className="absolute inset-0 rounded-full border-t-2 border-dashed border-danger-red/80" />
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#0a0c10] text-danger-red"
              aria-hidden="true"
            >
              <path
                d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </>
        )}

        {/* 测不出来：连线中央的 ? 徽章（不再有全局提示条） */}
        {isUnknown && <UnknownBadge detail={link.detail} inline />}
      </button>
    </div>
  );
}

/**
 * 微型 `?` 徽章 —— 「这一处测不出来」的就地标记。
 *
 * 为什么需要它：级联故障时下游节点会变成灰色（未知），但只靠颜色说不清
 * 「为什么不知道」。全局提示条又说不到具体是哪一段，所以把 ? 直接摆在
 * 出问题的那一处，悬停给完整原因。
 */
function UnknownBadge({ detail, inline }: { detail: string; inline?: boolean }) {
  return (
    <span
      title={detail}
      aria-label={detail}
      className={`grid place-items-center w-4 h-4 rounded-full border border-border bg-[#0a0c10] text-[10px] font-bold leading-none text-muted-foreground cursor-help ${
        inline
          ? 'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'
          : 'absolute -right-1 -bottom-1'
      }`}
    >
      ?
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* 图标（内联双色 SVG —— 不依赖 emoji 字形）                            */
/* ------------------------------------------------------------------ */

/**
 * 双色图标：主轮廓用身份色，局部填充/点缀用更亮的同色系。
 *
 * 单色线框在深色背景上太"平"，四个节点看着像同一套符号；
 * 加一层低透明度填充 + 一个亮点，才有 emoji 那种体积感，又不依赖字形。
 */
function NodeIcon({ id }: { id: TopologyNodeId }) {
  const { stroke, accent } = NODE_IDENTITY[id];

  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke,
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  if (id === 'pc') {
    return (
      <svg {...common}>
        <rect x="2.5" y="4" width="19" height="12.5" rx="2" fill={stroke} fillOpacity={0.16} />
        <path d="M8.5 20.5h7M12 16.5v4" />
        <path d="M6 12.5l3-3 2 2 3-3.5 2 2" stroke={accent} strokeWidth={1.2} />
      </svg>
    );
  }

  if (id === 'router') {
    return (
      <svg {...common}>
        <rect x="2.5" y="14" width="19" height="6.5" rx="2" fill={stroke} fillOpacity={0.16} />
        <path d="M6.5 17.2h.01M9.8 17.2h.01" strokeWidth={2} />
        <path d="M12 11.5V9" />
        <path d="M9.2 8.6a4 4 0 0 1 5.6 0" stroke={accent} />
        <path d="M6.8 6.2a7.5 7.5 0 0 1 10.4 0" stroke={accent} />
      </svg>
    );
  }

  if (id === 'dish') {
    // 抛物面（填充）+ 支架 + 信号弧（点缀色）
    return (
      <svg {...common}>
        <path d="M4.2 10.2a9 9 0 0 1 12.4 0z" fill={stroke} fillOpacity={0.22} />
        <path d="M4.2 10.2a9 9 0 0 1 12.4 0" />
        <path d="M10.4 10.2 19 4.4" stroke={accent} />
        <path d="M12 14v6M9 20h6" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="8.6" fill={stroke} fillOpacity={0.14} />
      <path d="M3.4 12h17.2" stroke={accent} />
      <path d="M12 3.4a13 13 0 0 1 0 17.2a13 13 0 0 1 0-17.2Z" />
    </svg>
  );
}
