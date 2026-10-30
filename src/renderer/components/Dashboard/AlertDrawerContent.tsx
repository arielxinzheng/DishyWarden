/**
 * 告警抽屉内容组件
 * 按严重程度排序展示活跃告警
 */

import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Badge } from '../ui/badge';
import { AlertTriangle, Info, AlertCircle } from 'lucide-react';
import type { AlertRecord } from '../../../alerting/database';
import { parseRecommendations } from '../../lib/alertFormat';

interface AlertDrawerContentProps {
  alerts: AlertRecord[];
}

export function AlertDrawerContent({ alerts }: AlertDrawerContentProps) {
  // 按严重程度排序：critical > warning > info
  const sortedAlerts = [...alerts].sort((a, b) => {
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    return (severityOrder[a.severity as keyof typeof severityOrder] ?? 99) - 
           (severityOrder[b.severity as keyof typeof severityOrder] ?? 99);
  });

  if (sortedAlerts.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-12">
        <AlertCircle className="w-12 h-12 mx-auto mb-4 opacity-50" />
        <p>当前没有活跃告警</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {sortedAlerts.map((alert) => (
        <Alert
          key={alert.id}
          className={`
            ${alert.severity === 'critical' 
              ? 'border-danger-red bg-danger-red/10 shadow-[0_0_20px_rgba(239,68,68,0.2)]' 
              : alert.severity === 'warning'
                ? 'border-warning-orange/50 bg-warning-orange/5'
                : 'border-sky-blue/50 bg-sky-blue/5'
            }
          `}
        >
          <div className="flex items-start gap-4">
            {/* 图标 */}
            <div className="mt-1 shrink-0">
              {alert.severity === 'critical' ? (
                <AlertTriangle className="h-6 w-6 text-danger-red" />
              ) : alert.severity === 'warning' ? (
                <AlertTriangle className="h-6 w-6 text-warning-orange" />
              ) : (
                <Info className="h-6 w-6 text-sky-blue" />
              )}
            </div>

            {/* 内容 */}
            <div className="flex-1 space-y-3 min-w-0">
              {/* 标题与徽章 */}
              <div className="flex items-start justify-between gap-4">
                <AlertTitle className="mb-0 text-lg">{alert.summary}</AlertTitle>
                <Badge 
                  variant={alert.severity === 'critical' ? 'destructive' : 'secondary'}
                  className="shrink-0"
                >
                  {alert.severity === 'critical' ? '严重' : alert.severity === 'warning' ? '警告' : '信息'}
                </Badge>
              </div>

              {/* 描述 */}
              <AlertDescription className="text-base leading-relaxed">
                {alert.description}
              </AlertDescription>

              {/* 建议处理 - 抽屉内完整展开，不折叠 */}
              {(() => {
                const recs = parseRecommendations(alert.recommendations);
                if (recs.length === 0) return null;
                return (
                  <div className="mt-4 pt-4 border-t border-border/50">
                    <div className="text-sm font-semibold mb-3 text-foreground">
                      💡 建议处理措施
                    </div>
                    <ul className="space-y-2">
                      {recs.map((rec, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm leading-relaxed">
                          <span className="text-accent-green shrink-0 mt-1">•</span>
                          <span className="text-muted-foreground">{rec}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })()}

              {/* 时间戳与计数 */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground pt-2 border-t border-border/30">
                <span>
                  首次触发: {new Date(alert.first_seen).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span>触发次数: {alert.occurrence_count}</span>
                {alert.status === 'ongoing' && (
                  <span className="text-warning-orange font-semibold">● 持续中</span>
                )}
              </div>
            </div>
          </div>
        </Alert>
      ))}
    </div>
  );
}