/**
 * 活跃告警列表组件
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Badge } from '../ui/badge';
import { AlertTriangle, Info } from 'lucide-react';
import type { AlertRecord } from '../../../alerting/database';
import { localizeAlert } from '../../lib/alertMessage';

export function AlertList() {
  const { t, i18n } = useTranslation();
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
      {alerts.map((alert) => {
        // 告警标题/摘要/建议统一由 localizeAlert 按当前语言重拼,
        // 不直接展示主进程写进库里的中文原文。
        const localized = localizeAlert(alert, t);
        return (
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
                <AlertTitle className="mb-0">{localized.title}</AlertTitle>
                <Badge variant={alert.severity === 'critical' ? 'destructive' : 'secondary'}>
                  {localized.severityLabel}
                </Badge>
              </div>

              <AlertDescription className="text-sm">
                {localized.summary}
              </AlertDescription>

              <div className="flex items-center gap-4 text-xs text-muted-foreground pt-2">
                <span>
                  {t('dashboard:alert_list.first_seen', {
                    time: new Date(alert.first_seen).toLocaleString(i18n.language),
                  })}
                </span>
                <span>
                  {t('dashboard:alert_list.occurrences', { count: alert.occurrence_count })}
                </span>
                {alert.status === 'ongoing' && (
                  <span className="text-orange-500 font-medium">
                    {t('dashboard:alert_list.ongoing')}
                  </span>
                )}
              </div>

              {(() => {
                const recs = localized.recommendations;
                if (recs.length === 0) return null;
                return (
                  <div className="mt-3 pt-3 border-t border-border/50">
                    <div className="text-xs font-medium mb-1">
                      {t('dashboard:alert_list.recommendations')}
                    </div>
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
        );
      })}
    </div>
  );
}