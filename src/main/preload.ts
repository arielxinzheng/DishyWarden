import { contextBridge, ipcRenderer } from 'electron';
import type { TelemetryData } from '../core/dishClient';
import type { CollectorStats } from '../collector/historian';
import type { NetworkAnomaly } from '../core/telemetry';
import type { AlertRecord } from '../alerting/database';
import type { NotificationConfig } from '../alerting/notifier';
import type { AppConfig, CollectorConfig, PrometheusConfig, GrafanaConfig, ProbeConfig } from '../config/manager';
import type { HistorySample, HistorySummary, PruneResult, StorageStats, ObstructionEvent } from '../storage/types';
import type { RouterProbeResult } from '../core/routerProbeTypes';
import type { ProbeResult, ProbeNodeState } from '../core/probeRunner';
import type { HandoffEvent } from '../core/outageAnalyzer';

/**
 * Electron API 接口定义
 */
export interface ElectronAPI {
  // 获取实时遥测数据
  getLatestTelemetry: () => Promise<TelemetryData | null>;

  // 获取最新一份遮挡图及其采集时刻
  getLatestObstruction: () => Promise<{ data: number[][]; ts: number; source: 'real' | 'mock' } | null>;

  // 获取最近一次路由器探测结果 (需求文档 2.1.2)
  getRouterProbe: () => Promise<RouterProbeResult | null>;

  // 获取历史数据（来自 SQLite 历史库）
  getHistory: (seconds: number) => Promise<HistorySample[]>;

  // 获取区间统计摘要（概览带用）
  getHistorySummary: (seconds: number) => Promise<HistorySummary | null>;

  // 获取历史库物理状态
  getStorageStats: () => Promise<StorageStats | null>;

  // 手动清理过期数据
  pruneStorage: () => Promise<PruneResult | null>;
  
  // 获取采集器统计信息
  getCollectorStats: () => Promise<CollectorStats | null>;
  
  // 更新采集器配置
  updateCollectorConfig: (config: any) => Promise<{ success: boolean }>;
  
  // 监听遥测数据更新
  onTelemetryUpdate: (callback: (data: TelemetryData) => void) => () => void;
  
  // 监听异常检测
  onAnomaliesDetected: (callback: (anomalies: NetworkAnomaly[]) => void) => () => void;

  // 获取活跃告警列表
  getActiveAlerts: () => Promise<AlertRecord[]>;

  // 忽略告警
  snoozeAlert: (params: {
    alertKey: string;
    snoozeType: 'temporary' | 'until_resolved';
    durationMs?: number;
  }) => Promise<{ success: boolean; error?: string }>;

  // 取消忽略告警
  unsnoozeAlert: (alertKey: string) => Promise<{ success: boolean; error?: string }>;

  // 标记误报
  markFalsePositive: (params: {
    alertKey: string;
    deviceId?: string;
  }) => Promise<{ success: boolean; error?: string }>;

  // 获取告警历史（包括已恢复）
  getAlertHistory: (params: {
    limit?: number;
    offset?: number;
    severity?: string;
    status?: string;
  }) => Promise<{ alerts: AlertRecord[]; total: number }>;

  // 监听新告警
  onAlertNew: (callback: (alert: AlertRecord) => void) => () => void;

  // 监听告警恢复
  onAlertResolved: (callback: (alert: AlertRecord) => void) => () => void;

  // 更新通知配置
  updateNotificationConfig: (config: NotificationConfig) => Promise<{ success: boolean }>;

  // 获取完整配置
  getConfig: () => Promise<AppConfig>;

  // 更新采集器配置(设置页面用)
  updateCollectorConfigSettings: (config: Partial<CollectorConfig>) => Promise<{ success: boolean }>;

  // 更新 Prometheus 配置
  updatePrometheusConfig: (config: Partial<PrometheusConfig>) => Promise<{ success: boolean; requiresRestart?: boolean }>;

  // 更新探针配置(节点列表 + 路由跟踪目标)
  updateProbeConfig: (config: Partial<ProbeConfig>) => Promise<{ success: boolean }>;

  // 取所有探针节点的当前状态
  getProbeStates: () => Promise<ProbeNodeState[]>;

  // 取区间内的卫星切换事件(渲染层标注 ★ 卫星切换 点用)
  getHandoffs: (seconds: number) => Promise<HandoffEvent[]>;

  // 手动探测某个节点一次
  probeNodeNow: (nodeId: string) => Promise<ProbeResult | null>;

  // 订阅探针探测结果(实时状态灯)
  onProbeResult: (callback: (result: ProbeResult) => void) => () => void;

  // 重置配置
  resetConfig: () => Promise<{ success: boolean; requiresRestart?: boolean }>;

  // 更新 Grafana 配置
  updateGrafanaConfig: (config: Partial<GrafanaConfig>) => Promise<{ success: boolean }>;

  // 配置 Grafana (一键配置)
  provisionGrafana: () => Promise<{ success: boolean; dataSourceId?: number; dashboardUrl?: string; error?: string }>;

  // 检查 Grafana 连接
  checkGrafanaConnection: () => Promise<{ connected: boolean; error?: string }>;

  // 获取内置 TLE 种子（断网兜底用）
  getTLESeed: () => Promise<{
    fetchedAt: number;
    source: string;
    shells: { inclination: number; periodMin: number; count: number }[];
    data: { name: string; line1: string; line2: string }[];
  } | null>;

  // 执行 traceroute
  runTraceroute: (target?: string) => Promise<{
    target: string;
    hops: Array<{
      hop: number;
      ip: string | null;
      hostname: string;
      rtt: number | null;
    }>;
    completed: boolean;
    duration: number;
  }>;

