/**
 * 数据采集器 (Historian)
 * 
 * 在 Electron 主进程中运行，负责：
 * 1. 定期轮询 Starlink dish/router (默认30秒)
 * 2. 提取遥测数据并记录到内存缓冲区
 * 3. 为 Prometheus exporter 提供数据
 * 4. 持久化历史数据到本地存储
 */

import { DishClient, TelemetryData } from '../core/dishClient';
import { RouterClient, RouterTelemetryData } from '../core/routerClient';
import { TelemetryStore } from '../storage/telemetryStore';
import type { HistorySample, PruneResult, StorageStats } from '../storage/types';
import { EventEmitter } from 'events';
import path from 'path';

export interface CollectorConfig {
  interval: number;           // 采集间隔（毫秒）
  bufferSize: number;         // 内存缓冲区大小（数据点数量）
  dishAddress?: string;       // Dish 地址
  dishPort?: number;          // Dish gRPC 端口
  routerAddress?: string;     // Router 地址
  routerPort?: number;        // Router gRPC 端口
  enablePersistence?: boolean; // 是否持久化到磁盘
  dataDir?: string;           // 自定义数据目录（留空则用 app.getPath('userData')/data）
}

export interface CollectorStats {
  totalSamples: number;
  failedSamples: number;
  lastSuccessTime: Date | null;
  lastFailureTime: Date | null;
  uptime: number;
  anomalyCount: number;
}

export class DataCollector extends EventEmitter {
  private config: Required<CollectorConfig>;
  private client: DishClient;
  private routerClient: RouterClient;
  private buffer: TelemetryData[] = [];
  private intervalHandle: NodeJS.Timeout | null = null;
  private isRunning = false;
  private startTime: Date | null = null;
  /** 历史库。打不开时降级为 null, 采集与实时推送不受影响。 */
  private store: TelemetryStore | null = null;
  
  private stats: CollectorStats = {
    totalSamples: 0,
    failedSamples: 0,
    lastSuccessTime: null,
    lastFailureTime: null,
    uptime: 0,
    anomalyCount: 0,
  };

  constructor(config: Partial<CollectorConfig> = {}) {
    super();
    
    this.config = {
      interval: config.interval || 30000, // 30秒
      bufferSize: config.bufferSize || 2880, // 24小时数据 (86400/30)
      dishAddress: config.dishAddress || '127.0.0.1',
      dishPort: config.dishPort || 9200,
      routerAddress: config.routerAddress || '127.0.0.1',
      routerPort: config.routerPort || 9200,
      enablePersistence: config.enablePersistence ?? true,
      dataDir: config.dataDir || '', // 空 = 使用 app.getPath('userData')/data
    };

    this.client = new DishClient({
      address: this.config.dishAddress,
      grpcPort: this.config.dishPort,
    });

    this.routerClient = new RouterClient({
      address: this.config.routerAddress,
      grpcPort: this.config.routerPort,
    });

    if (this.config.enablePersistence) {
      this.store = openStore(this.config.dataDir);
    }
  }

  /**
   * 启动采集器
   */
  start() {
    if (this.isRunning) {
      console.warn('Collector is already running');
      return;
    }

    this.isRunning = true;
    this.startTime = new Date();
    
    console.log(`[Collector] Starting with ${this.config.interval}ms interval`);
    
    // 立即采集一次
    this.collect();
    
    // 启动定时采集
    this.intervalHandle = setInterval(() => {
      this.collect();
    }, this.config.interval);

    this.emit('started');
  }

