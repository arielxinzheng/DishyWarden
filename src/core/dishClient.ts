/**
 * Starlink Dish gRPC 客户端
 *
 * 基于 @connectrpc/connect-web 实现与 Starlink 终端的 gRPC-Web 通信
 * 参考 dishylink 的实现，处理 CORS 和 Referer 头限制
 */

import { createConnectTransport } from '@connectrpc/connect-web';
import { DishGrpcClient } from './dishGrpc';

export interface DishConfig {
  address: string;      // dish 地址，默认 192.168.100.1
  grpcPort: number;     // gRPC 端口，默认 9200
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

export interface TelemetryData {
  // 连接状态
  state: 'ONLINE' | 'OFFLINE' | 'SEARCHING' | 'BOOTING';
  uptime: number;
  
  // 网络指标
  popPingLatencyMs: number;
  popPingDropRate: number;
  downlinkThroughputBps: number;
  uplinkThroughputBps: number;
  
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
  alerts: string[];
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

  /** WiFi mock 周期计数器（用于模拟信号强度周期性变化） */
  private wifiMockCycle = 0;

  constructor(config: Partial<DishConfig> = {}) {
    this.config = {
      address: config.address || '127.0.0.1',
      grpcPort: config.grpcPort || 9200,
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
      this.grpc = new DishGrpcClient(this.config.address, this.config.grpcPort);
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
      this.grpc = new DishGrpcClient(this.config.address, this.config.grpcPort);
    }

    try {
      const status = await this.grpc.getStatus(this.config.timeout);
      const telemetry = this.parseStatus(status);

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
  private parseStatus(status: Record<string, unknown>): TelemetryData {
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

    const deviceInfo = (status.deviceInfo ?? {}) as Record<string, unknown>;
    const deviceState = (status.deviceState ?? {}) as Record<string, unknown>;
    const obstructionStats = (status.obstructionStats ?? {}) as Record<string, unknown>;
    const alignment = (status.alignmentStats ?? {}) as Record<string, unknown>;

    // dishGetStatus 不带 snr 数值, 只给 isSnrAboveNoiseFloor;
    // SNR 真实值在遮挡图的 snr 数组里 (见 getObstructionMap 的 avgSnr)
    const snr = num(status.snr, prev?.snr ?? 0);

    // 遮挡统计
    const currentlyObstructed = obstructionStats.currentlyObstructed === true;
    const fractionObstructed = num(obstructionStats.fractionObstructed, 0);

    // 告警列表: dish 用 alerts 结构体, 这里摊平成字符串数组
    const alertObj = (status.alerts ?? {}) as Record<string, unknown>;
    const alerts: string[] = [];
    for (const [k, v] of Object.entries(alertObj)) {
      if (v === true) alerts.push(k);
    }

    const telemetry: TelemetryData = {
      // 协议里没有 state 枚举 (DishyMock proto 明确注明"被测方全程不读"),
      // 所以连接状态只能从实际链路指标推导 —— 见 deriveState()
      state: 'SEARCHING',
      uptime: num(deviceState.uptimeS, prev?.uptime ?? 0),

      popPingLatencyMs: num(status.popPingLatencyMs, 0),
      popPingDropRate: num(status.popPingDropRate, prev?.popPingDropRate ?? 0),
      downlinkThroughputBps: num(status.downlinkThroughputBps, 0),
      uplinkThroughputBps: num(status.uplinkThroughputBps, 0),

      snr,
      secondsObstructed: num(obstructionStats.secondsObstructed, prev?.secondsObstructed ?? 0),
      fractionObstructed,
      currentlyObstructed,

      satelliteId: num(status.satelliteId, prev?.satelliteId ?? 0),
      secondsToFirstNonemptySlot: num(status.secondsToFirstNonemptySlot, 0),

      obstructionMap: prev?.obstructionMap,
      obstructionMapSource: prev?.obstructionMapSource,
      obstructionMapTimestamp: prev?.obstructionMapTimestamp,

      boresightAzimuthDeg: num(status.boresightAzimuthDeg, prev?.boresightAzimuthDeg ?? 0),
      boresightElevationDeg: num(status.boresightElevationDeg, prev?.boresightElevationDeg ?? 0),
      attitudeEstimationState:
        typeof alignment.attitudeEstimationState === 'string'
          ? alignment.attitudeEstimationState
          : prev?.attitudeEstimationState,
      tiltAngleDeg: num(alignment.tiltAngleDeg, prev?.tiltAngleDeg ?? 0),
      alignmentStats: {
        validS: alignment.hasActuators !== undefined
          ? alignment.hasActuators === 'HAS_ACTUATORS_YES'
          : prev?.alignmentStats?.validS,
        attitudeUncertaintyDeg: num(
          alignment.attitudeUncertaintyDeg,
          prev?.alignmentStats?.attitudeUncertaintyDeg ?? 0
        ),
        desiredBoresightAzimuthDeg: num(
          alignment.desiredBoresightAzimuthDeg,
          prev?.alignmentStats?.desiredBoresightAzimuthDeg ?? 0
        ),
        desiredBoresightElevationDeg: num(
          alignment.desiredBoresightElevationDeg,
          prev?.alignmentStats?.desiredBoresightElevationDeg ?? 0
        ),
      },

      dishTemperature: num(deviceInfo.dishTemperature, prev?.dishTemperature ?? 0),
      powerSupplyTemperature: num(deviceInfo.powerSupplyTemperature, prev?.powerSupplyTemperature ?? 0),
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
      gpsSats: num((status.gpsStats as Record<string, unknown> | undefined)?.gpsSats, prev?.gpsSats ?? 0),
      gpsConvergenceState:
        typeof (status.gpsStats as Record<string, unknown> | undefined)?.pntFilterConvergenceState === 'string'
          ? String((status.gpsStats as Record<string, unknown> | undefined)?.pntFilterConvergenceState)
          : prev?.gpsConvergenceState,
      
      // 以太网状态
      ethSpeedMbps: num(status.ethSpeedMbps, prev?.ethSpeedMbps ?? 0),
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
    };

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

    // 有下行带宽说明链路是通的
    const hasDownlink = telemetry.downlinkThroughputBps > 0;
    const hasRouter = Array.isArray(status.connectedRouters)
      ? (status.connectedRouters as unknown[]).length > 0
      : false;

    if (!hasDownlink && !hasRouter) {
      return 'SEARCHING';
    }

    // SNR 高于噪声底 (isSnrAboveNoiseFloor 是设备直接给的布尔量)
    const snrOk = status.isSnrAboveNoiseFloor === true;
    if (snrOk || telemetry.snr > 0) {
      return 'ONLINE';
    }

    return 'SEARCHING';
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
      
      alerts: [],
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
    if (config.address !== undefined || config.grpcPort !== undefined) {
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
}

/**
 * 创建默认的 DishClient 实例
 */
export function createDishClient(config?: Partial<DishConfig>): DishClient {
  return new DishClient(config);
}