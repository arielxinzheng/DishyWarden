/**
 * React Context for DishClient
 * 提供全局的 Starlink Dish 数据访问
 * 
 * 在 Electron 环境中，使用主进程的数据采集器
 * 在开发模式下，使用模拟数据
 */

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { TelemetryData } from '@/core/dishClient';
import { calculateSummary, type NetworkAnomaly } from '@/core/telemetry';
import type { HistorySample, HistorySummary } from '@/storage/types';

/**
 * 遮挡图数据 + 它的来源与新鲜度
 *
 * source 存在的理由: 模拟图和真实图在视觉上几乎一样, 不标记的话
 * 用户会把演示数据当成设备实测结果 —— 这是监控软件最不该有的误导。
 */
export interface ObstructionData {
  /** 123x123 网格, 值域 0-255, 越高遮挡越严重 */
  data: number[][];
  /** 采集时刻 epoch ms */
  timestamp: number;
  /** 'real' = 设备实测, 'mock' = 本地模拟 */
  source: 'real' | 'mock';
}

interface DishContextValue {
  telemetry: TelemetryData | null;
  anomalies: NetworkAnomaly[];
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
  /** 最新遮挡图(含来源与时间), 无数据时为 null */
  obstruction: ObstructionData | null;
  refresh: () => Promise<void>;
}

const DishContext = createContext<DishContextValue | null>(null);

interface DishProviderProps {
  children: React.ReactNode;
  refreshInterval?: number;
}

// 生成模拟遥测数据
// 字段名必须严格对齐 core/dishClient.TelemetryData, 否则图表会读到 undefined。
function generateMockTelemetry(): TelemetryData {
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

    alerts: [],
  };
}

// 生成模拟障碍图 (123x123)
function generateMockObstructionMap(): number[][] {
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
      
      // 随机生成障碍值（0-255，越高遮挡越严重）
      const obstruction = normalized > 0.8 
        ? Math.floor(Math.random() * 200) + 55
        : Math.floor(Math.random() * 50);
      
      row.push(obstruction);
    }
    map.push(row);
  }
  
  return map;
}

export function DishProvider({ children }: DishProviderProps) {
  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);
  const [anomalies, setAnomalies] = useState<NetworkAnomaly[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 遮挡图独立于遥测刷新: 它有自己的采集时刻和来源标记
  const [obstruction, setObstruction] = useState<ObstructionData | null>(null);

  // 检测是否在 Electron 环境
  const isElectron = typeof window !== 'undefined' && window.electronAPI;
  
  // 开发模式：使用模拟数据
  const isDev = !isElectron && import.meta.env.DEV;

  const refresh = useCallback(async () => {
    console.log('[useDish] refresh called, isDev:', isDev, 'isElectron:', isElectron);
    
    // 开发模式模拟数据
    if (isDev) {
      console.log('[useDish] Using mock data in dev mode');
      setIsLoading(true);
      setError(null);
      
      // 模拟API调用延迟
      await new Promise(resolve => setTimeout(resolve, 500));
      
      setTelemetry(generateMockTelemetry());
      setObstruction({
        data: generateMockObstructionMap(),
        timestamp: Date.now(),
        source: 'mock',
      });
      setIsConnected(true);
      setIsLoading(false);
      console.log('[useDish] Mock data loaded successfully');
      return;
    }
    
    if (!isElectron) {
      console.log('[useDish] Not in Electron, showing error');
      setError('需要在 Electron 环境中运行');
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      // 从主进程获取数据，添加超时保护 (15秒)
      const timeoutPromise = new Promise<null>((_, reject) => 
        setTimeout(() => reject(new Error('连接超时：无法访问 Starlink 设备')), 15000)
      );
      
      const dataPromise = window.electronAPI.getLatestTelemetry();
      const data = await Promise.race([dataPromise, timeoutPromise]);

      if (data) {
        setTelemetry(data);
        setIsConnected(true);
      } else {
        setError('无法获取遥测数据，请检查 Starlink 设备是否已连接');
        setIsConnected(false);
      }

      // 遮挡图单独取: 失败不影响遥测, 也不能让整页报错
      try {
        const obs = await window.electronAPI.getLatestObstruction();
        if (obs && Array.isArray(obs.data) && obs.data.length > 0) {
          setObstruction({
            data: obs.data,
            timestamp: obs.ts,
            // 来源由主进程给出 —— 不能在这里假定是真实数据
            source: obs.source === 'real' ? 'real' : 'mock',
          });
        }
      } catch (err) {
        console.warn('[useDish] 获取遮挡图失败:', err);
      }
    } catch (err) {
      console.error('Failed to fetch telemetry:', err);
      const errorMessage = err instanceof Error ? err.message : '获取数据失败';
      setError(errorMessage);
      setIsConnected(false);
    } finally {
      setIsLoading(false);
    }
  }, [isElectron, isDev]);

  // Electron 环境：监听实时更新
  // 开发模式：定期生成模拟数据
  useEffect(() => {
    if (isDev) {
      // 开发模式：初始加载
      refresh();
      
      // 定期更新模拟数据 (每5秒)
      const interval = setInterval(() => {
        setTelemetry(generateMockTelemetry());
      }, 5000);
      
      return () => clearInterval(interval);
    }
    
    if (!isElectron) {
      setError('需要在 Electron 环境中运行');
      setIsLoading(false);
      return;
    }

    // 订阅遥测数据更新
    const unsubscribeTelemetry = window.electronAPI.onTelemetryUpdate((data) => {
      setTelemetry(data);
      setIsConnected(true);
      setIsLoading(false);
      setError(null);
    });

    // 订阅异常检测
    const unsubscribeAnomalies = window.electronAPI.onAnomaliesDetected((detectedAnomalies) => {
      setAnomalies(detectedAnomalies);
    });

    // 初始加载
    refresh();

    return () => {
      unsubscribeTelemetry();
      unsubscribeAnomalies();
    };
  }, [isElectron, isDev, refresh]);

  const value: DishContextValue = {
    telemetry,
    anomalies,
    isConnected,
    isLoading,
    error,
    obstruction,
    refresh,
  };

  return <DishContext.Provider value={value}>{children}</DishContext.Provider>;
}

