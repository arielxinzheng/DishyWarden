/**
 * Starlink Dish gRPC 客户端
 *
 * 基于 @connectrpc/connect-web 实现与 Starlink 终端的 gRPC-Web 通信
 * 参考 dishylink 的实现，处理 CORS 和 Referer 头限制
 */

import { createConnectTransport } from '@connectrpc/connect-web';
import { DishGrpcClient } from './dishGrpc';

/**
 * 把「可能是数字」的值解析成 number，解析不出来返回 undefined。
 *
 * ## 为什么不能复用 parseStatus 里的 num()
 *
 * `num()` 会把解析失败兜成 **0**，而 **0 是一个完全合法的方位角（正北）**。
 * 期望朝向一旦被兜成 0，「设备没上报推荐朝向」就变成了「推荐正北」——
 * 校准页会拿 0° 当目标算偏差，在天线实际指向 135° 时给出
 * 「向西旋转 135°」这种**错误引导**；同时「无期望值」这条分支永远走不到。
 *
 * 所以这里必须能表达「没有值」。proto loader 用的是 `defaults: false`
 * （见 `dishGrpc.ts`），设备不报的字段根本不会出现在响应里，
 * 所以「缺失」与「上报了 0」是能分开的。
 */
export function parseFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export interface DishConfig {
  address: string;      // dish 地址，默认 192.168.100.1
  grpcPort: number;     // 原生 gRPC 端口，默认 9200
  grpcWebPort?: number; // grpc-web 兜底端口，默认 9201（9200 不吃请求时用）
  /**
   * proto 描述符的磁盘缓存路径。
   *
   * reflection 只在 9200 上有，而 grpc-web(9201) 兜底需要描述符才能编解码。
   * 9200 不可达时没有缓存就彻底瘫痪 ⇒ 描述符要落盘，跨重启也能用。
   */
  descriptorCachePath?: string;
  timeout?: number;     // 请求超时（毫秒），默认 10000
  useProxy?: boolean;   // 是否使用代理绕过 CORS
  proxyUrl?: string;    // 代理服务器地址
  /**
   * 设备不可达时是否回落到模拟数据。
   *
   * 默认 false —— 监控软件宁可报"采不到数", 也不能把随机数当成设备实测值。
   * 打开后 mock 数据会带 obstructionMapSource:'mock', 界面会明确标注。
   */
  fallbackToMock?: boolean;
}

/**
 * dish_get_history 响应里的一组 1Hz 数组，取**最新一个样本**。
 *
 * 真机实测（dishylink LOCAL-API.md）：
 *   dish_get_history = 900 样本 × 1 Hz 的环形缓冲（约 15 分钟），
 *   里面才有真正的丢包率/延迟/吞吐数值；dish_get_status 那些字段可能一直是空的。
 */
export interface HistorySample {
  dropRate?: number;
  latencyMs?: number;
  downlinkBps?: number;
  uplinkBps?: number;
}

/**
 * 从 history 响应里取**最新**样本。
 *
 * ⚠️ history 的数组是**环形缓冲**，最新样本**不在末尾**！
 * dishylink 的 decodeHistoryWindow 写得很清楚：
 *   "each array holds the last `arrayLength` samples at one sample per second,
 *    where absolute sample counter `c` lives at index `c % arrayLength`"
 * ⇒ 最新样本的绝对计数器是 `current - 1` ⇒ 下标 `(current - 1) % arrayLength`。
 *
 * 取末尾元素在缓冲**绕回之后**（current > 数组长度）会拿到旧样本 ⇒ 指标错乱。
 * 没有 `current`（刚启动/字段缺失）时退回末尾取法。
 */
