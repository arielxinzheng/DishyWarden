/**
 * Grafana 集成管理器
 * 自动配置 Prometheus 数据源和 Starlink Dashboard
 */

import axios, { AxiosInstance } from 'axios';

export interface GrafanaConfig {
  url: string;
  apiKey?: string;
  username?: string;
  password?: string;
}

export interface DataSourceConfig {
  name: string;
  type: string;
  url: string;
  access: 'proxy' | 'direct';
  isDefault: boolean;
}

export interface DashboardConfig {
  title: string;
  uid: string;
  dashboard: Record<string, unknown>;
}

/**
 * Grafana API 客户端
 */
export class GrafanaManager {
  private client: AxiosInstance;

  constructor(config: GrafanaConfig) {

    // 创建 HTTP 客户端
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    this.client = axios.create({
      baseURL: config.url,
      headers,
      auth: config.username && config.password
        ? { username: config.username, password: config.password }
        : undefined,
      timeout: 10000,
    });
  }

  /**
   * 检查 Grafana 连接
   */
  async checkConnection(): Promise<boolean> {
    try {
      const response = await this.client.get('/api/health');
      return response.status === 200;
    } catch (error) {
      console.error('[Grafana] Connection failed:', error);
      return false;
    }
  }

  /**
   * 获取或创建 Prometheus 数据源
   */
  async ensureDataSource(prometheusUrl: string): Promise<number> {
    const dataSourceName = 'SLMonitor Prometheus';

    try {
      // 查找已存在的数据源
      const response = await this.client.get('/api/datasources/name/' + encodeURIComponent(dataSourceName));
      console.log('[Grafana] Data source already exists:', response.data.id);
      return response.data.id;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        // 数据源不存在,创建新的
        return await this.createDataSource({
          name: dataSourceName,
          type: 'prometheus',
          url: prometheusUrl,
          access: 'proxy',
          isDefault: true,
        });
      }
      throw error;
    }
  }

  /**
   * 创建数据源
   */
  private async createDataSource(config: DataSourceConfig): Promise<number> {
    try {
      const response = await this.client.post('/api/datasources', {
        name: config.name,
        type: config.type,
        url: config.url,
        access: config.access,
        isDefault: config.isDefault,
        jsonData: {
          timeInterval: '30s',
        },
      });

      console.log('[Grafana] Data source created:', response.data.id);
      return response.data.id;
    } catch (error) {
      console.error('[Grafana] Failed to create data source:', error);
      throw error;
    }
  }

  /**
   * 创建或更新 Dashboard
   */
  async ensureDashboard(dataSourceUid: string): Promise<string> {
    const dashboard = this.createStarlinkDashboard(dataSourceUid);

    try {
      const response = await this.client.post('/api/dashboards/db', {
        dashboard: dashboard.dashboard,
        overwrite: true,
        message: 'Auto-provisioned by SLMonitor',
      });

      console.log('[Grafana] Dashboard created/updated:', response.data.uid);
      return response.data.url;
    } catch (error) {
      console.error('[Grafana] Failed to create dashboard:', error);
      throw error;
    }
  }

  /**
   * 生成 Starlink Dashboard 配置
   */
  private createStarlinkDashboard(dataSourceUid: string): DashboardConfig {
    return {
      title: 'Starlink Monitor',
      uid: 'slmonitor-overview',
      dashboard: {
        title: 'Starlink Monitor',
        uid: 'slmonitor-overview',
        tags: ['starlink', 'slmonitor'],
        timezone: 'browser',
        schemaVersion: 38,
        refresh: '30s',
        time: {
          from: 'now-3h',
          to: 'now',
        },
        panels: [
          // 延迟图表
          {
            id: 1,
            type: 'timeseries',
            title: 'Network Latency',
            gridPos: { x: 0, y: 0, w: 12, h: 8 },
            datasource: { uid: dataSourceUid },
            targets: [
              {
                expr: 'starlink_pop_ping_latency_ms',
                legendFormat: 'Latency (ms)',
                refId: 'A',
              },
            ],
            fieldConfig: {
              defaults: {
                unit: 'ms',
                color: { mode: 'palette-classic' },
              },
            },
          },

          // 吞吐量图表
          {
            id: 2,
            type: 'timeseries',
            title: 'Throughput',
            gridPos: { x: 12, y: 0, w: 12, h: 8 },
            datasource: { uid: dataSourceUid },
            targets: [
              {
                expr: 'rate(starlink_downlink_throughput_bps[1m]) / 1000000',
                legendFormat: 'Download (Mbps)',
                refId: 'A',
              },
              {
                expr: 'rate(starlink_uplink_throughput_bps[1m]) / 1000000',
                legendFormat: 'Upload (Mbps)',
                refId: 'B',
              },
            ],
            fieldConfig: {
              defaults: {
                unit: 'Mbps',
                color: { mode: 'palette-classic' },
              },
            },
          },

          // 运行时间
          {
            id: 3,
            type: 'stat',
            title: 'Uptime',
            gridPos: { x: 0, y: 8, w: 6, h: 4 },
            datasource: { uid: dataSourceUid },
            targets: [
              {
                expr: 'starlink_uptime * 100',
                refId: 'A',
              },
            ],
            fieldConfig: {
              defaults: {
                unit: 'percent',
                thresholds: {
                  mode: 'absolute',
                  steps: [
                    { value: 0, color: 'red' },
                    { value: 90, color: 'yellow' },
                    { value: 99, color: 'green' },
                  ],
                },
              },
            },
          },

          // SNR
          {
            id: 4,
            type: 'gauge',
            title: 'Signal Quality (SNR)',
            gridPos: { x: 6, y: 8, w: 6, h: 4 },
            datasource: { uid: dataSourceUid },
            targets: [
              {
                expr: 'starlink_snr',
                refId: 'A',
              },
            ],
            fieldConfig: {
              defaults: {
                unit: 'dB',
                min: 0,
                max: 20,
                thresholds: {
                  mode: 'absolute',
                  steps: [
                    { value: 0, color: 'red' },
                    { value: 5, color: 'yellow' },
                    { value: 10, color: 'green' },
                  ],
                },
              },
            },
          },

          // 障碍率
          {
            id: 5,
            type: 'stat',
            title: 'Obstruction Rate',
            gridPos: { x: 12, y: 8, w: 6, h: 4 },
            datasource: { uid: dataSourceUid },
            targets: [
              {
                expr: 'starlink_obstruction_fraction * 100',
                refId: 'A',
              },
            ],
            fieldConfig: {
              defaults: {
                unit: 'percent',
                thresholds: {
                  mode: 'absolute',
                  steps: [
                    { value: 0, color: 'green' },
                    { value: 1, color: 'yellow' },
                    { value: 5, color: 'red' },
                  ],
                },
              },
            },
          },

          // 告警次数
          {
            id: 6,
            type: 'stat',
            title: 'Active Alerts',
            gridPos: { x: 18, y: 8, w: 6, h: 4 },
            datasource: { uid: dataSourceUid },
            targets: [
              {
                expr: 'count(ALERTS{alertstate="firing"})',
                refId: 'A',
              },
            ],
            fieldConfig: {
              defaults: {
                unit: 'short',
                color: { mode: 'thresholds' },
                thresholds: {
                  mode: 'absolute',
                  steps: [
                    { value: 0, color: 'green' },
                    { value: 1, color: 'yellow' },
                    { value: 3, color: 'red' },
                  ],
                },
              },
            },
          },

          // 数据包丢失
          {
            id: 7,
            type: 'timeseries',
            title: 'Packet Loss',
            gridPos: { x: 0, y: 12, w: 12, h: 6 },
            datasource: { uid: dataSourceUid },
            targets: [
              {
                expr: 'rate(starlink_drop_rate[1m]) * 100',
                legendFormat: 'Drop Rate (%)',
                refId: 'A',
              },
            ],
            fieldConfig: {
              defaults: {
                unit: 'percent',
                color: { mode: 'palette-classic' },
              },
            },
          },

          // 卫星连接
          {
            id: 8,
            type: 'timeseries',
            title: 'Connected Satellites',
            gridPos: { x: 12, y: 12, w: 12, h: 6 },
            datasource: { uid: dataSourceUid },
            targets: [
              {
                expr: 'starlink_currently_obstructed',
                legendFormat: 'Obstructed',
                refId: 'A',
              },
            ],
            fieldConfig: {
              defaults: {
                unit: 'short',
                color: { mode: 'palette-classic' },
              },
            },
          },
        ],
      },
    };
  }

  /**
   * 获取数据源 UID
   */
  async getDataSourceUid(dataSourceId: number): Promise<string> {
    try {
      const response = await this.client.get(`/api/datasources/${dataSourceId}`);
      return response.data.uid;
    } catch (error) {
      console.error('[Grafana] Failed to get data source UID:', error);
      throw error;
    }
  }

  /**
   * 一键配置 Grafana
   */
  async provision(prometheusUrl: string): Promise<{ dataSourceId: number; dashboardUrl: string }> {
    console.log('[Grafana] Starting provisioning...');

    // 1. 检查连接
    const connected = await this.checkConnection();
    if (!connected) {
      throw new Error('Cannot connect to Grafana');
    }

    // 2. 创建数据源
    const dataSourceId = await this.ensureDataSource(prometheusUrl);
    const dataSourceUid = await this.getDataSourceUid(dataSourceId);

    // 3. 创建 Dashboard
    const dashboardUrl = await this.ensureDashboard(dataSourceUid);

    console.log('[Grafana] Provisioning completed');
    return { dataSourceId, dashboardUrl };
  }
}

/**
 * 创建 Grafana 管理器实例
 */
export function createGrafanaManager(config: GrafanaConfig): GrafanaManager {
  return new GrafanaManager(config);
}