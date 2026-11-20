/**
 * 浏览器调试环境的模拟遥测 —— 从 useDish.tsx 抽出为纯模块。
 *
 * 为什么抽出：useDish.tsx 顶层 import 了 i18n（模块加载时初始化、
 * 触碰浏览器检测），vitest 的 node 环境不能安全 import 它；
 * 而这几个函数是纯计算，值得单独回归（见 mockTelemetry.test.ts）。
 *
 * 字段名必须严格对齐 core/dishClient.TelemetryData，否则图表会读到 undefined。
 */
import type { TelemetryData } from '@/core/dishClient';
import { calculateSummary } from '@/core/telemetry';
import type { HistorySummary } from '@/storage/types';

// 生成模拟遥测数据
export function generateMockTelemetry(): TelemetryData {
  const baseLatency = Math.random() * 25 + 15; // 15-40 ms
  return {
    state: 'ONLINE',
    uptime: Math.floor(Math.random() * 86400), // 0-24 小时

    popPingLatencyMs: baseLatency,
    popPingDropRate: Math.random() * 0.02, // 0-2%
    downlinkThroughputBps: (Math.random() * 100 + 50) * 1e6, // 50-150 Mbps
    uplinkThroughputBps: (Math.random() * 20 + 10) * 1e6, // 10-30 Mbps

    snr: Math.random() * 5 + 5, // 5-10 dB
    secondsObstructed: Math.floor(Math.random() * 600),
    fractionObstructed: Math.random() * 0.05, // 0-5%
    currentlyObstructed: Math.random() > 0.9,

    satelliteId: 1000 + Math.floor(Math.random() * 2000),
    secondsToFirstNonemptySlot: Math.floor(Math.random() * 30),

    obstructionMap: generateMockObstructionMap(), // 添加障碍图
    obstructionMapSource: 'mock',

    // 校准数据
    boresightAzimuthDeg: 28.3 + (Math.random() - 0.5) * 2,
    boresightElevationDeg: 76.2 + (Math.random() - 0.5) * 2,
    // 枚举值必须与 dish proto 一致：真实设备返回 FILTER_CONVERGED。
    // 历史上这里写的是 'VALID'（协议里不存在），会让校准页恒判「未知状态」。
    attitudeEstimationState: 'FILTER_CONVERGED',
    tiltAngleDeg: 76 + (Math.random() - 0.5) * 1,
    alignmentStats: {
      validS: true,
      attitudeUncertaintyDeg: 0.4 + Math.random() * 0.2,
      desiredBoresightAzimuthDeg: 28,
      desiredBoresightElevationDeg: 76,
    },

    dishTemperature: Math.random() * 20 + 25, // 25-45 °C
    powerSupplyTemperature: Math.random() * 15 + 30, // 30-45 °C
    hardwareVersion: 'mock-hw-1.0',
    softwareVersion: 'mock-sw-1.0',

    // alerts 是 dishGetStatus.alerts 的布尔标志对象，不是字符串数组 ——
    // 写成 [] 既与 TelemetryData 类型不符，规则用 hasAlert() 也读不到。
    alerts: {},
  };
}

// 生成模拟障碍图 (123x123)
export function generateMockObstructionMap(): number[][] {
  const size = 123;
  const map: number[][] = [];

  for (let y = 0; y < size; y++) {
    const row: number[] = [];
    for (let x = 0; x < size; x++) {
      // 中心区域障碍少，边缘障碍多（模拟树木遮挡）
      const centerX = size / 2;
      const centerY = size / 2;
      const distance = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
      const normalized = distance / (size / 2);

      // 随机生成障碍值（**归一化 0..1**，越高遮挡越严重 —— 与 gRPC 实测路径同刻度）
      const obstruction = normalized > 0.8
        ? (Math.floor(Math.random() * 200) + 55) / 255
        : Math.floor(Math.random() * 50) / 255;

      row.push(obstruction);
    }
    map.push(row);
  }

  return map;
}

/**
 * 开发模式预览用摘要：用模拟样本推导，数值不代表真实链路。
 * 仅用于让浏览器调试时概览带可读，Electron 环境始终走 SQLite。
 */
export function buildMockSummary(seconds: number): HistorySummary {
  const sampleInterval = 30;
  const count = Math.min(Math.floor(seconds / sampleInterval), 120);
  const samples = Array.from({ length: count }, generateMockTelemetry);
  const s = calculateSummary(samples);
  const online = samples.filter(d => d.state === 'ONLINE').length;

  return {
    sampleCount: s.dataPoints,
    avgLatencyMs: s.avgLatency,
    maxLatencyMs: s.maxLatency,
    minLatencyMs: s.minLatency,
    avgDropRate: s.avgPacketLoss,
    avgDownBps: s.avgDownlink,
    avgUpBps: s.avgUplink,
    availability: s.dataPoints > 0 ? online / s.dataPoints : 0,
    outageCount: 0,
    // 平均值 × 时长 ÷ 8 = 区间总流量（bps → Bytes）。
    // 曾漏掉 ÷8 把 bits 当 bytes，浏览器调试态的「24H 用量」虚高 8 倍
    // （实测显示 9815 GB，实际估算应为 ~1227 GB）；
    // 口径必须与 SQLite 路径（telemetryStore.summarize 的 /8）一致。
    estimatedDownBytes: (s.avgDownlink * seconds) / 8,
    estimatedUpBytes: (s.avgUplink * seconds) / 8,
    firstTs: Date.now() - seconds * 1000,
    lastTs: Date.now(),
  };
}
