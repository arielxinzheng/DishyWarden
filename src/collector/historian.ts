/**
 * 数据采集器 (Historian)
 * 
 * 在 Electron 主进程中运行，负责：
 * 1. 定期轮询 Starlink dish 遥测（默认30秒）
 * 2. 定期探测路由器可达性（ICMP Ping + HTTP）
 * 3. 提取遥测数据并记录到内存缓冲区
 * 4. 为 Prometheus exporter 提供数据
 * 5. 持久化历史数据到本地存储
 */

import { DishClient, TelemetryData } from '../core/dishClient';
import { RouterProbe, RouterProbeResult } from '../core/routerProbe';
import { TelemetryStore } from '../storage/telemetryStore';
import type { HistorySample, PruneResult, StorageStats } from '../storage/types';
import { EventEmitter } from 'events';
import path from 'path';
import { runProbe } from '../core/probeRunner';
import { pingDefaultGateway } from '../core/gatewayDetector';
import type { ProbeNodeConfig } from '../config/manager';
import { analyzeOutages, summarizeOutageAnalysis, type HandoffEvent } from '../core/outageAnalyzer';
import type { Outage } from '../core/outageTypes';

export interface CollectorConfig {
  interval: number;           // 采集间隔（毫秒）
  bufferSize: number;         // 内存缓冲区大小（数据点数量）
  dishAddress?: string;       // Dish 地址
  dishPort?: number;          // Dish gRPC 端口
  routerAddress?: string;     // Router 地址（用于 ICMP Ping 探测）
  enablePersistence?: boolean; // 是否持久化到磁盘
  dataDir?: string;           // 自定义数据目录（留空则用 app.getPath('userData')/data）
  probeNodes?: ProbeNodeConfig[]; // 探针节点配置列表
}

export interface CollectorStats {
  totalSamples: number;
  failedSamples: number;
  lastSuccessTime: Date | null;
  lastFailureTime: Date | null;
  uptime: number;
  anomalyCount: number;
  /** 检测到的卫星切换次数 */
  handoffCount: number;
  /** 最近一次卫星切换时间 */
  lastHandoffTime: Date | null;
}

export class DataCollector extends EventEmitter {
  private config: Required<CollectorConfig>;
  private client: DishClient;
  private routerProbe: RouterProbe;
  private buffer: TelemetryData[] = [];
  private intervalHandle: NodeJS.Timeout | null = null;
  private isRunning = false;
  private startTime: Date | null = null;
  /** 历史库。打不开时降级为 null, 采集与实时推送不受影响。 */
  private store: TelemetryStore | null = null;
  /** 最近一次路由器探测结果 */
  private lastRouterProbe: RouterProbeResult | null = null;
  /** 最近一次 history 拉取的时间戳（秒），避免重复分析 */
  private lastHistoryTimestamp = 0;
  /** 检测到的卫星切换事件（内存缓存） */
  private handoffEvents: HandoffEvent[] = [];
  
  private stats: CollectorStats = {
    totalSamples: 0,
    failedSamples: 0,
    lastSuccessTime: null,
    lastFailureTime: null,
    uptime: 0,
    anomalyCount: 0,
    handoffCount: 0,
    lastHandoffTime: null,
  };

