/**
 * 活跃告警列表组件
 */

import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Badge } from '../ui/badge';
import { AlertTriangle, Info } from 'lucide-react';
import type { AlertRecord } from '../../../alerting/database';
import { parseRecommendations } from '../../lib/alertFormat';

export function AlertList() {
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);

  useEffect(() => {
    // 初始加载
    const loadAlerts = async () => {
      if (window.electronAPI) {
        const activeAlerts = await window.electronAPI.getActiveAlerts();
        setAlerts(activeAlerts);
      }
    };

    loadAlerts();

    // 监听新告警
    if (window.electronAPI) {
      const unsubscribeNew = window.electronAPI.onAlertNew((alert) => {
        setAlerts((prev) => [alert, ...prev]);
      });

      const unsubscribeResolved = window.electronAPI.onAlertResolved((alert) => {
        setAlerts((prev) => prev.filter((a) => a.alert_key !== alert.alert_key));
      });

      return () => {
        unsubscribeNew();
        unsubscribeResolved();
      };
    }
  }, []);

  // 如果没有告警，返回 null（父组件会处理隐藏）
  if (alerts.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {alerts.map((alert) => (
        <Alert
          key={alert.id}
          className={`relative ${alert.severity === 'critical' ? 'border-red-500 bg-red-500/10' : ''}`}
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5">
              {alert.severity === 'critical' ? (
                <AlertTriangle className="h-5 w-5" />
              ) : alert.severity === 'warning' ? (
                <AlertTriangle className="h-5 w-5 text-yellow-500" />
              ) : (
                <Info className="h-5 w-5 text-blue-500" />
              )}
            </div>

            <div className="flex-1 space-y-1">
              <div className="flex items-center justify-between">
                <AlertTitle className="mb-0">{alert.summary}</AlertTitle>
                <Badge variant={alert.severity === 'critical' ? 'destructive' : 'secondary'}>
                  {alert.severity.toUpperCase()}
                </Badge>
              </div>

              <AlertDescription className="text-sm">
                {alert.description}
              </AlertDescription>

              <div className="flex items-center gap-4 text-xs text-muted-foreground pt-2">
                <span>首次: {new Date(alert.first_seen).toLocaleString('zh-CN')}</span>
                <span>触发: {alert.occurrence_count}次</span>
                {alert.status === 'ongoing' && (
                  <span className="text-orange-500 font-medium">持续中</span>
                )}
              </div>

              {(() => {
                // 解析失败必须降级, 不能抛 —— 渲染期异常会卸载整棵树
                const recs = parseRecommendations(alert.recommendations);
                if (recs.length === 0) return null;
                return (
                  <div className="mt-3 pt-3 border-t border-border/50">
                    <div className="text-xs font-medium mb-1">建议处理:</div>
                    <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                      {recs.map((rec, i) => (
                        <li key={i}>{rec}</li>
                      ))}
                    </ul>
                  </div>
                );
              })()}
            </div>
          </div>
        </Alert>
      ))}
    </div>
  );
}