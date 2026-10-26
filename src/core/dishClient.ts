/**
 * Starlink Dish gRPC 客户端
 * 
 * 基于 @connectrpc/connect-web 实现与 Starlink 终端的 gRPC-Web 通信
 * 参考 dishylink 的实现，处理 CORS 和 Referer 头限制
 */

import { createConnectTransport } from '@connectrpc/connect-web';

export interface DishConfig {
  address: string;      // dish 地址，默认 192.168.100.1
  grpcPort: number;     // gRPC 端口，默认 9200
  timeout?: number;     // 请求超时（毫秒），默认 10000
  useProxy?: boolean;   // 是否使用代理绕过 CORS
  proxyUrl?: string;    // 代理服务器地址
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
  
  constructor(config: Partial<DishConfig> = {}) {
    this.config = {
      address: config.address || '127.0.0.1',
      grpcPort: config.grpcPort || 9200,
      timeout: config.timeout || 10000,
      useProxy: config.useProxy || false,
      proxyUrl: config.proxyUrl || 'http://localhost:8080',
    };
    
    // const transport = createDishTransport(this.config);
    // this.client = createPromiseClient(DishService, transport);
  }
  
  /**
   * 测试连接
   */
  async testConnection(): Promise<boolean> {
    try {
      // 暂时使用简单的 HTTP 请求测试连接
      const response = await fetch(
        `http://${this.config.address}:${this.config.grpcPort}/healthz`,
        { 
          method: 'GET',
          signal: AbortSignal.timeout(this.config.timeout),
        }
      );
      return response.ok;
    } catch (error) {
      console.error('Connection test failed:', error);
      return false;
    }
  }
  
  /**
   * 获取遥测数据
   * 
   * 调用 dish 的 getStatus 方法获取完整遥测数据
   */
  async getTelemetry(): Promise<TelemetryData> {
    // TODO: 实现真实的 gRPC 调用
    // const request = new GetStatusRequest();
    // const response = await this.client.handle(request);
    // return this.parseTelemetry(response);
    
    // 暂时返回模拟数据
    return this.getMockTelemetry();
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
   * 更新配置
   */
  updateConfig(config: Partial<DishConfig>) {
    this.config = { ...this.config, ...config };
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