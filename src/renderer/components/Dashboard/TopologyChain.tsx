/**
 * 全链路拓扑状态链 —— 仪表盘的「视觉锚点」。
 *
 * 位置：全局状态条（5 块 overview band）之下、折线图卡之上。
 * 作用：一眼回答「现在到底哪一段坏了」——这是表格和折线图都给不出的信息。
 *
 * ## 分工
 *
 *   topologyModel.ts   纯判据（哪种情况算断、算降级、算测不出来）
 *   本文件             取数 + 画图（不参与任何判定）
 *
 * 组件里唯一的判断是「颜色 → 类名」的查表，判据全在模型层，才能被单测覆盖。
 *
 * ## 取数
 *
 * - 天线 / 公网：`useDish()` 的遥测（gRPC 采集链路）
 * - 局域网网关：`getRouterProbe()`（主进程 ICMP，30s 一次，带可信度自检）
 * - DNS 解析：`getLatestDnsProbe()`（有配置双轨探针节点时才有值，可为空）
 * - 告警：由仪表盘传入的活跃告警，用于角标与点击跳转
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from 'lucide-react';
import { useDish } from '../../hooks/useDish';
import { isValidProbe } from './routerProbeShape';
import type { RouterProbeResult } from '../../../core/routerProbeTypes';
import {
  buildTopology,
  type DnsProbeSnapshot,
  type TopologyAlertRef,
  type TopologyLinkState,
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

/** 颜色 → 类名。判据不在这里，这里只做翻译。 */
const TONE_TEXT: Record<TopologyTone, string> = {
  ok: 'text-accent-green',
  degraded: 'text-warning-orange',
  down: 'text-danger-red',
  unknown: 'text-muted-foreground',
};