export function latestHistorySample(history: Record<string, unknown>): HistorySample | undefined {
  // 绝对样本计数器（自启动以来写入的样本数）
  const currentRaw = history.current;
  const current =
    typeof currentRaw === 'number' && Number.isFinite(currentRaw)
      ? currentRaw
      : typeof currentRaw === 'string' && currentRaw.trim() !== ''
        ? Number(currentRaw)
        : 0;

  // 用 latency 数组的长度作为环形缓冲的基准（各数组是平行的）
  const latencies = history.popPingLatencyMs;
  const arrayLength = Array.isArray(latencies) ? latencies.length : 0;
  const ringIndex = arrayLength > 0 && current > 0 ? (current - 1) % arrayLength : -1;

  const last = (v: unknown): number | undefined => {
    if (!Array.isArray(v) || v.length === 0) return undefined;
    const idx = ringIndex >= 0 && ringIndex < v.length ? ringIndex : v.length - 1;
    const lastVal = v[idx];
    if (typeof lastVal === 'number' && Number.isFinite(lastVal)) return lastVal;
    if (typeof lastVal === 'string' && lastVal.trim() !== '') {
      const n = Number(lastVal);
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  };
  const sample: HistorySample = {
    dropRate: last(history.popPingDropRate),
    latencyMs: last(history.popPingLatencyMs),
    downlinkBps: last(history.downlinkThroughputBps),
    uplinkBps: last(history.uplinkThroughputBps),
  };
  return Object.values(sample).some((v) => v !== undefined) ? sample : undefined;
}

export interface TelemetryData {
  // 连接状态
  state: 'ONLINE' | 'OFFLINE' | 'SEARCHING' | 'BOOTING';
  uptime: number;
  
  // 网络指标
  popPingLatencyMs: number;
  popPingDropRate: number;
  downlinkThroughputBps: number;
  uplinkThroughputBps: number;
  
  // 额外延迟指标（由采集器补充）
  publicPingLatencyMs?: number;      // 公网 Ping 延迟（探针节点 ICMP）
  localGatewayLatencyMs?: number;    // 本地网关延迟（默认网关 ICMP）
  
  // 信号质量
  snr: number;
  secondsObstructed: number;
  fractionObstructed: number;
  currentlyObstructed: boolean;
  
  // 卫星信息
  satelliteId: number;
  secondsToFirstNonemptySlot: number;
  
  // 障碍图 (123x123 网格)
  obstructionMap?: number[][];
  /**
   * 遮挡图的数据来源标记。
   *
   * 'real'  —— 来自 dish 的 dishGetObstructionMap(1015) 真实星历
   * 'mock'  —— 本地模拟生成(径向渐变), 只用于开发演示
   *
   * 存在的意义: mock 图和真实图在视觉上几乎一样, 不标记的话用户无法分辨,
   * 会把演示数据当成设备实测结果 —— 这是监控软件最不该有的误导。
   */
  obstructionMapSource?: 'real' | 'mock';
  /** 遮挡图的采集时刻(epoch ms), 用于显示数据新鲜度 */
  obstructionMapTimestamp?: number;
  
  // 校准/对齐状态
  boresightAzimuthDeg?: number;      // 波束指向方位角（度）
  boresightElevationDeg?: number;    // 波束指向仰角（度）
  attitudeEstimationState?: string;  // 姿态估计状态
  tiltAngleDeg?: number;             // 倾斜角度（度）
  alignmentStats?: {
    validS?: boolean;                // 姿态有效性
    attitudeUncertaintyDeg?: number; // 姿态不确定度（度）
    desiredBoresightAzimuthDeg?: number;   // 期望方位角
    desiredBoresightElevationDeg?: number; // 期望仰角
  };
  
  // 硬件状态
  dishTemperature: number;
  powerSupplyTemperature: number;
  hardwareVersion: string;
  softwareVersion: string;
  
  // GPS/GNSS 定位状态
  gpsValid?: boolean;                    // GPS 定位是否有效
  gpsSats?: number;                      // 可见 GPS 卫星数量
  gpsConvergenceState?: string;          // PNT 滤波器收敛状态
  
  // 以太网状态
  ethSpeedMbps?: number;                 // 以太网协商速率 (Mbps)
  ethDuplex?: string;                    // 双工模式 (FULL/HALF)
  
  // 路由器状态
  connectedRouterCount?: number;         // 已连接的路由器数量
  
  // WiFi 状态（来自路由器的 WiFi 统计）
  wifiRssi?: number;                     // WiFi 信号强度 (dBm, 通常 -30 到 -90)
  wifiTxRate?: number;                   // WiFi 发送速率 (Mbps)
  wifiRxRate?: number;                   // WiFi 接收速率 (Mbps)
  wifiChannelUtilization?: number;       // 信道利用率 (0-1)
  wifiRetransmitRate?: number;           // 重传率 (0-1)
  wifiClientCount?: number;              // 连接的 WiFi 客户端数量
  
  // 告警
  //
  // ⚠️ 这是 dishGetStatus.alerts 的**对象结构**（布尔标志），不是字符串数组。
  //    历史上曾是 string[]，规则用 alerts.includes('xxx') 判断；
  //    改成对象后旧写法会抛 TypeError 并被告警引擎的 catch 吞掉 ⇒ 规则静默失效。
  //    统一用 `hasAlert(data, 'thermalThrottle')`（src/core/serviceState.ts）读。
  alerts?: {
    thermalThrottle?: boolean;
    motorsStow?: boolean;
    isHeating?: boolean;
    slowEthernetSpeeds?: boolean;
    connectivity?: boolean;
    installPending?: boolean;
    movingFastInHelloMobile?: boolean;
    unexpectedLocation?: boolean;
    [key: string]: boolean | undefined;
  };
  
  // 服务状态
  classOfService?: string;         // 服务等级: STANDARD, RESTRICTED, SUSPENDED, etc.
  disablementCode?: string;        // 禁用代码: NOT_ACTIVATED, SERVICE_RESTRICTED, ACCOUNT_SUSPENDED, etc.
  
  // 设备问题列表
  dishIssues?: Array<{
    type: string;                 // 问题类型: SERVICE_RESTRICTION, etc.
    [key: string]: unknown;
  }>;
}

/**
 * 创建自定义 gRPC-Web transport
 * 处理 Starlink dish 的 CORS 和 Referer 限制
 *
 * 导出而非内部私有: 真实 gRPC 接入时由调用方注入, 现在先作为可复用的构造器保留。
 */
export function createDishTransport(config: Required<DishConfig>) {
  const baseUrl = config.useProxy 
    ? config.proxyUrl 
    : `http://${config.address}:${config.grpcPort}`;

  return createConnectTransport({
    baseUrl,
    // 移除会导致请求失败的 header
    interceptors: [
      (next) => async (req) => {
        // 删除 Referer 和 Origin（Starlink dish 会拒绝带这些头的请求）
        const headers = new Headers(req.header);
        headers.delete('referer');
        headers.delete('origin');
        
        return next({
          ...req,
          header: headers,
        });
      },
    ],
  });
}

/**
 * Starlink Dish 客户端
 */
export class DishClient {
  private config: Required<DishConfig>;
  // private client: PromiseClient<DishService>; // 等 protobuf 生成后启用

  /** 真实 gRPC 通道 (reflection 取 proto, 见 dishGrpc.ts) */
  private grpc: DishGrpcClient | null = null;

  /** 遥测里没有的字段, 保留上一帧的值, 避免指标跳成 0 */
  private lastTelemetry: TelemetryData | null = null;

  /** 只提醒一次的 mock 地址标记（配置里还留着 127.0.0.1 时提醒一次） */
  private warnedMockAddress = false;

  /** WiFi mock 周期计数器（用于模拟信号强度周期性变化） */
  private wifiMockCycle = 0;

  constructor(config: Partial<DishConfig> = {}) {
    this.config = {
      address: config.address || '192.168.100.1',
      grpcPort: config.grpcPort || 9200,
      grpcWebPort: config.grpcWebPort || 9201,
      descriptorCachePath: config.descriptorCachePath ?? '',
      timeout: config.timeout || 10000,
      useProxy: config.useProxy || false,
      proxyUrl: config.proxyUrl || 'http://localhost:8080',
      fallbackToMock: config.fallbackToMock ?? false,
    };
    
    // const transport = createDishTransport(this.config);
    // this.client = createPromiseClient(DishService, transport);
  }
  
  /**
   * 测试连接
   */
  async testConnection(): Promise<boolean> {
    // 真实 gRPC 通道探活 —— 比 /healthz 更贴近实际数据通路
    // (dish 的 9200 端口只讲 gRPC, 拿 HTTP 打过去必然失败)
    if (!this.grpc) {
      this.grpc = new DishGrpcClient(
        this.config.address,
        this.config.grpcPort,
        this.config.grpcWebPort,
        this.config.descriptorCachePath,
      );
    }
    try {
      await this.grpc.getStatus(this.config.timeout);
      return true;
    } catch (error) {
      console.error('[dishClient] 连接测试失败:', error instanceof Error ? error.message : error);
      return false;
    }
  }
  
  /**
   * 获取遥测数据
   * 
   * 走真实 gRPC: dishGetStatus(1000) + dishGetObstructionMap(1015)。
   * 遮挡图失败不拖垮整帧 —— 遥测仍然可用, 只是没有遮挡图。
   */
  async getTelemetry(): Promise<TelemetryData> {
    if (!this.grpc) {
      this.grpc = new DishGrpcClient(
        this.config.address,
        this.config.grpcPort,
        this.config.grpcWebPort,
        this.config.descriptorCachePath,
      );
    }

    // 旧安装的配置里可能还留着 DishyMock 的 127.0.0.1。
    // **不做破坏性迁移**（有人可能真在用本地 mock），只提醒一次。
    if (this.config.address === '127.0.0.1' && !this.warnedMockAddress) {
      this.warnedMockAddress = true;
      console.warn(
        '[dishClient] 配置里的设备地址还是 DishyMock 的 127.0.0.1；' +
        '接真机请改成 192.168.100.1（端口 9200，必要时用 grpc-web 9201）',
      );
    }

    try {
      const status = await this.grpc.getStatus(this.config.timeout);

      // 真机实测（dishylink LOCAL-API.md）：dish_get_status 的数值字段在某些固件上
      // **存在但永远不填**（pop_ping_drop_rate / power_in 等），真值在
      // dish_get_history 的 1Hz 数组里。所以再拉一次 history 取最新样本补齐。
      let historySample: HistorySample | undefined;
      try {
        const history = await this.grpc.getHistory(this.config.timeout);
        historySample = latestHistorySample(history);
      } catch (error) {
        console.warn('[dishClient] history 获取失败, 数值指标可能缺失:', error);
      }

      const telemetry = this.parseStatus(status, historySample);

      // 遮挡图单独取 —— 失败只丢遮挡图, 不影响其它遥测
      try {
        const map = await this.grpc.getObstructionMap(this.config.timeout);
        telemetry.obstructionMap = map.data;
        telemetry.obstructionMapSource = 'real';
        telemetry.obstructionMapTimestamp = Date.now();
        // SNR 的真实值在遮挡图的 snr 数组里 (dishGetStatus 只给布尔量)
        if (map.avgSnr !== null) telemetry.snr = map.avgSnr;
      } catch (error) {
        console.warn('[dishClient] 遮挡图获取失败, 本帧不带遮挡图:', error);
        telemetry.obstructionMap = undefined;
        telemetry.obstructionMapSource = undefined;
        telemetry.obstructionMapTimestamp = undefined;
      }

      // 状态判定已不再依赖 SNR（见 deriveState 注释），因此这里无需复核。

      this.lastTelemetry = telemetry;
      return telemetry;
    } catch (error) {
      if (!this.config.fallbackToMock) throw error;
      console.warn('[dishClient] 设备不可达, 回落模拟数据 (fallbackToMock):', error);
      const mock = this.getMockTelemetry();
      this.lastTelemetry = mock;
      return mock;
    }
  }
  
  /**
   * 获取历史数据
   * 
   * @param _seconds 历史时长（秒）
   */
  async getHistory(_seconds: number = 3600): Promise<TelemetryData[]> {
    // TODO: 实现历史数据查询
    return [];
  }

  /**
   * 把 dishGetStatus 响应映射成 TelemetryData。
   *
   * 字段名来自 DishyMock 的 proto (keepCase:false ⇒ camelCase)。
   * 响应里没有的字段用上一帧的值兜底, 缺省 0。
   */
  private parseStatus(
    status: Record<string, unknown>,
    historySample?: HistorySample,
  ): TelemetryData {
    const prev = this.lastTelemetry;
    // int64 字段在 proto 里是 string (loader 用 longs:String) —— 这里统一转数字
    const num = (v: unknown, fallback = 0): number => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
      return fallback;
    };

    /**
     * 读**物理量**（丢包率 / SNR / 吞吐 / 温度 …）。
     *
     * ⚠️ 绝对不能沿用上一帧！proto loader 用的是 `defaults: false`
     * （见 dishGrpc.ts），**proto3 里等于默认值的字段根本不会出现在响应里** ——
     * 也就是说「丢包率 = 0」和「设备没上报这个字段」在线上是同一个样子。
     *
     * 曾经这里写的是 `num(status.popPingDropRate, prev?.popPingDropRate ?? 0)`：
     * 设备恢复健康、丢包率回到 0 之后，字段消失 ⇒ 沿用上一帧的 0.6
     * ⇒ `high_packet_loss` / `severe_weather` 永远成立 ⇒ **告警永远不消失**。
     * 实测就是这样：DishyMock 恢复全部告警后，DishyWarden 里两条告警
     * 的 occurrence_count 一路涨到 68，last_seen 一直刷新。
     *
     * 量值缺失即 0，这才是 proto3 的语义。
     */
    const gauge = (v: unknown): number => num(v, 0);

    const deviceInfo = (status.deviceInfo ?? {}) as Record<string, unknown>;
    const deviceState = (status.deviceState ?? {}) as Record<string, unknown>;
    const obstructionStats = (status.obstructionStats ?? {}) as Record<string, unknown>;
    const alignment = (status.alignmentStats ?? {}) as Record<string, unknown>;

    // dishGetStatus 不带 snr 数值, 只给 isSnrAboveNoiseFloor;
    // SNR 真实值在遮挡图的 snr 数组里 (见 getObstructionMap 的 avgSnr)
    const snr = gauge(status.snr);

    // 遮挡统计
    const currentlyObstructed = obstructionStats.currentlyObstructed === true;
    const fractionObstructed = gauge(obstructionStats.fractionObstructed);

    // 告警列表: dish 用 alerts 结构体, 保留原始对象结构
    const alertObj = (status.alerts ?? {}) as Record<string, unknown>;
    const alerts: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(alertObj)) {
      if (typeof v === 'boolean') {
        alerts[k] = v;
      } else if (v === true) {
        alerts[k] = true;
      }
    }

    // 服务状态
    const classOfService = typeof status.classOfService === 'string' 
      ? status.classOfService 
      : prev?.classOfService;
    
    const disablementCode = typeof status.disablementCode === 'string'
      ? status.disablementCode
      : prev?.disablementCode;
    
    // 设备问题列表
    const dishIssues = Array.isArray(status.dishIssues)
      ? (status.dishIssues as Array<Record<string, unknown>>).map(issue => ({
          type: typeof issue.type === 'string' ? issue.type : 'UNKNOWN',
          ...issue,
        }))
      : prev?.dishIssues;

    // 原始值
    // status 里的数值字段在部分真机固件上不填 ⇒ 缺失时用 history 的最新样本兜底
    const pick = (fromStatus: unknown, fromHistory: number | undefined): number => {
      if (typeof fromStatus === 'number' && Number.isFinite(fromStatus)) return fromStatus;
      if (typeof fromStatus === 'string' && fromStatus.trim() !== '') {
        const n = Number(fromStatus);
        if (Number.isFinite(n)) return n;
      }
      return fromHistory ?? 0;
    };
    const rawDropRate = pick(status.popPingDropRate, historySample?.dropRate);
    const downlinkBps = pick(status.downlinkThroughputBps, historySample?.downlinkBps);

    // 数据合理性检查：吞吐量高但丢包率 100% 是数据源异常
    // 当下行 > 50 Mbps 且丢包率 >= 95% 时，修正为 0
    const sanitizedDropRate = 
      downlinkBps > 50e6 && rawDropRate >= 0.95
        ? 0
        : rawDropRate;

    const telemetry: TelemetryData = {
      // 协议里没有 state 枚举 (DishyMock proto 明确注明"被测方全程不读"),
      // 所以连接状态只能从实际链路指标推导 —— 见 deriveState()
      state: 'SEARCHING',
      uptime: gauge(deviceState.uptimeS),

      popPingLatencyMs: pick(status.popPingLatencyMs, historySample?.latencyMs),
      popPingDropRate: sanitizedDropRate,
      downlinkThroughputBps: downlinkBps,
      uplinkThroughputBps: pick(status.uplinkThroughputBps, historySample?.uplinkBps),

      snr,
      secondsObstructed: gauge(obstructionStats.secondsObstructed),
      fractionObstructed,
      currentlyObstructed,

      satelliteId: gauge(status.satelliteId),
      secondsToFirstNonemptySlot: num(status.secondsToFirstNonemptySlot, 0),

      obstructionMap: prev?.obstructionMap,
      obstructionMapSource: prev?.obstructionMapSource,
      obstructionMapTimestamp: prev?.obstructionMapTimestamp,

      boresightAzimuthDeg: status.boresightAzimuthDeg === undefined ? prev?.boresightAzimuthDeg : gauge(status.boresightAzimuthDeg),
      boresightElevationDeg: status.boresightElevationDeg === undefined ? prev?.boresightElevationDeg : gauge(status.boresightElevationDeg),
      attitudeEstimationState:
        typeof alignment.attitudeEstimationState === 'string'
          ? alignment.attitudeEstimationState
          : prev?.attitudeEstimationState,
      tiltAngleDeg: gauge(alignment.tiltAngleDeg),
      alignmentStats: {
        validS: alignment.hasActuators !== undefined
          ? alignment.hasActuators === 'HAS_ACTUATORS_YES'
          : prev?.alignmentStats?.validS,
        attitudeUncertaintyDeg: gauge(alignment.attitudeUncertaintyDeg),
        desiredBoresightAzimuthDeg:
          parseFiniteNumber(alignment.desiredBoresightAzimuthDeg) ??
          prev?.alignmentStats?.desiredBoresightAzimuthDeg,
        desiredBoresightElevationDeg:
          parseFiniteNumber(alignment.desiredBoresightElevationDeg) ??
          prev?.alignmentStats?.desiredBoresightElevationDeg,
      },

      dishTemperature: gauge(deviceInfo.dishTemperature),
      powerSupplyTemperature: gauge(deviceInfo.powerSupplyTemperature),
      hardwareVersion:
        typeof deviceInfo.hardwareVersion === 'string'
          ? deviceInfo.hardwareVersion
          : prev?.hardwareVersion ?? '',
      softwareVersion:
        typeof deviceInfo.softwareVersion === 'string'
          ? deviceInfo.softwareVersion
          : prev?.softwareVersion ?? '',
      
      // GPS/GNSS 定位状态
      gpsValid: (status.gpsStats as Record<string, unknown> | undefined)?.gpsValid === true,
      gpsSats: gauge((status.gpsStats as Record<string, unknown> | undefined)?.gpsSats),
      gpsConvergenceState:
        typeof (status.gpsStats as Record<string, unknown> | undefined)?.pntFilterConvergenceState === 'string'
          ? String((status.gpsStats as Record<string, unknown> | undefined)?.pntFilterConvergenceState)
          : prev?.gpsConvergenceState,
      
      // 以太网状态
      ethSpeedMbps: gauge(status.ethSpeedMbps),
      ethDuplex:
        typeof status.ethDuplex === 'string'
          ? status.ethDuplex
          : prev?.ethDuplex,
      
      // 路由器状态
      connectedRouterCount: Array.isArray(status.connectedRouters)
        ? (status.connectedRouters as unknown[]).length
        : prev?.connectedRouterCount ?? 0,
      
      // WiFi 状态（从 wifiStats 或 connectedRouters 中的第一个路由器获取）
      wifiRssi: num(
        (status.wifiStats as Record<string, unknown> | undefined)?.rssi,
        prev?.wifiRssi
      ),
      wifiTxRate: num(
        (status.wifiStats as Record<string, unknown> | undefined)?.txRate,
        prev?.wifiTxRate
      ),
      wifiRxRate: num(
        (status.wifiStats as Record<string, unknown> | undefined)?.rxRate,
        prev?.wifiRxRate
      ),
      wifiChannelUtilization: num(
        (status.wifiStats as Record<string, unknown> | undefined)?.channelUtilization,
        prev?.wifiChannelUtilization
      ),
      wifiRetransmitRate: num(
        (status.wifiStats as Record<string, unknown> | undefined)?.retransmitRate,
        prev?.wifiRetransmitRate
      ),
      wifiClientCount: num(
        (status.wifiStats as Record<string, unknown> | undefined)?.clientCount,
        prev?.wifiClientCount ?? 0
      ),
      
      alerts,
      classOfService,
      disablementCode,
      dishIssues,
    };

    // 连接状态只看「有没有数据」，不看 SNR（质量指标不该否决连通性）
    telemetry.state = this.deriveState(status, telemetry);
    return telemetry;
  }

  /**
   * 推导连接状态。
   *
   * 协议里没有 state 枚举 —— dish 的 gRPC 只给底层指标,
   * 状态得自己判。判据按"能连上卫星"到"链路正常"的顺序:
   *
   *  - BOOTING   : 设备刚启动 (uptime 很小), 还没进入正常状态
   *  - OFFLINE   : 设备不可达 (这一层不会走到, 不可达时调用已经抛错了)
   *  - SEARCHING : 设备活着, 但没有有效链路 (无带宽 / 无 SNR / 无路由器)
   *  - ONLINE    : 有下行带宽, 且 SNR 高于噪声底
   *
   * 遮挡本身不算断线 —— dish 被遮挡时仍然有带宽, 只是吞吐下降。
   * 把"遮挡"直接判成 OFFLINE 会让在线率指标失真。
   */
  private deriveState(
    status: Record<string, unknown>,
    telemetry: TelemetryData
  ): TelemetryData['state'] {
    // 设备刚起来
    if (telemetry.uptime > 0 && telemetry.uptime < 60) {
      return 'BOOTING';
    }

    // 有下行吞吐 ⇒ 数据确实在流动 ⇒ 链路是通的。
    //
    // 注意: **不要再用 SNR 去否决连接状态**。SNR 是质量指标，不是连通性指标：
    // 恶劣天气下 SNR 掉到噪声底、`isSnrAboveNoiseFloor=false`，但下行仍有 140 Mbps，
    // 链路显然通着。上一版用 `snrOk || snr > 0` 兜底，而 current 固件的
    // dishGetStatus 压根没有 snr 字段（真实 SNR 在遮挡图里），于是这类场景
    // 被判成 SEARCHING ⇒ 误报「天线未连接」+「持续搜星」。
    const hasDownlink = telemetry.downlinkThroughputBps > 0;
    if (hasDownlink) {
      return 'ONLINE';
    }

    const hasRouter = Array.isArray(status.connectedRouters)
      ? (status.connectedRouters as unknown[]).length > 0
      : false;

    // 无下行但路由器还连着 ⇒ 天线在正常锁星，别升级成故障
    if (hasRouter) {
      return 'SEARCHING';
    }

    // 无下行、也看不到任何已连接路由器 —— 设备能应答 gRPC（否则这一帧根本
    // 拿不到 status），但对外什么都传不出来。这才是「离线」。
    // 开机早期已由 BOOTING 拦住，所以这里按 uptime 区分初装与真离线。
    return telemetry.uptime >= 60 ? 'OFFLINE' : 'SEARCHING';
  }

  
  /**
   * 模拟卫星切换: 真实 Starlink 约每 15s 交接一次, 这里用 2 分钟一轮,
   * 保证 30s 采样下能观察到切换, 又不会每个采样点都被判为新卫星
   */
  private nextMockSatelliteId(): number {
    const HANDOVER_MS = 120_000;
    return 2000 + (Math.floor(Date.now() / HANDOVER_MS) % 137);
  }

  /**
   * 模拟数据（用于开发阶段）
   */
  private getMockTelemetry(): TelemetryData {
    return {
      state: 'ONLINE',
      uptime: 86400,
      popPingLatencyMs: 45 + Math.random() * 10,
      popPingDropRate: Math.random() * 0.005,
      downlinkThroughputBps: (150 + Math.random() * 20) * 1e6,
      uplinkThroughputBps: (25 + Math.random() * 5) * 1e6,
      snr: 8 + Math.random() * 2,
      secondsObstructed: 120,
      fractionObstructed: 0.03,
      currentlyObstructed: false,
      satelliteId: this.nextMockSatelliteId(),
      secondsToFirstNonemptySlot: 0,
      obstructionMap: this.generateMockObstructionMap(),
      obstructionMapSource: 'mock',
      // 校准数据
      boresightAzimuthDeg: 28.3 + (Math.random() - 0.5) * 2,
      boresightElevationDeg: 76.2 + (Math.random() - 0.5) * 2,
      attitudeEstimationState: 'VALID',
      tiltAngleDeg: 76 + (Math.random() - 0.5) * 1,
      alignmentStats: {
        validS: true,
        attitudeUncertaintyDeg: 0.4 + Math.random() * 0.2,
        desiredBoresightAzimuthDeg: 28,
        desiredBoresightElevationDeg: 76,
      },
      dishTemperature: 35 + Math.random() * 5,
      powerSupplyTemperature: 40 + Math.random() * 5,
      hardwareVersion: 'rev3_proto2',
      softwareVersion: '2024.10.22.mr12345',
      
      // WiFi 模拟数据（周期性在弱信号和正常信号间切换，验证告警恢复）
      wifiRssi: this.getMockWifiRssi(),
      wifiTxRate: this.getMockWifiTxRate(),
      wifiRxRate: 35 + Math.random() * 15,  // 35-50 Mbps  
      wifiChannelUtilization: this.getMockWifiChannelUtilization(),
      wifiRetransmitRate: this.getMockWifiRetransmitRate(),
      wifiClientCount: Math.floor(Math.random() * 5) + 1,  // 1-5 个客户端
      
      alerts: {},
    };
  }
  
  /**
   * 生成模拟障碍图（123x123）
   */
  private generateMockObstructionMap(): number[][] {
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
        
        // 随机生成障碍值（**归一化 0..1**，越高遮挡越严重 —— 与 gRPC 实测同刻度）
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
   * 生成模拟 WiFi RSSI（周期性在弱信号和正常信号间切换）
   * 周期：120 次采样（约 60 分钟）
   * - 前 60 次：弱信号 -75 到 -85 dBm（触发告警）
   * - 后 60 次：正常信号 -55 到 -65 dBm（告警恢复）
   */
  private getMockWifiRssi(): number {
    this.wifiMockCycle = (this.wifiMockCycle + 1) % 120;
    const isWeakSignal = this.wifiMockCycle < 60;
    return isWeakSignal 
      ? -75 - Math.random() * 10   // 弱信号：-75 到 -85 dBm
      : -55 - Math.random() * 10;  // 正常：-55 到 -65 dBm
  }

  /**
   * 生成模拟 WiFi 发送速率
   */
  private getMockWifiTxRate(): number {
    const isWeakSignal = this.wifiMockCycle < 60;
    return isWeakSignal
      ? 40 + Math.random() * 20    // 弱信号：40-60 Mbps（低）
      : 80 + Math.random() * 40;   // 正常：80-120 Mbps
  }

  /**
   * 生成模拟 WiFi 信道利用率
   */
  private getMockWifiChannelUtilization(): number {
    const isWeakSignal = this.wifiMockCycle < 60;
    return isWeakSignal
      ? 0.65 + Math.random() * 0.2   // 拥堵：65-85%
      : 0.25 + Math.random() * 0.2;  // 正常：25-45%
  }

  /**
   * 生成模拟 WiFi 重传率
   */
  private getMockWifiRetransmitRate(): number {
    const isWeakSignal = this.wifiMockCycle < 60;
    return isWeakSignal
      ? 0.15 + Math.random() * 0.1   // 高重传：15-25%
      : 0.02 + Math.random() * 0.03; // 正常：2-5%
  }
  
  /**
   * 更新配置
   */
  updateConfig(config: Partial<DishConfig>) {
    this.config = { ...this.config, ...config };
    // 地址或端口变了, 旧连接作废
    if (
      config.address !== undefined ||
      config.grpcPort !== undefined ||
      config.grpcWebPort !== undefined
    ) {
      this.grpc?.close();
      this.grpc = null;
    }
  }
  
  /**
   * 获取当前配置
   */
  getConfig(): DishConfig {
    return { ...this.config };
  }
  
  /**
   * 获取 gRPC 客户端实例（用于高级操作，如 getHistory）
   */
  getGrpcClient(): DishGrpcClient | null {
    return this.grpc;
  }
}

/**
 * 创建默认的 DishClient 实例
 */
export function createDishClient(config?: Partial<DishConfig>): DishClient {
  return new DishClient(config);
}