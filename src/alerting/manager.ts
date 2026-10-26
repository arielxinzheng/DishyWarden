/**
 * 告警管理器
 * 整合告警检测、去重、通知
 */

import { EventEmitter } from 'events';
import { AlertDatabase, type AlertRecord } from './database';
import { Notifier, type NotificationConfig, type NotificationContext } from './notifier';
import type { TelemetryData } from '../core/dishClient';

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  severity: 'critical' | 'warning' | 'info';
  condition: (telemetry: TelemetryData) => boolean;
  summary: (telemetry: TelemetryData) => string;
  description: (telemetry: TelemetryData) => string;
  evidence: (telemetry: TelemetryData) => Record<string, unknown>;
  recommendations: string[];
}

export class AlertManager extends EventEmitter {
  private db: AlertDatabase;
  private notifier: Notifier;
  private rules: Map<string, AlertRule> = new Map();
  private checkInterval?: NodeJS.Timeout;

  constructor(notificationConfig: NotificationConfig) {
    super();
    this.db = new AlertDatabase();
    this.notifier = new Notifier(notificationConfig);
    this.initializeDefaultRules();
  }

  /**
   * 初始化默认告警规则
   */
  private initializeDefaultRules(): void {
    const rules: AlertRule[] = [
      // 设备离线
      {
        id: 'dish_offline',
        name: '天线设备离线',
        enabled: true,
        severity: 'critical',
        condition: (data) => data.state !== 'ONLINE',
        summary: () => 'Starlink 天线未连接',
        description: (data) => `天线状态: ${data.state}, 无法连接到卫星网络`,
        evidence: (data) => ({
          state: data.state,
          uptime_seconds: data.uptime || 0,
        }),
        recommendations: [
          '检查天线电源和网线连接',
          '确认 gRPC 端口 9200 可访问',
          '等待天线搜索卫星(正常需要 5-10 分钟)',
        ],
      },

      // 高延迟
      {
        id: 'high_latency',
        name: 'PoP 延迟过高',
        enabled: true,
        severity: 'warning',
        condition: (data) => (data.popPingLatencyMs || 0) > 100,
        summary: (data) => `PoP 延迟 ${data.popPingLatencyMs?.toFixed(1)}ms`,
        description: () => 'Starlink 骨干网络延迟异常',
        evidence: (data) => ({
          pop_latency_ms: data.popPingLatencyMs,
          pop_drop_rate: data.popPingDropRate,
        }),
        recommendations: [
          '持续监控,延迟可能随卫星切换恢复',
          '如持续高延迟,可能是区域网络拥塞',
        ],
      },

      // 高丢包
      {
        id: 'high_packet_loss',
        name: '严重丢包',
        enabled: true,
        severity: 'critical',
        condition: (data) => (data.popPingDropRate || 0) > 0.1,
        summary: (data) => `丢包率 ${((data.popPingDropRate || 0) * 100).toFixed(1)}%`,
        description: () => 'Starlink 网络丢包严重',
        evidence: (data) => ({
          pop_drop_rate: data.popPingDropRate,
          pop_latency_ms: data.popPingLatencyMs,
        }),
        recommendations: [
          '检查天线遮挡情况',
          '等待网络恢复或联系 Starlink 客服',
        ],
      },

      // 遮挡告警
      {
        id: 'obstruction_detected',
        name: '天线视野遮挡',
        enabled: true,
        severity: 'warning',
        condition: (data) => data.currentlyObstructed || false,
        summary: () => '检测到天线遮挡',
        description: (data) =>
          `遮挡率: ${((data.fractionObstructed || 0) * 100).toFixed(1)}%, 影响网络性能`,
        evidence: (data) => ({
          obstructed: data.currentlyObstructed,
          obstruction_percentage: data.fractionObstructed,
        }),
        recommendations: [
          '检查天线周围是否有新增遮挡物(树木、建筑)',
          '考虑调整天线安装位置或角度',
          '修剪遮挡的树枝',
        ],
      },

      // 热降频
      {
        id: 'thermal_throttle',
        name: '天线过热降频',
        enabled: true,
        severity: 'warning',
        condition: (data) => data.alerts?.includes('THERMAL_THROTTLE') || false,
        summary: () => '天线温度过高,已启动降频保护',
        description: () => '高温导致性能下降',
        evidence: (data) => ({
          thermal_throttle: data.alerts?.includes('THERMAL_THROTTLE'),
        }),
        recommendations: [
          '改善天线通风散热条件',
          '避免阳光直射',
          '检查天线安装环境温度',
        ],
      },
    ];

    rules.forEach((rule) => {
      this.rules.set(rule.id, rule);
    });
  }