const TONE_TILE: Record<TopologyTone, string> = {
  ok: 'bg-accent-green/10 border-accent-green/35',
  degraded: 'bg-warning-orange/10 border-warning-orange/35',
  down: 'bg-danger-red/10 border-danger-red/35',
  unknown: 'bg-muted/40 border-border',
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

const ICON_OF: Record<TopologyTone, typeof CheckCircle2> = {
  ok: CheckCircle2,
  degraded: AlertTriangle,
  down: XCircle,
  unknown: HelpCircle,
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

  const VerdictIcon = ICON_OF[model.verdict.tone];

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border">
      {/* 网格底纹，和上方 overview band 同一套视觉语言 */}
      <div
        className="absolute inset-0 opacity-[.055] pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(rgba(148,163,184,.6) 1px,transparent 1px),linear-gradient(90deg,rgba(148,163,184,.6) 1px,transparent 1px)',
          backgroundSize: '38px 38px',
        }}
      />
      <div
        className="relative"
        style={{
          background:
            model.verdict.tone === 'down'
              ? 'radial-gradient(760px 220px at 8% -60%, rgba(239,68,68,.13), transparent 62%), linear-gradient(120deg,#12080a,#0a0c10)'
              : model.verdict.tone === 'degraded'
                ? 'radial-gradient(760px 220px at 8% -60%, rgba(249,115,22,.12), transparent 62%), linear-gradient(120deg,#120d08,#0a0c10)'
                : 'radial-gradient(760px 220px at 8% -60%, rgba(56,189,248,.10), transparent 62%), linear-gradient(120deg,#0a1017,#0a0c10)',
        }}
      >
        {/* 头部：标题 + 一句话结论 */}
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border/60">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.13em] text-slate-300">
            {/* 图标一律内联 SVG：emoji 字形依赖平台字体，Linux/部分 Windows 上会变成空框 */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              className="text-sky-blue shrink-0"
              aria-hidden="true"
            >
              <circle cx="4" cy="12" r="1.9" />
              <circle cx="12" cy="12" r="1.9" />
              <circle cx="20" cy="12" r="1.9" />
              <path d="M6 12h4M14 12h4" />
            </svg>
            全链路状态 · 端到端拓扑
          </div>
          <button
            type="button"
            onClick={onOpenAlerts}
            disabled={!onOpenAlerts}
            className="flex items-center gap-2 text-[11.5px] text-muted-foreground enabled:hover:text-foreground transition-colors"
            title={model.verdict.detail}
          >
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-semibold ${TONE_TEXT[model.verdict.tone]} ${
                model.verdict.tone === 'ok'
                  ? 'border-accent-green/35 bg-accent-green/10'
                  : model.verdict.tone === 'down'
                    ? 'border-danger-red/35 bg-danger-red/10'
                    : model.verdict.tone === 'degraded'
                      ? 'border-warning-orange/35 bg-warning-orange/10'
                      : 'border-border bg-muted/40'
              }`}
            >
              <VerdictIcon className="w-3 h-3" />
              {model.verdict.headline}
            </span>
            {model.alertTotal > 0 && (
              <span className="rounded-full bg-danger-red/15 border border-danger-red/35 text-danger-red px-2 py-0.5 text-[10.5px] font-semibold">
                {model.alertTotal} 条告警
              </span>
            )}
          </button>
        </div>

        {/* 链路主体 */}
        <div className="overflow-x-auto">
          {/* 节点最小宽度 172px：再窄标题会截断成「用户终…」，这个组件就没法读了 */}
          <div className="flex items-stretch gap-0 px-3.5 py-3.5 min-w-[760px]">
            {model.nodes.map((node, i) => (
              <div key={node.id} className="flex items-stretch">
                <NodeCard node={node} onOpenAlerts={onOpenAlerts} />
                {i < model.links.length && (
                  <LinkSegment link={model.links[i]} onOpenAlerts={onOpenAlerts} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 断点原因：只在真有断链时才出现，避免平时占地方 */}
        {model.rootCause && (
          <div className="flex items-center gap-2 px-4 py-2 border-t border-border/60 text-[11.5px] text-danger-red">
            <XCircle className="w-3.5 h-3.5 shrink-0" />
            <span className="font-semibold">断点：{model.rootCause.label}</span>
            <span className="text-muted-foreground">{model.rootCause.reason}</span>
          </div>
        )}
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

  return (
    <div
      className="relative flex flex-1 items-center gap-2.5 rounded-xl border border-border/60 bg-card/50 px-3 py-2.5 min-w-[172px]"
      title={hasAlert ? node.alerts.map((a) => a.summary).join('\n') : undefined}
    >
      <div className={`w-9 h-9 shrink-0 rounded-lg grid place-items-center border ${TONE_TILE[node.tone]}`}>
        <NodeIcon id={node.id} tone={node.tone} />
      </div>

      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold leading-tight whitespace-nowrap">{node.title}</div>
        <div className={`mt-0.5 flex items-center gap-1.5 text-[11px] font-medium leading-tight ${TONE_TEXT[node.tone]}`}>
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
          className="absolute -top-1.5 -right-1.5 w-4.5 h-4.5 min-w-[18px] h-[18px] rounded-full bg-danger-red text-[10px] font-bold text-white grid place-items-center shadow-sm enabled:hover:brightness-110"
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

  return (
    <div
      className="flex w-[74px] shrink-0 flex-col items-center justify-center px-1 group"
      title={`${link.label}：${link.detail}`}
    >
      <span className="text-[9.5px] text-muted-foreground/80 mb-1 whitespace-nowrap">{link.label}</span>

      <button
        type="button"
        onClick={hasAlert ? onOpenAlerts : undefined}
        disabled={!hasAlert || !onOpenAlerts}
        className={`relative w-full h-[2px] rounded-full transition-all ${TONE_LINE[link.tone]} ${
          isDown ? 'opacity-90' : ''
        } ${hasAlert ? 'cursor-pointer' : 'cursor-default'}`}
        aria-label={`${link.label}：${link.detail}`}
      >
        {/* 箭头 */}
        {!isDown && link.tone !== 'unknown' && (
          <span
            className={`absolute right-0 top-1/2 -translate-y-1/2 border-l-[5px] border-y-[3.5px] border-y-transparent ${
              link.tone === 'ok'
                ? 'border-l-accent-green'
                : 'border-l-warning-orange'
            }`}
          />
        )}
        {/* 断链：红色虚线 + SVG 叉 */}
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
              <path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </>
        )}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 图标（内联 SVG —— 不依赖 emoji 字形）                                */
/* ------------------------------------------------------------------ */

function NodeIcon({ id, tone }: { id: TopologyNodeState['id']; tone: TopologyTone }) {
  const stroke =
    tone === 'ok'
      ? '#10b981'
      : tone === 'degraded'
        ? '#f97316'
        : tone === 'down'
          ? '#ef4444'
          : '#94a3b8';

  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke,
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  if (id === 'pc') {
    return (
      <svg {...common}>
        <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
        <path d="M8.5 20.5h7M12 16.5v4" />
      </svg>
    );
  }

  if (id === 'router') {
    return (
      <svg {...common}>
        <rect x="2" y="14" width="20" height="7" rx="2" />
        <path d="M6.5 17.5h.01M10 17.5h.01" />
        <path d="M12 10.5V8" />
        <path d="M8.5 8a5 5 0 0 1 7 0" />
        <path d="M5.8 5.3a9 9 0 0 1 12.4 0" />
      </svg>
    );
  }

  if (id === 'dish') {
    // 卫星天线：抛物面 + 支架 + 信号弧
    return (
      <svg {...common}>
        <path d="M4 9.5a8.5 8.5 0 0 1 12 0" />
        <path d="M10 9.5 19.5 4" />
        <path d="M12 13.5v6M9 19.5h6" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z" />
    </svg>
  );
}
