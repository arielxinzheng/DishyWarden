/**
 * 遥测数据处理模块
 * 
 * 负责：
 * 1. 数据格式化和单位转换
 * 2. 数据聚合和统计
 * 3. 异常检测
 */

import type { TelemetryData } from './dishClient';

/**
 * 格式化延迟值
 */
export function formatLatency(ms: number): string {
  if (ms < 1) return '<1 ms';
  if (ms < 100) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

/**
 * 格式化带宽值
 */
export function formatBandwidth(bps: number): string {
  const mbps = bps / 1e6;
  if (mbps < 1) return `${(bps / 1e3).toFixed(1)} Kbps`;
  if (mbps < 100) return `${mbps.toFixed(1)} Mbps`;
  return `${Math.round(mbps)} Mbps`;
}

/**
 * 格式化百分比
 */
export function formatPercentage(value: number, decimals: number = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

/**
 * 历史数据点: TelemetryData 本身不带 timestamp,
 * 但采集器/历史缓冲会在每条记录上附带采集时刻。
 * 可能是 Date、ISO 字符串、epoch 毫秒数, 甚至缺失。
 */
export type HistoryTimestamp = Date | string | number | undefined;

/**
 * 历史数据点: TelemetryData 本身不带 timestamp,
 * 但采集器/历史缓冲会在每条记录上附带采集时刻。
 * 可能是 Date、ISO 字符串、epoch 毫秒数, 甚至缺失。
 */
export interface HistoryPoint {
  timestamp?: HistoryTimestamp;
  popPingLatencyMs: number;
  /** 丢包率 0..1，历史样本来自遥测落盘，旧数据可能缺失 */
  popPingDropRate?: number;
  downlinkThroughputBps: number;
  uplinkThroughputBps: number;
}

/**
 * 把任意形式的时间戳格式化为图表 X 轴标签。
 * 无法解析时返回 null —— 由调用方决定跳过还是回退,
 * 绝不能在这里抛异常 (渲染期抛异常会导致整棵树白屏)。
 */
export function formatTimeLabel(ts: HistoryTimestamp): string | null {
  if (ts === undefined || ts === null || ts === '') return null;

  let d: Date;
  if (ts instanceof Date) {
    d = ts;
  } else if (typeof ts === 'number') {
    d = new Date(ts);
  } else if (typeof ts === 'string') {
    d = new Date(ts);
  } else {
    return null;
  }

  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('zh-CN');
}

/**
 * 格式化时长
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}秒`;
  
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 
      ? `${hours}小时${remainingMinutes}分钟`
      : `${hours}小时`;
  }
  
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0
    ? `${days}天${remainingHours}小时`
    : `${days}天`;
}

/**
 * 计算信号质量等级
 */
export type SignalQuality = 'excellent' | 'good' | 'fair' | 'poor' | 'no_signal';

export function getSignalQuality(snr: number): SignalQuality {
  if (snr >= 10) return 'excellent';
  if (snr >= 7) return 'good';
  if (snr >= 5) return 'fair';
  if (snr >= 3) return 'poor';
  return 'no_signal';
}

export function getSignalQualityLabel(quality: SignalQuality): string {
  const labels: Record<SignalQuality, string> = {
    excellent: '优秀',
    good: '良好',
    fair: '一般',
    poor: '较差',
    no_signal: '无信号',
  };
  return labels[quality];
}

export function getSignalQualityColor(quality: SignalQuality): string {
  const colors: Record<SignalQuality, string> = {
    excellent: 'text-accent-green',
    good: 'text-accent-blue',
    fair: 'text-accent-yellow',
    poor: 'text-danger-red',
    no_signal: 'text-muted-foreground',
  };
  return colors[quality];
}

/**
 * 计算遮挡严重程度
 */
export type ObstructionSeverity = 'none' | 'minor' | 'moderate' | 'severe';

export function getObstructionSeverity(fractionObstructed: number): ObstructionSeverity {
  if (fractionObstructed < 0.01) return 'none';
  if (fractionObstructed < 0.05) return 'minor';
  if (fractionObstructed < 0.15) return 'moderate';
  return 'severe';
}

export function getObstructionSeverityLabel(severity: ObstructionSeverity): string {
  const labels: Record<ObstructionSeverity, string> = {
    none: '无遮挡',
    minor: '轻度遮挡',
    moderate: '中度遮挡',
    severe: '严重遮挡',
  };
  return labels[severity];
}

export function getObstructionSeverityColor(severity: ObstructionSeverity): string {
  const colors: Record<ObstructionSeverity, string> = {
    none: 'text-accent-green',
    minor: 'text-accent-yellow',
    moderate: 'text-accent-yellow',
    severe: 'text-danger-red',
  };
  return colors[severity];
}

/**
 * 检测网络异常
 */
export interface NetworkAnomaly {
  type: 'high_latency' | 'packet_loss' | 'low_throughput' | 'obstruction' | 'offline';
  severity: 'warning' | 'critical';
  message: string;
  value?: number | string;
}

export function detectAnomalies(data: TelemetryData): NetworkAnomaly[] {
  const anomalies: NetworkAnomaly[] = [];
  
  // 离线
  if (data.state === 'OFFLINE') {
    anomalies.push({
      type: 'offline',
      severity: 'critical',
      message: '设备离线',
    });
    return anomalies;
  }
  
  // 高延迟
  if (data.popPingLatencyMs > 100) {
    anomalies.push({
      type: 'high_latency',
      severity: data.popPingLatencyMs > 200 ? 'critical' : 'warning',
      message: `延迟过高: ${formatLatency(data.popPingLatencyMs)}`,
      value: data.popPingLatencyMs,
    });
  }
  
  // 丢包
  if (data.popPingDropRate > 0.05) {
    anomalies.push({
      type: 'packet_loss',
      severity: data.popPingDropRate > 0.15 ? 'critical' : 'warning',
      message: `丢包率过高: ${formatPercentage(data.popPingDropRate)}`,
      value: data.popPingDropRate,
    });
  }
  
  // 低吞吐量（下行小于10Mbps）
  if (data.downlinkThroughputBps < 10e6) {
    anomalies.push({
      type: 'low_throughput',
      severity: data.downlinkThroughputBps < 1e6 ? 'critical' : 'warning',
      message: `下载速度过低: ${formatBandwidth(data.downlinkThroughputBps)}`,
      value: data.downlinkThroughputBps,
    });
  }
  
  // 遮挡
  const obstructionSeverity = getObstructionSeverity(data.fractionObstructed);
  if (obstructionSeverity === 'moderate' || obstructionSeverity === 'severe') {
    anomalies.push({
      type: 'obstruction',
      severity: obstructionSeverity === 'severe' ? 'critical' : 'warning',
      message: `${getObstructionSeverityLabel(obstructionSeverity)}: ${formatPercentage(data.fractionObstructed)}`,
      value: data.fractionObstructed,
    });
  }
  
  return anomalies;
}

/**
 * 计算统计摘要
 */
export interface TelemetrySummary {
  avgLatency: number;
  maxLatency: number;
  minLatency: number;
  avgPacketLoss: number;
  avgDownlink: number;
  avgUplink: number;
  totalObstructedTime: number;
  dataPoints: number;
}

export function calculateSummary(dataPoints: TelemetryData[]): TelemetrySummary {
  if (dataPoints.length === 0) {
    return {
      avgLatency: 0,
      maxLatency: 0,
      minLatency: 0,
      avgPacketLoss: 0,
      avgDownlink: 0,
      avgUplink: 0,
      totalObstructedTime: 0,
      dataPoints: 0,
    };
  }
  
  const latencies = dataPoints.map(d => d.popPingLatencyMs);
  const packetLoss = dataPoints.map(d => d.popPingDropRate);
  const downlinks = dataPoints.map(d => d.downlinkThroughputBps);
  const uplinks = dataPoints.map(d => d.uplinkThroughputBps);
  const obstructedTime = dataPoints.reduce((sum, d) => sum + d.secondsObstructed, 0);
  
  return {
    avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    maxLatency: Math.max(...latencies),
    minLatency: Math.min(...latencies),
    avgPacketLoss: packetLoss.reduce((a, b) => a + b, 0) / packetLoss.length,
    avgDownlink: downlinks.reduce((a, b) => a + b, 0) / downlinks.length,
    avgUplink: uplinks.reduce((a, b) => a + b, 0) / uplinks.length,
    totalObstructedTime: obstructedTime,
    dataPoints: dataPoints.length,
  };
}