export function useDish() {
  const context = useContext(DishContext);
  if (!context) {
    throw new Error('useDish must be used within DishProvider');
  }
  return context;
}

/**
 * 获取历史数据的 Hook
 */
export function useDishHistory(seconds: number = 3600) {
  const [history, setHistory] = useState<HistorySample[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const isElectron = typeof window !== 'undefined' && window.electronAPI;
  const isDev = !isElectron && import.meta.env.DEV;

  useEffect(() => {
    if (isDev) {
      // 开发模式：生成模拟历史数据
      const mockHistory: HistorySample[] = [];
      const now = Date.now();
      const interval = 30000; // 每30秒一个数据点
      const count = Math.min(Math.floor(seconds / 30), 120); // 最多120个点
      
      for (let i = count - 1; i >= 0; i--) {
        const sample = generateMockTelemetry();
        mockHistory.push({
          ...sample,
          timestamp: now - i * interval,
        });
      }
      
      setHistory(mockHistory);
      setIsLoading(false);
      return;
    }
    
    if (!isElectron) {
      setIsLoading(false);
      return;
    }

    const fetchHistory = async () => {
      try {
        setIsLoading(true);
        const data = await window.electronAPI.getHistory(seconds);
        setHistory(data);
      } catch (error) {
        console.error('Failed to fetch history:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchHistory();

    // 每分钟更新一次历史数据
    const interval = setInterval(fetchHistory, 60000);
    return () => clearInterval(interval);
  }, [isElectron, isDev, seconds]);

  return { history, isLoading };
}

/**
 * 开发模式预览用摘要：用模拟样本推导，数值不代表真实链路。
 * 仅用于让浏览器调试时概览带可读，Electron 环境始终走 SQLite。
 */
function buildMockSummary(seconds: number): HistorySummary {
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
    // 平均值 × 时长 = 区间总流量
    estimatedDownBytes: s.avgDownlink * seconds,
    estimatedUpBytes: s.avgUplink * seconds,
    firstTs: Date.now() - seconds * 1000,
    lastTs: Date.now(),
  };
}

/**
 * 区间统计摘要 Hook —— 供仪表盘概览带读取真实统计。
 *
 * 数据来自 SQLite 历史库(主进程计算), 不再是硬编码。
 * 浏览器调试环境用模拟摘要占位, 让布局可读。
 */
export function useHistorySummary(seconds: number = 86400) {
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const isElectron = typeof window !== 'undefined' && window.electronAPI;
  const isDev = !isElectron && import.meta.env.DEV;

  useEffect(() => {
    if (isDev) {
      setSummary(buildMockSummary(seconds));
      return;
    }

    if (!isElectron) return;

    let cancelled = false;

    const load = async () => {
      try {
        const data = await window.electronAPI.getHistorySummary(seconds);
        if (!cancelled) setSummary(data);
      } catch (error) {
        console.error('[useHistorySummary] 获取统计摘要失败:', error);
      }
    };

    load();
    const interval = setInterval(load, 60000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isElectron, seconds]);

  return summary;
}