  // 获取遮挡事件历史
  getObstructionEvents: (fromMs: number, toMs: number, limit?: number) => Promise<ObstructionEvent[]>;

  // 获取最新 DNS 探测结果
  getLatestDnsProbe: () => Promise<{
    node_id: string;
    timestamp: number;
    user_dns: { ok: boolean; rtt_ms: number | null; error?: string; resolved_ip?: string };
    baseline_dns: { ok: boolean; rtt_ms: number | null; error?: string; resolved_ip?: string };
  } | null>;
}

/**
 * 暴露安全的 Electron API 到渲染进程
 */
contextBridge.exposeInMainWorld('electronAPI', {
  getLatestTelemetry: () => ipcRenderer.invoke('get-latest-telemetry'),

  getLatestObstruction: () => ipcRenderer.invoke('get-latest-obstruction'),

  getRouterProbe: () => ipcRenderer.invoke('get-router-probe'),

  getHistory: (seconds: number) => ipcRenderer.invoke('get-history', seconds),

  getHistorySummary: (seconds: number) => ipcRenderer.invoke('get-history-summary', seconds),

  getStorageStats: () => ipcRenderer.invoke('get-storage-stats'),

  pruneStorage: () => ipcRenderer.invoke('prune-storage'),
  
  getCollectorStats: () => ipcRenderer.invoke('get-collector-stats'),
  
  updateCollectorConfig: (config: any) => ipcRenderer.invoke('update-collector-config', config),
  
  onTelemetryUpdate: (callback: (data: TelemetryData) => void) => {
    const listener = (_event: any, data: TelemetryData) => callback(data);
    ipcRenderer.on('telemetry-update', listener);
    
    // 返回取消订阅函数
    return () => {
      ipcRenderer.removeListener('telemetry-update', listener);
    };
  },
  
  onAnomaliesDetected: (callback: (anomalies: NetworkAnomaly[]) => void) => {
    const listener = (_event: any, anomalies: NetworkAnomaly[]) => callback(anomalies);
    ipcRenderer.on('anomalies-detected', listener);
    
    return () => {
      ipcRenderer.removeListener('anomalies-detected', listener);
    };
  },

  getActiveAlerts: () => ipcRenderer.invoke('get-active-alerts'),

  snoozeAlert: (params: {
    alertKey: string;
    snoozeType: 'temporary' | 'until_resolved';
    durationMs?: number;
  }) => ipcRenderer.invoke('snooze-alert', params),

  unsnoozeAlert: (alertKey: string) => ipcRenderer.invoke('unsnooze-alert', alertKey),

  markFalsePositive: (params: {
    alertKey: string;
    deviceId?: string;
  }) => ipcRenderer.invoke('mark-false-positive', params),

  getAlertHistory: (params: {
    limit?: number;
    offset?: number;
    severity?: string;
    status?: string;
  }) => ipcRenderer.invoke('get-alert-history', params),

  onAlertNew: (callback: (alert: AlertRecord) => void) => {
    const listener = (_event: any, alert: AlertRecord) => callback(alert);
    ipcRenderer.on('alert-new', listener);

    return () => {
      ipcRenderer.removeListener('alert-new', listener);
    };
  },

  onAlertResolved: (callback: (alert: AlertRecord) => void) => {
    const listener = (_event: any, alert: AlertRecord) => callback(alert);
    ipcRenderer.on('alert-resolved', listener);

    return () => {
      ipcRenderer.removeListener('alert-resolved', listener);
    };
  },

  updateNotificationConfig: (config: NotificationConfig) =>
    ipcRenderer.invoke('update-notification-config', config),

  getConfig: () => ipcRenderer.invoke('get-config'),

  updateCollectorConfigSettings: (config: Partial<CollectorConfig>) =>
    ipcRenderer.invoke('update-collector-config-settings', config),

  updatePrometheusConfig: (config: Partial<PrometheusConfig>) =>
    ipcRenderer.invoke('update-prometheus-config', config),

  updateProbeConfig: (config: Partial<ProbeConfig>) =>
    ipcRenderer.invoke('update-probe-config', config),

  getProbeStates: () => ipcRenderer.invoke('get-probe-states'),

  getHandoffs: (seconds: number) => ipcRenderer.invoke('get-handoffs', seconds),

  probeNodeNow: (nodeId: string) => ipcRenderer.invoke('probe-node-now', nodeId),

  onProbeResult: (callback: (result: ProbeResult) => void) => {
    const listener = (_e: unknown, result: ProbeResult) => callback(result);
    ipcRenderer.on('probe-result', listener);
    return () => ipcRenderer.removeListener('probe-result', listener);
  },

  resetConfig: () => ipcRenderer.invoke('reset-config'),

  updateGrafanaConfig: (config: Partial<GrafanaConfig>) =>
    ipcRenderer.invoke('update-grafana-config', config),

  provisionGrafana: () => ipcRenderer.invoke('provision-grafana'),

  checkGrafanaConnection: () => ipcRenderer.invoke('check-grafana-connection'),

  getTLESeed: () => ipcRenderer.invoke('get-tle-seed'),

  runTraceroute: (target?: string) => ipcRenderer.invoke('run-traceroute', target),

  getObstructionEvents: (fromMs: number, toMs: number, limit?: number) =>
    ipcRenderer.invoke('get-obstruction-events', fromMs, toMs, limit),

  getLatestDnsProbe: () => ipcRenderer.invoke('get-latest-dns-probe'),
} as ElectronAPI);