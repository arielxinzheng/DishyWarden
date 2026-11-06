/**
 * telemetry.ts 单元测试
 * 
 * 覆盖：格式化函数、异常检测、信号质量判断、遮挡严重程度
 */

import { describe, it, expect } from 'vitest';
import {
  formatLatency,
  formatBandwidth,
  formatPercentage,
  formatDuration,
  formatTimeLabel,
  getSignalQuality,
  getSignalQualityLabel,
  getObstructionSeverity,
  getObstructionSeverityLabel,
  detectAnomalies,
} from './telemetry';
import type { TelemetryData } from './dishClient';

describe('telemetry.ts - 格式化函数', () => {
  describe('formatLatency', () => {
    it('小于 1ms 显示 <1 ms', () => {
      expect(formatLatency(0.5)).toBe('<1 ms');
    });

    it('1-100ms 显示一位小数', () => {
      expect(formatLatency(45.678)).toBe('45.7 ms');
    });

    it('大于 100ms 取整', () => {
      expect(formatLatency(150.9)).toBe('151 ms');
    });
  });

  describe('formatBandwidth', () => {
    it('小于 1Mbps 显示 Kbps', () => {
      expect(formatBandwidth(500_000)).toBe('500.0 Kbps');
    });

    it('1-100Mbps 显示一位小数', () => {
      expect(formatBandwidth(25_500_000)).toBe('25.5 Mbps');
    });

    it('大于 100Mbps 取整', () => {
      expect(formatBandwidth(150_900_000)).toBe('151 Mbps');
    });
  });

  describe('formatPercentage', () => {
    it('默认一位小数', () => {
      expect(formatPercentage(0.1234)).toBe('12.3%');
    });

    it('可自定义小数位', () => {
      expect(formatPercentage(0.1234, 2)).toBe('12.34%');
    });

    it('0% 正确显示', () => {
      expect(formatPercentage(0)).toBe('0.0%');
    });
  });

  describe('formatDuration', () => {
    it('小于 60 秒显示秒', () => {
      expect(formatDuration(45)).toBe('45秒');
    });

    it('小于 1 小时显示分钟', () => {
      expect(formatDuration(300)).toBe('5分钟');
    });

    it('小于 24 小时显示小时+分钟', () => {
      expect(formatDuration(3750)).toBe('1小时2分钟');
    });

    it('整小时不显示分钟', () => {
      expect(formatDuration(7200)).toBe('2小时');
    });

    it('大于 24 小时显示天+小时', () => {
      expect(formatDuration(90000)).toBe('1天1小时');
    });

    it('整天不显示小时', () => {
      expect(formatDuration(86400)).toBe('1天');
    });
  });

  describe('formatTimeLabel', () => {
    it('Date 对象正确格式化', () => {
      const date = new Date('2024-01-15T10:30:00');
      const result = formatTimeLabel(date);
      expect(result).toMatch(/\d{1,2}:\d{2}:\d{2}/); // 匹配时间格式
    });

    it('epoch 毫秒数正确格式化', () => {
      const result = formatTimeLabel(1705311000000);
      expect(result).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    });

    it('ISO 字符串正确格式化', () => {
      const result = formatTimeLabel('2024-01-15T10:30:00Z');
      expect(result).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    });

    it('无效输入返回 null', () => {
      expect(formatTimeLabel(undefined)).toBeNull();
      expect(formatTimeLabel(null as any)).toBeNull();
      expect(formatTimeLabel('')).toBeNull();
      expect(formatTimeLabel('invalid')).toBeNull();
    });
  });
});

describe('telemetry.ts - 信号质量判断', () => {
  describe('getSignalQuality', () => {
    it('SNR >= 10 为优秀', () => {
      expect(getSignalQuality(12)).toBe('excellent');
    });

    it('SNR 7-10 为良好', () => {
      expect(getSignalQuality(8)).toBe('good');
    });

    it('SNR 5-7 为一般', () => {
      expect(getSignalQuality(6)).toBe('fair');
    });

    it('SNR 3-5 为较差', () => {
      expect(getSignalQuality(4)).toBe('poor');
    });

    it('SNR < 3 为无信号', () => {
      expect(getSignalQuality(2)).toBe('no_signal');
    });
  });

  describe('getSignalQualityLabel', () => {
    it('返回中文标签', () => {
      expect(getSignalQualityLabel('excellent')).toBe('优秀');
      expect(getSignalQualityLabel('good')).toBe('良好');
      expect(getSignalQualityLabel('fair')).toBe('一般');
      expect(getSignalQualityLabel('poor')).toBe('较差');
      expect(getSignalQualityLabel('no_signal')).toBe('无信号');
    });
  });
});

describe('telemetry.ts - 遮挡严重程度', () => {
  describe('getObstructionSeverity', () => {
    it('< 1% 为无遮挡', () => {
      expect(getObstructionSeverity(0.005)).toBe('none');
    });

    it('1-5% 为轻度遮挡', () => {
      expect(getObstructionSeverity(0.03)).toBe('minor');
    });

    it('5-15% 为中度遮挡', () => {
      expect(getObstructionSeverity(0.10)).toBe('moderate');
    });

    it('>= 15% 为严重遮挡', () => {
      expect(getObstructionSeverity(0.20)).toBe('severe');
    });
  });

  describe('getObstructionSeverityLabel', () => {
    it('返回中文标签', () => {
      expect(getObstructionSeverityLabel('none')).toBe('无遮挡');
      expect(getObstructionSeverityLabel('minor')).toBe('轻度遮挡');
      expect(getObstructionSeverityLabel('moderate')).toBe('中度遮挡');
      expect(getObstructionSeverityLabel('severe')).toBe('严重遮挡');
    });
  });
});

