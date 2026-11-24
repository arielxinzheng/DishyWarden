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
import { runProbe, isProbeFresh, type ProbeResult } from '../core/probeRunner';
import { localGatewayNode, LOCAL_GATEWAY_NODE_ID } from '../core/defaultGateway';
import type { ProbeNodeConfig } from '../config/manager';
import { analyzeOutages, summarizeOutageAnalysis, type HandoffEvent } from '../core/outageAnalyzer';
import { estimateClockAnchor, isRtcReset, type ClockAnchor } from '../core/dishClock';
import type { Outage } from '../core/outageTypes';

export interface CollectorConfig {
  interval: number;           // 采集间隔（毫秒）
  bufferSize: number;         // 内存缓冲区大小（数据点数量）
  dishAddress?: string;       // Dish 地址（真机默认 192.168.100.1）
  dishPort?: number;          // Dish 原生 gRPC 端口（9200）
  dishWebPort?: number;       // Dish grpc-web 端口（9201，原生不通时的兜底）
  descriptorCachePath?: string; // proto 描述符磁盘缓存路径（跨重启保留）
  routerAddress?: string;     // Router 地址（真机默认 192.168.1.1，用于 ICMP Ping 探测）
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
  /** 是否有一轮采集正在跑（防止 setInterval 叠加） */
  private collecting = false;
  private isRunning = false;
  private startTime: Date | null = null;
  /** 历史库。打不开时降级为 null, 采集与实时推送不受影响。 */
  private store: TelemetryStore | null = null;
  /** 最近一次路由器探测结果 */
  private lastRouterProbe: RouterProbeResult | null = null;
  /**
   * 本地网关延迟的测量来源（由 `main` 注入 `ProbeRunner` 的实时状态）。
   *
   * 为什么不让 collector 自己测：同一件事两套实现时，
   * 一边失败会被另一边掩盖 —— 设置页状态灯是绿的（ProbeRunner 有结果），
   * 图表却是空的（collector 自己那条路径静默失败）。收敛成一条后
   * 「UI 显示什么」和「库里存什么」必然一致。
   */
  private gatewayProbeSource: (() => ProbeResult | null) | null = null;
  /**
   * 注入的探针结果最多可以「旧」多久（毫秒）。
   *
   * 为什么必须校验时效：`local-gateway` 节点被用户禁用、或探针循环卡死时，
   * `ProbeRunner.getState().last` 会永久停留在最后一次结果上。不校验就会
   * 每轮把**同一个旧 RTT 当成新测量**写进库 —— 图表显示「网关延迟正常」，
   * 实际早已不再测量。这比写 null 更有害：null 至少是诚实的空缺。
   *
   * 默认 90 秒 = 3 个探针周期（`local-gateway` intervalSec=30），
   * 容忍一次丢拍加一轮调度偏移；采集周期与之相同，正常情况不会误判。
   */
  private readonly gatewayProbeMaxAgeMs = 90_000;
  /** 网关探测失败日志限流: 同一原因 N 毫秒内只打一次, 避免每 30 秒刷屏 */
  private lastGatewayWarnMs = 0;
  private lastGatewayWarnReason = '';
  /**
   * 已处理过的最大设备时钟读数（rtc_ms），用于挑出「本轮新增」的切换事件。
   *
   * ⚠️ 水位线必须建在 **rtc** 上，不能建在换算后的 ts 上：ts 会随着锚点
   * 校准整体平移，拿它当水位线会漏事件或重复计数。rtc 是设备自己的读数，
   * 单调递增，与锚点无关。
   *
   * ⚠️ 设备重启会让 rtc 跳回更早的基准，此时水位线必须归零（判据与锚点
   * 重置共用 `isRtcReset`）—— 否则重启后的事件全都小于旧水位线，会被
   * 当成「早就处理过」永久吞掉：库里一行没有，仪表盘上一条标记都不出现，
   * 而且没有任何报错。
   */
  private lastRtcMs = 0;
  /**
   * 设备时钟锚点（`null` = 设备时钟可信，不做换算）。
   *
   * 每轮由 `estimateClockAnchor` 推进：设备报的是错的时间戳（真机落后约 10 年），
   * 必须把它搬回 host 时间轴，否则事件永远落在查询窗口之外，仪表盘一条都不显示。
   * 锚点的推进规则与理由见 `src/core/dishClock.ts` 开篇。
   */
  private clockAnchor: ClockAnchor | null = null;
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
      dishAddress: config.dishAddress || '192.168.100.1',
      dishPort: config.dishPort || 9200,
      dishWebPort: config.dishWebPort || 9201,
      descriptorCachePath: config.descriptorCachePath || '',
      routerAddress: config.routerAddress || '192.168.1.1',
      enablePersistence: config.enablePersistence ?? true,
      dataDir: config.dataDir || '', // 空 = 使用 app.getPath('userData')/data
      probeNodes: config.probeNodes || [],
    };

    this.client = new DishClient({
      address: this.config.dishAddress,
      grpcPort: this.config.dishPort,
      grpcWebPort: this.config.dishWebPort,
      descriptorCachePath: this.config.descriptorCachePath,
      fallbackToMock: false,  // 禁用 mock 回退，连接失败时直接报错
    });

    console.log(
      `[Collector] Dish 连接配置: ${this.config.dishAddress}:${this.config.dishPort}` +
      ` (原生 gRPC / reflection) + :${this.config.dishWebPort} (grpc-web 兜底)`,
    );

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
    // ⚠️ **上一轮采集还没结束就不要再开一轮**。
    // 旧代码用 setInterval 无条件开新轮：上一轮的 gRPC 调用超时后仍在飞，
    // 下一轮又发起新的 ⇒ 在飞的调用越积越多，最终把连接池/事件循环压垮，
    // 表现为"数据已 N 分钟未更新"（而且日志里看不到明确的失败原因）。
    if (this.collecting) {
      console.warn('[Collector] 上一轮采集未结束，跳过本轮');
      return;
    }
    this.collecting = true;

    try {
      // 超时保护。grpc-web 走 HTTP/1.1 往返，叠加首次反射拉取，
      // 10 秒偏紧 —— 慢一点会误杀正常采集。放宽到 20 秒。
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Starlink 设备连接超时 (20s)')), 20000)
      );
      
      // 并行采集 dish 遥测、router 探活、公网探针、本地网关、history（包含 outages）
      const collectPromise = Promise.allSettled([
        this.client.getTelemetry(),
        this.routerProbe.probe(),
        this.probePublicLatency(),
        this.readLocalGatewayProbe(), // 探针模块的实时结果, 不可用时自己测
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
      //
      // ⚠️ 失败必须留下日志。旧实现只在 promise **reject** 时 warn,
      //    而「探测完成了但没测到」走的是 fulfilled + ok:false ——
      //    那条分支静默写 null。表现就是：探针日志一切正常、图表该列全空、
      //    日志里一个字都没有。现场无法自证, 只能靠翻代码。
      if (localGatewayResult.status === 'fulfilled') {
        const probe = localGatewayResult.value;
        if (probe?.ok && typeof probe.rttMs === 'number') {
          telemetry.localGatewayLatencyMs = probe.rttMs;
        } else {
          this.warnGatewayProbe(probe?.error ?? '网关探测未返回结果');
        }
      } else {
        const reason = localGatewayResult.reason;
        this.warnGatewayProbe(reason instanceof Error ? reason.message : String(reason));
      }
      
      // 处理卫星切换分析结果
      //
      // 落库与内存镜像已在 `analyzeHandoffs()` 内部完成（见其注释），
      // 这里只负责统计、事件推送与日志 —— 职责分开，避免两处都以为对方在写。
      if (handoffResult.status === 'fulfilled' && handoffResult.value) {
        const newHandoffs = handoffResult.value;
        if (newHandoffs.length > 0) {
          this.stats.handoffCount += newHandoffs.length;
          this.stats.lastHandoffTime = new Date(newHandoffs[newHandoffs.length - 1].timestamp);

          // 发送卫星切换事件
          this.emit('handoffs', newHandoffs);

          console.log(`[Collector] 检测到 ${newHandoffs.length} 次卫星切换`);
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
    } finally {
      // ⚠️ 必须在这里清标记 —— 超时抛错时 collectPromise 仍在飞，
      // 但**下一轮不能因为它还在飞就永远跳过**（那会让采集彻底停摆）。
      this.collecting = false;
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
   * 查询区间内的卫星切换事件。
   *
   * 供渲染层在「延迟与丢包走势」图上标注切换点。
   *
   * @param seconds 时间窗口(秒)
   */
  getHandoffs(seconds: number): HandoffEvent[] {
    const now = Date.now();
    const fromMs = now - seconds * 1000;

    if (this.store) {
      try {
        return this.store.queryHandoffs(fromMs, now, 500);
      } catch (error) {
        console.error('[Collector] 查询卫星切换事件失败, 回落内存缓冲:', error);
      }
    }

    // 回落: 从内存里的 handoff 事件缓冲取
    return this.handoffEvents
      .filter((h) => h.timestamp >= fromMs)
      .map((h) => ({
        rtcMs: h.rtcMs,
        timestamp: h.timestamp,
        durationMs: h.durationMs,
        cause: h.cause,
        parsedCause: h.parsedCause,
        isExplicit: h.isExplicit,
      }));
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
    // 把采集间隔传给 summarize：流量按样本间隔计，间隔封顶 2×标称。
    return this.store?.summarize(now - seconds * 1000, now, this.config.interval / 1000) ?? null;
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
    if (config.dishAddress || config.dishPort || config.dishWebPort) {
      this.client.updateConfig({
        address: this.config.dishAddress,
        grpcPort: this.config.dishPort,
        grpcWebPort: this.config.dishWebPort,
        descriptorCachePath: this.config.descriptorCachePath,
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
    
    // 找第一个启用的 ICMP 探针节点（排除网关节点：它不是公网目标）
    const publicNode = this.config.probeNodes.find(
      n => n.type === 'icmp' && n.enabled && n.id !== LOCAL_GATEWAY_NODE_ID
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
   * 分析卫星切换事件（从 dishGetHistory 的 outages 中提取）。
   *
   * 这个方法干了三件事，顺序不能换：
   *   1. 用当前锚点把设备时钟换算成 host 时间（`analyzeOutages`）
   *   2. 把整窗事件镜像写库（rtc 作主键 ⇒ 幂等，锚点变准后重写即纠偏）
   *   3. 推进时钟锚点（本轮最新事件 = 一个新的时钟观测）
   *
   * 返回值只含**本轮新增**的事件（rtc 水位线），供统计与事件推送用；
   * 落库与内存镜像都在方法内部完成，调用方不需要再管。
   */
  private async analyzeHandoffs(): Promise<HandoffEvent[]> {
    try {
      // 通过 DishClient 获取 gRPC 客户端
      const grpc = this.client.getGrpcClient();
      if (!grpc) {
        // gRPC 客户端未初始化（首次采集前）
        return [];
      }

      // 与 getTelemetry() 共享同一次 history 拉取（22KB，避免每轮拉两次）
      const history = await this.client.getHistoryResponse(8000);
      const outages = Array.isArray(history.outages) ? (history.outages as Outage[]) : [];

      // 分析所有 outages
      //
      // 用**上一轮**留下的锚点做换算。真机 RTC 可能是错的（实测报 2016 年），
      // 不换算的话事件永远落在查询窗口之外，仪表盘一条都显示不出来。
      //
      // 本轮观测到的最新事件其实可以立刻用来重算锚点，但那样要先算出最新
      // 事件再回头转换，等于分析两遍。这里选择「先转换、后推进」：代价是
      // 锚点改进后要下一轮才生效（晚 30 秒），而写入是幂等的（rtc 为身份），
      // 下一轮重写同一批行时 ts 自然就纠正了。锚点规则见 `dishClock.ts`。
      const analysis = analyzeOutages(outages, { anchor: this.clockAnchor });

      // 发出非切换类的 outage 事件（供告警系统使用）
      //
      // ⚠️ **无论有没有事件都要 emit** ——
      //   告警的生命周期需要"条件不成立"这个信号才能 resolve。
      //   如果只在有事件时才 emit, 那么当 NO_SCHEDULE 彻底消失后
      //   (场景关闭 / 设备恢复), 告警会永远停在 ongoing。
      //
      //   注意: `outages` 为空数组时也**必须**走到这里。
      //   这里原本有个 `if (outages.length === 0) return []` 的早退,
      //   等于把"本轮没有任何中断"这个事实整个吞掉 —— 设备恢复正常后
      //   `checkOutages()` 永远收不到"现在没有 NO_SCHEDULE"的信号,
      //   告警卡在 ongoing（它的生命周期已被 `managedBy: 'outages'`
      //   从遥测侧摘走, 没有第二条恢复路径）。
      //   `analyzeOutages([])` 返回空结果, 下面的 handoffs 分支自然会早退。
      //
      //   传的是**本轮看到的全部 otherOutages**(含历史的),
      //   不是只有新增的 —— 让 `checkOutages()` 能看到
      //   "现在还有没有 NO_SCHEDULE", 从而决定触发还是恢复。
      //
      //   采集侧对 handoff 用水位线过滤只是为了避免重复写同一条,
      //   告警侧自己按 alert_key 去重, 不依赖这里。
      this.emit('outages', analysis.otherOutages);

      // 推进设备时钟锚点。
      //
      // 本轮的最新事件（不限切换，任何 outage 都是一个时钟观测）发生在上一次
      // 采集之后、这次采集之前 ⇒ 它对应的 host 时刻就是「现在」，误差一个采集周期。
      // 这是唯一能给出真实时刻的观测，`estimateClockAnchor` 会把它标成 observed。
      //
      // 没有事件时 newestRtcMs = 0，估计器会沿用旧锚（不会退回「设备时钟可信」，
      // 否则下一轮会重新用 assumed 把已经测准的锚点覆盖掉）。
      const nextAnchor = estimateClockAnchor(
        this.clockAnchor,
        analysis.newestRtcMs || null,
        Date.now(),
      );
      if (nextAnchor !== this.clockAnchor) {
        this.clockAnchor = nextAnchor;
        console.log(
          nextAnchor
            ? `[Collector] 设备时钟锚点更新: source=${nextAnchor.source} ` +
                `offset=${nextAnchor.hostMs - nextAnchor.deviceMs}ms ` +
                `精度±${Math.round(nextAnchor.uncertaintyMs)}ms`
            : '[Collector] 设备时钟可信，取消偏移修正',
        );
      }

      // 整窗镜像写入。
      //
      // 灌进去的是**本轮设备 history 窗口里的全部切换事件**，不是只有新增的：
      // rtc_ms 是主键，重复写只覆盖同一行，所以幂等；而锚点变准之后，
      // 同一条事件的 ts 会算出新值，只有整体重写才能把库里已存的行纠正过来。
      // 事件滚出设备窗口后就不再被重写 —— 那时它的 ts 已经稳定，无需再纠。
      if (this.store && analysis.handoffs.length > 0) {
        try {
          this.store.upsertHandoffs(analysis.handoffs);
        } catch (error) {
          console.error('[Collector] 写入卫星切换事件失败:', error);
        }
      }

      // 内存缓存也整窗替换，与库保持一致（原来的写法是无限 append，
      // 内存里会一直攒着重启以来的全部事件）。
      this.handoffEvents = analysis.handoffs;

      // 挑出「本轮新增」的切换事件，只用于统计与事件推送。
      //
      // ⚠️ 水位线必须建在 rtc 上，不能建在换算后的 ts 上：ts 会随着锚点
      // 校准整体平移，拿它当水位线会漏事件（锚点往前挪）或重复计数（往后挪）。
      //
      // 设备重启后 rtc 从另一个基准重新计时，旧水位线作废 ⇒ 下界归零，
      // 整窗事件都算新增（重启后设备 history 也是空的，它们确实都是新的）。
      // 判据与时钟锚点共用 `isRtcReset`，两边不会各自漂移。
      const rtcReset = isRtcReset(this.lastRtcMs || null, analysis.newestRtcMs);
      const watermarkFloor = rtcReset ? 0 : this.lastRtcMs;
      const newHandoffs = analysis.handoffs.filter((h) => h.rtcMs > watermarkFloor);
      if (analysis.newestRtcMs > this.lastRtcMs || rtcReset) {
        this.lastRtcMs = analysis.newestRtcMs;
      }

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
   * 注入「本地网关延迟」的测量来源。
   *
   * 传入 `() => probeRunner.getState('local-gateway')?.last ?? null`。
   * 探针模块是常规测量者（每 30 秒一次，独立于采集周期），
   * collector 只负责把那份结果记进历史库。
   *
   * 注入的只是**读数**；时效校验走 `isProbeFresh`（定义在 probeRunner，
   * 和「什么叫一次测量」放在一起），门限值由本类提供（见 `gatewayProbeMaxAgeMs`）：
   * 采集节奏决定了多旧算旧，所以门限留在消费方，判定逻辑留在生产者。
   */
  setGatewayProbeSource(fn: (() => ProbeResult | null) | null): void {
    this.gatewayProbeSource = fn;
  }

  /**
   * 网关测不到时的告警日志（限流）。
   *
   * 5 分钟内同一原因只打一次：网关真挂了会每 30 秒失败一次，
   * 不限流会把整份日志淹掉，反而让真正的问题看不见。
   */
  private warnGatewayProbe(reason?: string): void {
    const text = reason?.trim() || '未知原因';
    const now = Date.now();
    if (text === this.lastGatewayWarnReason && now - this.lastGatewayWarnMs < 5 * 60 * 1000) {
      return;
    }
    this.lastGatewayWarnMs = now;
    this.lastGatewayWarnReason = text;
    console.warn(`[Collector] 本地网关延迟不可用（${text}），该列将写入 null`);
  }

  /**
   * 取一次本地网关探测结果。
   *
   * 三级取值，越靠前越优先：
   * 1. 探针模块的实时状态（常规路径，与设置页状态灯同源）
   * 2. 探针状态存在但**已过期** —— 丢弃，转 3
   * 3. 自己测一次兜底（CLI / 单测 / 启动最早那一轮）
   *
   * 无论走哪条，失败都会经 `warnGatewayProbe` 留下限流日志。
   */
  private async readLocalGatewayProbe(): Promise<ProbeResult> {
    const injected = this.gatewayProbeSource?.() ?? null;
    if (isProbeFresh(injected, this.gatewayProbeMaxAgeMs)) {
      // isProbeFresh 为真 ⇒ injected 非 null
      return injected as ProbeResult;
    }
    return runProbe(localGatewayNode(5));
  }

  /**
   * 获取最近一次路由器探测结果
   */
  getRouterProbeResult(): RouterProbeResult | null {
    return this.lastRouterProbe;
  }

  /** 读 dish 自带 GPS 的位置（设置页用；失败直接抛，原因交给界面） */
  getDishLocation(): ReturnType<DishClient['getDishLocation']> {
    return this.client.getDishLocation();
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