  /**
   * 停止采集器
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    this.isRunning = false;
    console.log('[Collector] Stopped');
    
    this.emit('stopped');
  }

  /**
   * 执行一次数据采集
   */
  private async collect() {
    try {
      // 添加超时保护（10秒）
      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Starlink 设备连接超时 (10s)')), 10000)
      );
      
      // 并行采集 dish 和 router 数据，两侧独立成败
      // 使用 allSettled 确保一方失败不影响另一方
      const collectPromise = Promise.allSettled([
        this.client.getTelemetry(),
        this.routerClient.getTelemetry(),
      ]);
      
      const results = await Promise.race([
        collectPromise,
        timeoutPromise
      ]);
      
      // 解包 allSettled 结果
      const [dishResult, routerResult] = results;
      
      // dish 失败时整帧失败（dish 是主数据源）
      if (dishResult.status === 'rejected') {
        throw new Error(`Dish 采集失败: ${dishResult.reason}`);
      }
      
      const telemetry = dishResult.value;
      
      // router 失败时降级为 null，不影响 dish 数据
      let routerTelemetry: RouterTelemetryData | null = null;
      if (routerResult.status === 'fulfilled') {
        routerTelemetry = routerResult.value;
      } else {
        console.warn('[Collector] Router 采集失败:', routerResult.reason);
      }
      
      // 添加时间戳
      const dataPoint = {
        ...telemetry,
        router: routerTelemetry,
        timestamp: new Date(),
      } as TelemetryData & { router: RouterTelemetryData | null; timestamp: Date };

      // 添加到缓冲区
      this.buffer.push(dataPoint);
      
      // 限制缓冲区大小
      if (this.buffer.length > this.config.bufferSize) {
        this.buffer.shift();
      }

      // 落盘。写库失败绝不能影响采集与实时推送, 所以单独 try/catch。
      this.persist(dataPoint);

      // 更新统计
      this.stats.totalSamples++;
      this.stats.lastSuccessTime = new Date();
      
      if (this.startTime) {
        this.stats.uptime = Date.now() - this.startTime.getTime();
      }

      // 检测异常 (TODO: 实现异常检测逻辑)
      // const anomalies = detectAnomalies(telemetry);
      // if (anomalies.length > 0) {
      //   this.stats.anomalyCount += anomalies.length;
      //   this.emit('anomalies', anomalies);
      // }

      // 发送数据更新事件
      this.emit('data', dataPoint);

      const routerInfo = routerTelemetry 
        ? `router_clients=${routerTelemetry.connectedClients}` 
        : 'router=unavailable';
      console.log(`[Collector] Sample ${this.stats.totalSamples}: latency=${telemetry.popPingLatencyMs.toFixed(1)}ms, state=${telemetry.state}, ${routerInfo}`);

    } catch (error) {
      this.stats.failedSamples++;
      this.stats.lastFailureTime = new Date();
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[Collector] Failed to collect data:', errorMessage);
      this.emit('error', error);
    }
  }

  /**
   * 将一条采样写入历史库。异常只记日志, 不向上抛。
   */
  private persist(point: TelemetryData & { timestamp: Date }): void {
    if (!this.store) return;
    try {
      this.store.append(point);
    } catch (error) {
      console.error('[Collector] 写入历史库失败:', error instanceof Error ? error.message : error);
    }
  }

  /**
   * 获取最新的遥测数据
   *
   * 内存缓冲区为空(应用刚启动/刚清空)时回落到历史库的最新快照,
   * 这样首屏不用等第一次采样。
   */
  getLatest(): TelemetryData | null {
    if (this.buffer.length > 0) {
      return this.buffer[this.buffer.length - 1];
    }
    return this.store?.readLatest() ?? null;
  }

  /**
   * 获取最新一份遮挡图及其采集时刻。
   *
   * 遮挡图存在历史库的最新一行里(只保留最新一份), 所以即使
   * 内存缓冲为空(应用刚启动)也能拿到上一次采集的视野。
   */
  getLatestObstruction(): { data: number[][]; ts: number; source: 'real' | 'mock' } | null {
    return this.store?.readLatestObstruction() ?? null;
  }

  /**
   * 获取指定时间范围的历史数据
   *
   * 优先走 SQLite(可跨重启、可超出一小时), 库不可用时回落到内存缓冲区。
   *
   * @param seconds 时间范围（秒）
   */
  getHistory(seconds: number): HistorySample[] {
    const now = Date.now();
    const fromMs = now - seconds * 1000;

    if (this.store) {
      try {
        return this.store.queryHistory({ fromMs, toMs: now, maxPoints: 600 });
      } catch (error) {
        console.error('[Collector] 查询历史库失败, 回落内存缓冲:', error);
      }
    }

    return this.buffer
      .filter((data: any) => data.timestamp && data.timestamp.getTime() >= fromMs)
      .map((data: any) => ({
        timestamp: data.timestamp.getTime(),
        state: data.state,
        popPingLatencyMs: data.popPingLatencyMs,
        popPingDropRate: data.popPingDropRate,
        downlinkThroughputBps: data.downlinkThroughputBps,
        uplinkThroughputBps: data.uplinkThroughputBps,
        snr: data.snr,
        fractionObstructed: data.fractionObstructed,
      }));
  }

  /**
   * 区间统计摘要(仪表盘概览带用)
   */
  getSummary(seconds: number) {
    const now = Date.now();
    return this.store?.summarize(now - seconds * 1000, now) ?? null;
  }

  /**
   * 历史库物理状态
   */
  getStorageStats(): StorageStats | null {
    return this.store?.stats() ?? null;
  }

  /**
   * 按保留策略清理过期数据
   */
  pruneStorage(): PruneResult | null {
    return this.store?.prune() ?? null;
  }

  /**
   * 关闭采集器并释放历史库
   */
  dispose(): void {
    this.stop();
    this.store?.close();
    this.store = null;
  }

  /**
   * 获取所有缓冲区数据
   */
  getAllData(): TelemetryData[] {
    return [...this.buffer];
  }

  /**
   * 获取采集器统计信息
   */
  getStats(): CollectorStats {
    return { ...this.stats };
  }

  /**
   * 获取采集器状态
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<CollectorConfig>) {
    const wasRunning = this.isRunning;
    
    if (wasRunning) {
      this.stop();
    }

    this.config = { ...this.config, ...config };
    
    // 更新客户端配置
    if (config.dishAddress || config.dishPort) {
      this.client.updateConfig({
        address: this.config.dishAddress,
        grpcPort: this.config.dishPort,
      });
    }
    
    // 更新 router 客户端配置
    if (config.routerAddress || config.routerPort) {
      this.routerClient.updateConfig({
        address: this.config.routerAddress,
        grpcPort: this.config.routerPort,
      });
    }

    if (wasRunning) {
      this.start();
    }
  }

  /**
   * 清空缓冲区
   */
  clearBuffer() {
    this.buffer = [];
    console.log('[Collector] Buffer cleared');
  }
}

/**
 * 打开历史库。
 *
 * 失败(原生模块缺失、磁盘只读等)时只告警并返回 null,
 * 采集器会退化成纯内存模式 —— 实时监控功能不受影响。
 */
function openStore(dataDir: string): TelemetryStore | null {
  try {
    const dbPath = dataDir ? path.join(dataDir, 'telemetry.db') : undefined;
    const store = new TelemetryStore(dbPath);
    console.log(`[Collector] 历史库已就绪: ${store.stats().dbPath}`);
    return store;
  } catch (error) {
    console.warn(
      '[Collector] 历史库不可用, 退化为内存模式:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * 创建默认的数据采集器实例
 */
export function createCollector(config?: Partial<CollectorConfig>): DataCollector {
  return new DataCollector(config);
}