describe('telemetry.ts - 异常检测', () => {
  const createMockData = (overrides: Partial<TelemetryData> = {}): TelemetryData => ({
    state: 'ONLINE',
    uptime: 3600,
    snr: 8,
    popPingLatencyMs: 45,
    popPingDropRate: 0.01,
    downlinkThroughputBps: 50_000_000,
    uplinkThroughputBps: 5_000_000,
    fractionObstructed: 0.02,
    currentlyObstructed: false,
    secondsObstructed: 0,
    satelliteId: 12345,
    secondsToFirstNonemptySlot: 0,
    dishTemperature: 35,
    powerSupplyTemperature: 30,
    hardwareVersion: '1.0.0',
    softwareVersion: '1.0.0',
    // alerts 是 dishGetStatus.alerts 的**对象结构**(布尔标志),
    // 规则用 hasAlert(data, 'thermalThrottle') 读。
    alerts: {},
    ...overrides,
  });

  it('正常数据无异常', () => {
    const data = createMockData();
    const anomalies = detectAnomalies(data);
    expect(anomalies).toHaveLength(0);
  });

  it('离线时只返回 offline 异常', () => {
    const data = createMockData({ state: 'OFFLINE' });
    const anomalies = detectAnomalies(data);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].type).toBe('offline');
    expect(anomalies[0].severity).toBe('critical');
  });

  it('高延迟检测（100-200ms 为 warning）', () => {
    const data = createMockData({ popPingLatencyMs: 150 });
    const anomalies = detectAnomalies(data);
    const latencyAnomaly = anomalies.find(a => a.type === 'high_latency');
    expect(latencyAnomaly).toBeDefined();
    expect(latencyAnomaly!.severity).toBe('warning');
    expect(latencyAnomaly!.value).toBe(150);
  });

  it('极高延迟检测（> 200ms 为 critical）', () => {
    const data = createMockData({ popPingLatencyMs: 250 });
    const anomalies = detectAnomalies(data);
    const latencyAnomaly = anomalies.find(a => a.type === 'high_latency');
    expect(latencyAnomaly!.severity).toBe('critical');
  });

  it('丢包检测（5-15% 为 warning）', () => {
    const data = createMockData({ popPingDropRate: 0.10 });
    const anomalies = detectAnomalies(data);
    const lossAnomaly = anomalies.find(a => a.type === 'packet_loss');
    expect(lossAnomaly).toBeDefined();
    expect(lossAnomaly!.severity).toBe('warning');
  });

  it('高丢包检测（> 15% 为 critical）', () => {
    const data = createMockData({ popPingDropRate: 0.20 });
    const anomalies = detectAnomalies(data);
    const lossAnomaly = anomalies.find(a => a.type === 'packet_loss');
    expect(lossAnomaly!.severity).toBe('critical');
  });

  it('低吞吐量检测（< 10Mbps 为 warning）', () => {
    const data = createMockData({ downlinkThroughputBps: 5_000_000 });
    const anomalies = detectAnomalies(data);
    const throughputAnomaly = anomalies.find(a => a.type === 'low_throughput');
    expect(throughputAnomaly).toBeDefined();
    expect(throughputAnomaly!.severity).toBe('warning');
  });

  it('极低吞吐量检测（< 1Mbps 为 critical）', () => {
    const data = createMockData({ downlinkThroughputBps: 500_000 });
    const anomalies = detectAnomalies(data);
    const throughputAnomaly = anomalies.find(a => a.type === 'low_throughput');
    expect(throughputAnomaly!.severity).toBe('critical');
  });

  it('中度遮挡检测（5-15% 为 warning）', () => {
    const data = createMockData({ fractionObstructed: 0.10 });
    const anomalies = detectAnomalies(data);
    const obstructionAnomaly = anomalies.find(a => a.type === 'obstruction');
    expect(obstructionAnomaly).toBeDefined();
    expect(obstructionAnomaly!.severity).toBe('warning');
  });

  it('严重遮挡检测（>= 15% 为 critical）', () => {
    const data = createMockData({ fractionObstructed: 0.20 });
    const anomalies = detectAnomalies(data);
    const obstructionAnomaly = anomalies.find(a => a.type === 'obstruction');
    expect(obstructionAnomaly!.severity).toBe('critical');
  });

  it('多重异常同时检测', () => {
    const data = createMockData({
      popPingLatencyMs: 250,
      popPingDropRate: 0.20,
      fractionObstructed: 0.20,
    });
    const anomalies = detectAnomalies(data);
    expect(anomalies.length).toBeGreaterThanOrEqual(3);
    expect(anomalies.some(a => a.type === 'high_latency')).toBe(true);
    expect(anomalies.some(a => a.type === 'packet_loss')).toBe(true);
    expect(anomalies.some(a => a.type === 'obstruction')).toBe(true);
  });
});