  /**
   * 检查遥测数据并触发告警
   */
  async checkTelemetry(telemetry: TelemetryData): Promise<void> {
    const now = new Date().toISOString();

    for (const [ruleId, rule] of this.rules.entries()) {
      if (!rule.enabled) continue;

      try {
        const shouldAlert = rule.condition(telemetry);
        const alertKey = `${ruleId}:starlink`;

        if (shouldAlert) {
          // 告警触发
          const alert: Omit<AlertRecord, 'id' | 'created_at' | 'updated_at'> = {
            alert_key: alertKey,
            alert_type: ruleId,
            severity: rule.severity,
            status: 'ongoing',
            first_seen: now,
            last_seen: now,
            occurrence_count: 1,
            last_notified_at: null,
            notification_count: 0,
            summary: rule.summary(telemetry),
            description: rule.description(telemetry),
            evidence: JSON.stringify(rule.evidence(telemetry)),
            recommendations: JSON.stringify(rule.recommendations),
          };

          const result = this.db.upsertAlert(alert);

          if (result === 'new') {
            // 新告警,立即通知
            const record = this.db.getAlertByKey(alertKey)!;
            await this.sendNotification({ type: 'new', alert: record });
            this.db.markNotified(alertKey);
            this.emit('alert:new', record);
          } else if (result === 'ongoing') {
            // 持续触发,检查是否需要更新通知
            this.emit('alert:update', { alertKey });
          }
        } else {
          // 检查是否需要标记为已恢复
          const existing = this.db.getAlertByKey(alertKey);
          if (existing && existing.status === 'ongoing') {
            const duration = this.calculateDuration(existing.first_seen, now);

            const stmt = this.db.upsertAlert({
              ...existing,
              status: 'resolved',
              last_seen: now,
            });

            if (stmt === 'resolved') {
              await this.sendNotification({
                type: 'resolved',
                alert: { ...existing, status: 'resolved', last_seen: now },
                duration,
              });
              this.emit('alert:resolved', existing);
            }
          }
        }
      } catch (error) {
        console.error(`Error checking rule ${ruleId}:`, error);
      }
    }
  }

  /**
   * 启动定期检查需要更新通知的告警
   */
  startUpdateNotificationCheck(intervalMs = 60000): void {
    this.checkInterval = setInterval(() => {
      const alerts = this.db.getAlertsNeedingUpdate();

      alerts.forEach(async (alert) => {
        try {
          await this.sendNotification({ type: 'update', alert });
          this.db.markNotified(alert.alert_key);
        } catch (error) {
          console.error(`Failed to send update notification for ${alert.alert_key}:`, error);
        }
      });
    }, intervalMs);
  }

  /**
   * 发送通知
   */
  private async sendNotification(context: NotificationContext): Promise<void> {
    try {
      await this.notifier.notify(context);
    } catch (error) {
      console.error('Failed to send notification:', error);
      this.emit('notification:error', { context, error });
    }
  }

  /**
   * 计算持续时长
   */
  private calculateDuration(start: string, end: string): string {
    const diffMs = new Date(end).getTime() - new Date(start).getTime();
    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}小时${minutes % 60}分钟`;
    } else if (minutes > 0) {
      return `${minutes}分钟${seconds % 60}秒`;
    } else {
      return `${seconds}秒`;
    }
  }

  /**
   * 获取活跃告警
   */
  getActiveAlerts(): AlertRecord[] {
    return this.db.getActiveAlerts();
  }

  /**
   * 添加自定义规则
   */
  addRule(rule: AlertRule): void {
    this.rules.set(rule.id, rule);
  }

  /**
   * 禁用规则
   */
  disableRule(ruleId: string): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.enabled = false;
    }
  }

  /**
   * 启用规则
   */
  enableRule(ruleId: string): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.enabled = true;
    }
  }

  /**
   * 清理历史告警
   */
  cleanup(daysToKeep = 30): number {
    return this.db.cleanupResolvedAlerts(daysToKeep);
  }

  /**
   * 关闭告警管理器
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    this.db.close();
  }
}