  constructor(config: Partial<CollectorConfig> = {}) {
    super();
    
    this.config = {
      interval: config.interval || 30000, // 30秒
      bufferSize: config.bufferSize || 2880, // 24小时数据 (86400/30)
      dishAddress: config.dishAddress || '127.0.0.1',
      dishPort: config.dishPort || 9200,
      routerAddress: config.routerAddress || '192.168.100.1',
      enablePersistence: config.enablePersistence ?? true,
      dataDir: config.dataDir || '', // 空 = 使用 app.getPath('userData')/data
      probeNodes: config.probeNodes || [],
    };

    this.client = new DishClient({
      address: this.config.dishAddress,
      grpcPort: this.config.dishPort,
      fallbackToMock: false,  // 禁用 mock 回退，连接失败时直接报错
    });

    this.routerProbe = new RouterProbe({
      address: this.config.routerAddress,
      timeout: 5000,
      pingCount: 3,
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
      
      // 并行采集 dish 遥测、router 探活、公网探针、本地网关、history（包含 outages）
      const collectPromise = Promise.allSettled([
        this.client.getTelemetry(),
        this.routerProbe.probe(),
        this.probePublicLatency(),
        pingDefaultGateway(5), // 5 秒超时
        this.analyzeHandoffs(),  // 分析卫星切换
      ]);
      
      const results = await Promise.race([
        collectPromise,
        timeoutPromise
      ]);
      
      // 解包 allSettled 结果
      const [dishResult, routerResult, publicProbeResult, localGatewayResult, handoffResult] = results;
      
      // dish 失败时整帧失败（dish 是主数据源）
      if (dishResult.status === 'rejected') {
        throw new Error(`Dish 采集失败: ${dishResult.reason}`);
      }
      
      const telemetry = dishResult.value;
      
      // router 探测失败时降级为 null，不影响 dish 数据
      if (routerResult.status === 'fulfilled') {
        this.lastRouterProbe = routerResult.value;
      } else {
        console.warn('[Collector] Router 探测失败:', routerResult.reason);
        this.lastRouterProbe = null;
      }
      
      // 补充公网 Ping 延迟
      if (publicProbeResult.status === 'fulfilled' && publicProbeResult.value?.ok) {
        telemetry.publicPingLatencyMs = publicProbeResult.value.rttMs ?? undefined;
      } else if (publicProbeResult.status === 'rejected') {
        console.warn('[Collector] 公网探针失败:', publicProbeResult.reason);
      }
      
      // 补充本地网关延迟
      if (localGatewayResult.status === 'fulfilled' && localGatewayResult.value?.ok) {
        telemetry.localGatewayLatencyMs = localGatewayResult.value.rttMs ?? undefined;
      } else if (localGatewayResult.status === 'rejected') {
        console.warn('[Collector] 本地网关探测失败:', localGatewayResult.reason);
      }
      
      // 处理卫星切换分析结果
      if (handoffResult.status === 'fulfilled' && handoffResult.value) {
        const newHandoffs = handoffResult.value;
        if (newHandoffs.length > 0) {
          this.handoffEvents.push(...newHandoffs);
          this.stats.handoffCount += newHandoffs.length;
          this.stats.lastHandoffTime = new Date(newHandoffs[newHandoffs.length - 1].timestamp);
          
          // 发送卫星切换事件
          this.emit('handoffs', newHandoffs);
          
          console.log(`[Collector] 检测到 ${newHandoffs.length} 次卫星切换`);
          
          // 写入数据库
          if (this.store) {
            try {
              this.store.appendHandoffs(
                newHandoffs.map(h => ({
                  timestamp: h.timestamp,
                  durationMs: h.durationMs,
                  cause: h.cause,
                  parsedCause: h.parsedCause,
                  isExplicit: h.isExplicit,
                }))
              );
            } catch (error) {
              console.error('[Collector] 写入卫星切换事件失败:', error);
            }
          }
        }
      } else if (handoffResult.status === 'rejected') {
        console.warn('[Collector] 卫星切换分析失败:', handoffResult.reason);
      }
      
      // 添加时间戳
      const dataPoint = {
        ...telemetry,
        timestamp: new Date(),
      } as TelemetryData & { timestamp: Date };

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

      // 日志输出：包含路由器探测结果
      const routerInfo = this.lastRouterProbe 
        ? `router=${this.lastRouterProbe.reachable ? 'up' : 'down'}, rtt=${this.lastRouterProbe.rttMs?.toFixed(1) ?? 'N/A'}ms` 
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
    
    // 更新 dish 客户端配置
    if (config.dishAddress || config.dishPort) {
      this.client.updateConfig({
        address: this.config.dishAddress,
        grpcPort: this.config.dishPort,
      });
    }
    
    // 更新 router 探测配置
    if (config.routerAddress) {
      this.routerProbe.updateConfig({
        address: this.config.routerAddress,
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

  /**
   * 探测公网延迟（从配置的探针节点中选择 type=icmp 且 enabled=true 的首个节点）
   */
  private async probePublicLatency() {
    if (!this.config.probeNodes || this.config.probeNodes.length === 0) {
      console.warn('[Collector] probeNodes 配置为空，跳过公网延迟采集');
      return null;
    }
    
    // 找第一个启用的 ICMP 探针节点
    const publicNode = this.config.probeNodes.find(
      n => n.type === 'icmp' && n.enabled && n.id !== 'local-gateway'
    );
    
    if (!publicNode) {
      console.warn('[Collector] 未找到启用的公网 ICMP 探针节点');
      return null;
    }
    
    try {
      return await runProbe(publicNode);
    } catch (error) {
      console.warn('[Collector] 公网探针执行失败:', error);
      return null;
    }
  }

  /**
   * 分析卫星切换事件（从 dishGetHistory 的 outages 中提取）
   * 
   * 返回自上次分析以来新增的切换事件，避免重复计数
   */
  private async analyzeHandoffs(): Promise<HandoffEvent[]> {
    try {
      // 通过 DishClient 获取 gRPC 客户端
      const grpc = this.client.getGrpcClient();
      if (!grpc) {
        // gRPC 客户端未初始化（首次采集前）
        return [];
      }
      
      const history = await grpc.getHistory(8000);
      const currentTimestamp = history.currentTimestamp as number | undefined;
      const outages = history.outages as Outage[] | undefined;
      
      if (!currentTimestamp || !Array.isArray(outages) || outages.length === 0) {
        return [];
      }
      
      // 如果 currentTimestamp 没变，说明没有新数据
      if (currentTimestamp <= this.lastHistoryTimestamp) {
        return [];
      }
      
      // 分析所有 outages
      const analysis = analyzeOutages(outages);
      
      // 只返回新增的切换事件（timestamp > lastHistoryTimestamp）
      const newHandoffs = analysis.handoffs.filter(
        h => h.timestamp > this.lastHistoryTimestamp * 1000
      );
      
      // 更新时间戳
      this.lastHistoryTimestamp = currentTimestamp;
      
      // 输出分析摘要
      if (newHandoffs.length > 0) {
        const summary = summarizeOutageAnalysis(analysis);
        console.log(`[Collector] Outage 分析: ${summary}`);
      }
      
      return newHandoffs;
    } catch (error) {
      // getHistory 失败不影响主采集流程
      console.warn('[Collector] getHistory 失败:', error instanceof Error ? error.message : error);
      return [];
    }
  }

  /**
   * 获取最近一次路由器探测结果
   */
  getRouterProbeResult(): RouterProbeResult | null {
    return this.lastRouterProbe;
  }
  
  /**
   * 获取检测到的卫星切换事件
   * 
   * @param seconds 时间范围（秒），默认 3600（1小时）
   * @returns 时间范围内的切换事件
   */
  getHandoffEvents(seconds = 3600): HandoffEvent[] {
    const cutoff = Date.now() - seconds * 1000;
    return this.handoffEvents.filter(h => h.timestamp >= cutoff);
  }
  
  /**
   * 清空卫星切换事件缓存
   */
  clearHandoffEvents(): void {
    this.handoffEvents = [];
    this.stats.handoffCount = 0;
    this.stats.lastHandoffTime = null;
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