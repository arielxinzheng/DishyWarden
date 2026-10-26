/**
 * Starlink Router gRPC 客户端
 * 
 * 与 DishClient 类似，用于连接 Starlink 路由器并获取路由器相关的遥测数据
 */

// transport 与 dish 侧共用同一套 CORS/Referer 处理，真实 gRPC 接入时
// 直接复用 dishClient 导出的 createDishTransport，不必再复制一份。

export interface RouterConfig {
  address: string;      // router 地址，默认 192.168.1.1
  grpcPort: number;     // gRPC 端口，默认 9200
  timeout?: number;     // 请求超时（毫秒），默认 10000
  useProxy?: boolean;   // 是否使用代理绕过 CORS
  proxyUrl?: string;    // 代理服务器地址
}

export interface RouterTelemetryData {
  // 连接状态
  state: 'ONLINE' | 'OFFLINE';
  uptime: number;
  
  // 网络指标
  wanUptime: number;
  wanIpv4: string;
  wanIpv6: string;
  
  // 流量统计
  wanRxBytes: number;
  wanTxBytes: number;
  lanRxBytes: number;
  lanTxBytes: number;
  
  // 连接设备
  connectedClients: number;
  clientsDetails: ClientInfo[];
  
  // 硬件状态
  cpuUsage: number;
  memoryUsage: number;
  temperature: number;
  
  // 版本信息
  hardwareVersion: string;
  softwareVersion: string;
}

export interface ClientInfo {
  macAddress: string;
  ipAddress: string;
  hostname: string;
  connected: boolean;
  signalStrength: number;
  rxBytes: number;
  txBytes: number;
  interface: 'WIFI_2_4GHZ' | 'WIFI_5GHZ' | 'ETHERNET';
}

/**
 * Starlink Router 客户端
 */
export class RouterClient {
  private config: Required<RouterConfig>;
  
  constructor(config: Partial<RouterConfig> = {}) {
    this.config = {
      address: config.address || '127.0.0.1',
      grpcPort: config.grpcPort || 9200,
      timeout: config.timeout || 10000,
      useProxy: config.useProxy || false,
      proxyUrl: config.proxyUrl || 'http://localhost:8080',
    };
  }
  
  /**
   * 测试连接
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(
        `http://${this.config.address}:${this.config.grpcPort}/healthz`,
        { 
          method: 'GET',
          signal: AbortSignal.timeout(this.config.timeout),
        }
      );
      return response.ok;
    } catch (error) {
      console.error('[RouterClient] Connection test failed:', error);
      return false;
    }
  }
  
  /**
   * 获取路由器遥测数据
   */
  async getTelemetry(): Promise<RouterTelemetryData> {
    // TODO: 实现真实的 gRPC 调用
    return this.getMockTelemetry();
  }
  
  /**
   * 模拟数据（用于开发阶段）
   */
  private getMockTelemetry(): RouterTelemetryData {
    return {
      state: 'ONLINE',
      uptime: 86400,
      wanUptime: 86000,
      wanIpv4: '10.0.0.1',
      wanIpv6: 'fe80::1',
      wanRxBytes: 1.5e9,
      wanTxBytes: 5e8,
      lanRxBytes: 2e9,
      lanTxBytes: 1e9,
      connectedClients: 8,
      clientsDetails: this.generateMockClients(),
      cpuUsage: 25 + Math.random() * 15,
      memoryUsage: 40 + Math.random() * 10,
      temperature: 45 + Math.random() * 5,
      hardwareVersion: 'rev2_proto3',
      softwareVersion: '2024.10.22.mr12345',
    };
  }
  
  /**
   * 生成模拟客户端列表
   */
  private generateMockClients(): ClientInfo[] {
    const clients: ClientInfo[] = [];
    const count = Math.floor(Math.random() * 5) + 4; // 4-8 devices
    
    for (let i = 0; i < count; i++) {
      clients.push({
        macAddress: `00:11:22:33:44:${i.toString(16).padStart(2, '0')}`,
        ipAddress: `192.168.1.${100 + i}`,
        hostname: `device-${i}`,
        connected: Math.random() > 0.1,
        signalStrength: Math.floor(Math.random() * 40) + 60,
        rxBytes: Math.floor(Math.random() * 1e8),
        txBytes: Math.floor(Math.random() * 5e7),
        interface: ['WIFI_2_4GHZ', 'WIFI_5GHZ', 'ETHERNET'][Math.floor(Math.random() * 3)] as any,
      });
    }
    
    return clients;
  }
  
  /**
   * 更新配置
   */
  updateConfig(config: Partial<RouterConfig>) {
    this.config = { ...this.config, ...config };
  }
  
  /**
   * 获取当前配置
   */
  getConfig(): RouterConfig {
    return { ...this.config };
  }
}

/**
 * 创建默认的 RouterClient 实例
 */
export function createRouterClient(config?: Partial<RouterConfig>): RouterClient {
  return new RouterClient(config);
}