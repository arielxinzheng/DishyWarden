/**
 * 【刚刚恢复】留存卡片 —— 纯展示
 *
 * 约束:
 *   - 不拉数据、不读 storage、不做过滤。列表由父组件用
 *     selectRecentlyResolved 算好后传进来。
 *   - 视觉上必须和活跃告警横幅明显不同: 活跃 = 红/橙危险色, 这里 = 绿色
 *     安全色或中性灰。严禁红黄。
 *   - 层级: 活跃横幅永远在上, 本卡片在下。
 */

import { CheckCircle2, ShieldCheck, X } from 'lucide-react';
import {
  VISIBLE_LIMIT,
  dismissKeyOf,
  formatAgo,
  formatDuration,
  formatSpan,
  recoveredAt,
  scenarioOf,
  type ResolvedAlertLike,
} from './recentlyResolved';

interface RecentlyResolvedCardProps {
  /** 已按恢复时间倒序、已过滤的完整列表 */
  alerts: readonly ResolvedAlertLike[];
  /** 由父组件统一取的「现在」, 保证同一次渲染里所有相对时间口径一致 */
  now: number;
  onDismiss: (alert: ResolvedAlertLike) => void;
  onOpenHistory: () => void;
}

const parseTs = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
};

/** `网络中断（14:05 - 14:10，持续 5 分钟）` */
const describeOutage = (alert: ResolvedAlertLike): string => {
  const span = formatSpan(alert.first_seen, alert.last_seen);
  const lasted = formatDuration(recoveredAt(alert) - parseTs(alert.first_seen));
  const window = [span, lasted && `持续 ${lasted}`].filter(Boolean).join('，');
  const scenario = scenarioOf(alert);
  return window ? `${scenario}（${window}）` : scenario;
};

export function RecentlyResolvedCard({
  alerts,
  now,
  onDismiss,
  onOpenHistory,
}: RecentlyResolvedCardProps) {
  if (alerts.length === 0) return null;

  const shown = alerts.slice(0, VISIBLE_LIMIT);
  const remaining = alerts.length - shown.length;

  return (
    <section
      // 不用 <Alert>: 那个组件带 role="alert", 会把「已恢复」当成新的紧急消息
      // 播报给屏幕阅读器, 语义正好相反。
      aria-label="最近已恢复的严重告警"
      className="rounded-lg border border-accent-green/30 bg-accent-green/5 p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 shrink-0 text-accent-green" />
          <span className="text-sm font-medium text-accent-green">刚刚恢复</span>
          <span className="text-xs text-muted-foreground">
            最近 1 小时内已自动恢复的严重告警
          </span>
        </div>
        <button
          type="button"
          onClick={onOpenHistory}
          className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          查看历史
        </button>
      </div>

      <ul className="space-y-2">
        {shown.map((alert) => (
          <li
            key={dismissKeyOf(alert)}
            className="flex items-start justify-between gap-3 rounded-md bg-accent-green/10 px-3 py-2"
          >
            <div className="flex min-w-0 items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent-green" />
              <div className="min-w-0">
                <p className="text-sm text-foreground/90">
                  刚才经历了一次{describeOutage(alert)}，现已自动恢复正常
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatAgo(now - recoveredAt(alert))}恢复
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onDismiss(alert)}
              aria-label="我知道了，不再提示这条"
              title="我知道了"
              className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent-green/15 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>

      {remaining > 0 && (
        <button
          type="button"
          onClick={onOpenHistory}
          className="mt-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          还有 {remaining} 条更早的已恢复告警
        </button>
      )}
    </section>
  );
}