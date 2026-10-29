/**
 * 告警管理器
 * 整合告警检测、去重、通知
 */

import { EventEmitter } from 'events';
import { AlertDatabase, type AlertRecord } from './database';
import { Notifier, type NotificationConfig, type NotificationContext } from './notifier';
import type { TelemetryData } from '../core/dishClient';
import type { AlertThresholds } from '../config/manager';

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
  private thresholds: AlertThresholds;

  constructor(notificationConfig: NotificationConfig, thresholds: AlertThresholds, dbPath?: string) {
    super();
    this.db = new AlertDatabase(dbPath);
    this.notifier = new Notifier(notificationConfig);
    this.thresholds = thresholds;
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
        condition: (data) => (data.popPingLatencyMs || 0) > this.thresholds.highLatencyMs,
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
        condition: (data) => (data.popPingDropRate || 0) > this.thresholds.highPacketLoss,
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
          `累计遮挡率: ${((data.fractionObstructed || 0) * 100).toFixed(1)}%, 影响网络性能`,
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
        condition: (data) => data.alerts?.includes('thermalThrottle') || false,
        summary: () => '天线温度过高,已启动降频保护',
        description: (data) => {
          const temp = data.dishTemperature?.toFixed(1) || 'N/A';
          return `当前温度: ${temp}°C, 高温导致性能下降`;
        },
        evidence: (data) => ({
          thermal_throttle: data.alerts?.includes('thermalThrottle'),
          dish_temperature: data.dishTemperature,
          psu_temperature: data.powerSupplyTemperature,
        }),
        recommendations: [
          '改善天线通风散热条件',
          '避免阳光直射',
          '检查天线安装环境温度',
          '降频保护会自动解除, 等待温度下降',
        ],
      },

      // 对准异常
      {
        id: 'alignment_issue',
        name: '天线对准异常',
        enabled: true,
        severity: 'warning',
        condition: (data) => {
          // 姿态估计状态不是已收敛
          const notConverged = data.attitudeEstimationState && 
            data.attitudeEstimationState !== 'FILTER_CONVERGED';
          // 或姿态不确定度过高 (>3度)
          const highUncertainty = (data.alignmentStats?.attitudeUncertaintyDeg || 0) > 3;
          return notConverged || highUncertainty;
        },
        summary: (data) => {
          const state = data.attitudeEstimationState || '未知';
          const uncertainty = data.alignmentStats?.attitudeUncertaintyDeg?.toFixed(1) || 'N/A';
          return `天线对准异常 (状态: ${state}, 不确定度: ${uncertainty}°)`;
        },
        description: (data) => {
          const azimuth = data.boresightAzimuthDeg?.toFixed(1) || 'N/A';
          const elevation = data.boresightElevationDeg?.toFixed(1) || 'N/A';
          const desired = data.alignmentStats 
            ? `期望 ${data.alignmentStats.desiredBoresightAzimuthDeg?.toFixed(1)}° / ${data.alignmentStats.desiredBoresightElevationDeg?.toFixed(1)}°`
            : '';
          return `当前指向: 方位角 ${azimuth}°, 仰角 ${elevation}° ${desired}`;
        },
        evidence: (data) => ({
          attitude_estimation_state: data.attitudeEstimationState,
          attitude_uncertainty_deg: data.alignmentStats?.attitudeUncertaintyDeg,
          boresight_azimuth: data.boresightAzimuthDeg,
          boresight_elevation: data.boresightElevationDeg,
          desired_azimuth: data.alignmentStats?.desiredBoresightAzimuthDeg,
          desired_elevation: data.alignmentStats?.desiredBoresightElevationDeg,
          tilt_angle: data.tiltAngleDeg,
        }),
        recommendations: [
          '检查天线是否被外力移动或倾斜',
          '确认安装底座稳固, 无松动',
          '等待系统自动重新校准 (通常 10-30 分钟)',
          '如持续无法收敛, 考虑重启设备',
        ],
      },

      // 电机卡死/收起
      {
        id: 'motors_stowed',
        name: '天线电机异常',
        enabled: true,
        severity: 'critical',
        condition: (data) => data.alerts?.includes('motorsStow') || false,
        summary: () => '天线电机收起或卡死',
        description: (data) => {
          const isHeating = data.alerts?.includes('isHeating');
          return isHeating 
            ? '检测到电机异常, 系统正在加热解冻' 
            : '天线电机无法正常工作, 可能被手动收起或因结冰卡死';
        },
        evidence: (data) => ({
          motors_stow: data.alerts?.includes('motorsStow'),
          is_heating: data.alerts?.includes('isHeating'),
          dish_temperature: data.dishTemperature,
          all_alerts: data.alerts,
        }),
        recommendations: [
          '检查是否手动收起了天线',
          '寒冷环境下可能因结冰卡死, 系统会自动加热',
          '等待加热完成 (通常 15-30 分钟)',
          '如非寒冷环境, 可能是电机硬件故障, 联系售后',
        ],
      },

      // 结冰加热
      {
        id: 'dish_heating',
        name: '天线结冰加热中',
        enabled: true,
        severity: 'warning',
        condition: (data) => data.alerts?.includes('isHeating') || false,
        summary: () => '天线检测到结冰, 正在自动加热',
        description: (data) => `当前温度: ${data.dishTemperature?.toFixed(1)}°C, 系统正在除冰`,
        evidence: (data) => ({
          is_heating: data.alerts?.includes('isHeating'),
          dish_temperature: data.dishTemperature,
          motors_stow: data.alerts?.includes('motorsStow'),
        }),
        recommendations: [
          '系统自动加热除冰中, 通常 15-30 分钟内完成',
          '结冰期间可能影响连接质量',
          '如频繁结冰, 考虑改善安装位置或增加遮蔽',
        ],
      },

      // 低吞吐量
      {
        id: 'low_throughput',
        name: '网络速率过低',
        enabled: true,
        severity: 'warning',
        condition: (data) => {
          // 在线状态下, 下行速率 < 5 Mbps 视为异常
          const lowDownlink = data.state === 'ONLINE' && (data.downlinkThroughputBps || 0) < 5 * 1024 * 1024;
          return lowDownlink;
        },
        summary: (data) => {
          const downMbps = ((data.downlinkThroughputBps || 0) / 1024 / 1024).toFixed(1);
          return `下行速率仅 ${downMbps} Mbps`;
        },
        description: () => '网络吞吐量显著低于正常水平',
        evidence: (data) => ({
          downlink_mbps: (data.downlinkThroughputBps || 0) / 1024 / 1024,
          uplink_mbps: (data.uplinkThroughputBps || 0) / 1024 / 1024,
          pop_latency_ms: data.popPingLatencyMs,
          obstructed: data.currentlyObstructed,
          snr: data.snr,
        }),
        recommendations: [
          '检查是否有遮挡影响信号质量',
          '查看是否有设备占用大量带宽',
          '可能是区域性网络拥塞, 高峰时段常见',
          '检查天线指向是否偏移',
        ],
      },

      // SNR 过低
      {
        id: 'low_snr',
        name: '信噪比过低',
        enabled: true,
        severity: 'warning',
        condition: (data) => {
          // SNR < 5 dB 视为信号质量差
          return data.state === 'ONLINE' && (data.snr || 0) < 5;
        },
        summary: (data) => `信噪比 ${data.snr?.toFixed(1)} dB, 低于正常范围`,
        description: () => '卫星信号质量较差, 可能影响连接稳定性',
        evidence: (data) => ({
          snr: data.snr,
          satellite_id: data.satelliteId,
          pop_drop_rate: data.popPingDropRate,
          obstructed: data.currentlyObstructed,
          fraction_obstructed: data.fractionObstructed,
        }),
        recommendations: [
          '检查天线周围是否有新增遮挡',
          '恶劣天气(暴雨/暴雪)会影响信号',
          '等待卫星切换, SNR 可能自动改善',
          '如持续低 SNR, 考虑调整天线位置',
        ],
      },

      // 设备高温
      {
        id: 'high_temperature',
        name: '设备温度过高',
        enabled: true,
        severity: 'warning',
        condition: (data) => {
          // 天线温度 > 70°C 或电源温度 > 80°C
          const highDishTemp = (data.dishTemperature || 0) > 70;
          const highPsuTemp = (data.powerSupplyTemperature || 0) > 80;
          return highDishTemp || highPsuTemp;
        },
        summary: (data) => {
          const dishTemp = data.dishTemperature?.toFixed(1);
          const psuTemp = data.powerSupplyTemperature?.toFixed(1);
          return `设备温度: 天线 ${dishTemp}°C, 电源 ${psuTemp}°C`;
        },
        description: () => '设备温度超出正常范围, 可能触发保护性降频',
        evidence: (data) => ({
          dish_temperature: data.dishTemperature,
          psu_temperature: data.powerSupplyTemperature,
          thermal_throttle: data.alerts?.includes('thermalThrottle'),
        }),
        recommendations: [
          '改善设备通风散热条件',
          '避免阳光直射',
          '检查安装环境温度',
          '如已触发热降频, 性能会下降直到温度降低',
        ],
      },

      // 频繁搜星 (通过 state 切换判断)
      {
        id: 'frequent_searching',
        name: '频繁断线重连',
        enabled: true,
        severity: 'warning',
        condition: (data) => {
          // 这个规则需要历史状态才能判断, 当前只检测 SEARCHING 状态
          // 在实际使用中, 需要在 AlertManager 层面维护状态切换计数
          return data.state === 'SEARCHING' && (data.uptime || 0) > 600; // 运行超过 10 分钟还在搜星
        },
        summary: () => '天线持续搜索卫星, 无法建立稳定连接',
        description: (data) => 
          `设备已运行 ${Math.floor((data.uptime || 0) / 60)} 分钟, 但仍在搜索卫星`,
        evidence: (data) => ({
          state: data.state,
          uptime_seconds: data.uptime,
          satellite_id: data.satelliteId,
          obstructed: data.currentlyObstructed,
          fraction_obstructed: data.fractionObstructed,
        }),
        recommendations: [
          '检查天线视野是否被严重遮挡',
          '确认天线安装位置符合要求',
          '检查天线指向是否正确',
          '可能是区域暂时无卫星覆盖',
          '尝试重启设备',
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
   * 获取告警历史（包括已恢复）
   */
  getAlertHistory(
    limit = 100,
    offset = 0,
    severityFilter?: import('./database').Severity,
    statusFilter?: import('./database').Status
  ): AlertRecord[] {
    return this.db.getAlertHistory(limit, offset, severityFilter, statusFilter);
  }

  /**
   * 获取告警总数（用于分页）
   */
  getAlertCount(
    severityFilter?: import('./database').Severity,
    statusFilter?: import('./database').Status
  ): number {
    return this.db.getAlertCount(severityFilter, statusFilter);
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
   * 更新告警阈值并重新初始化规则
   */
  updateThresholds(thresholds: AlertThresholds): void {
    this.thresholds = thresholds;
    this.initializeDefaultRules(); // 重新初始化规则以应用新阈值
  }

  /**
   * 关闭告警管理器
   */
  close(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    this.db.close();
  }
}