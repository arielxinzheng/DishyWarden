/**
 * 配置管理器
 * 持久化用户配置到 JSON 文件
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { NotificationConfig } from '../alerting/notifier';
import { DEFAULT_WEBHOOK_TEMPLATE } from '../alerting/webhookTemplate';

export interface CollectorConfig {
  interval: number; // 采集间隔(毫秒)
  bufferSize: number; // 历史数据缓冲大小
  dishAddress: string; // Starlink 设备地址
  dishPort: number; // Dish gRPC 端口
  routerAddress: string; // 路由器地址（用于 ICMP Ping 探测）
}

export interface AlertThresholds {
  highLatencyMs: number; // 延迟告警阈值(毫秒)
  highPacketLoss: number; // 丢包率告警阈值(0-1 之间)
}

export interface PrometheusConfig {
  port: number;
  retentionTime: string; // 如 "90d"
  scrapeInterval: string; // 如 "30s"
}

export interface GrafanaConfig {
  enabled: boolean;
  url: string;
  apiKey: string;
  username: string;
  password: string;
}

/**
 * 探针节点的探测类型。
 *
 * - `icmp` —— ICMP Ping(路由器状态监控用的就是它)
 * - `dns`  —— DNS 解析(域名能不能解析出来)
 * - `dns_dual` —— 双轨 DNS 探测(用户态 DNS vs 公网基准 DNS)
 * - `tls`  —— TLS 握手(证书链正不正常)
 */
export type ProbeType = 'icmp' | 'dns' | 'dns_dual' | 'tls';

/**
 * 一个探针节点。
 *
 * 对应需求文档 2.1.3「网络连通性探测」的探测目标列表。
 */
export interface ProbeNodeConfig {
  /** 节点 id(唯一), 用于增删改时定位 */
  id: string;
  /** 节点名称, 如「本地网关」「公网 Ping」 */
  name: string;
  /** 探测目标: IP 或域名 */
  target: string;
  /** 探测类型 */
  type: ProbeType;
  /** 探测间隔(秒) */
  intervalSec: number;
  /** 单次探测超时(秒) */
  timeoutSec: number;
  /** 是否启用 */
  enabled: boolean;
}

/**
 * 探针相关配置。
 *
 * 路由跟踪目标也放这里 —— 它本质上也是一个"探测目标",
 * 只是探测方式(traceroute)不同, 不适合塞进节点列表。
 */
export interface ProbeConfig {
  /** 探针节点列表 */
  nodes: ProbeNodeConfig[];
  /** 路由跟踪(traceroute)的目标, 默认 example.com */
  traceTarget: string;
}

export interface AppConfig {
  collector: CollectorConfig;
  prometheus: PrometheusConfig;
  notifications: NotificationConfig;
  grafana: GrafanaConfig;
  alertThresholds: AlertThresholds;
  probe: ProbeConfig;
  version: string;
}

const DEFAULT_CONFIG: AppConfig = {
  collector: {
    interval: 30000,
    bufferSize: 2880,
    dishAddress: '127.0.0.1',
    dishPort: 9200,
    routerAddress: '192.168.100.1', // 默认 Starlink 网关地址
  },
  prometheus: {
    port: 9090,
    retentionTime: '90d',
    scrapeInterval: '30s',
  },
  notifications: {
    telegram: {
      enabled: false,
      botToken: '',
      chatId: '',
    },
    webhook: {
      enabled: false,
      url: '',
      method: 'POST',
      headers: {},
      payloadTemplate: DEFAULT_WEBHOOK_TEMPLATE,
      timeoutMs: 5000,
    },
    email: {
      enabled: false,
      smtpHost: '',
      smtpPort: 587,
      username: '',
      password: '',
      to: [],
      useTLS: true,
    },
  },
  grafana: {
    enabled: false,
    url: 'http://localhost:3000',
    apiKey: '',
    username: 'admin',
    password: 'admin',
  },
  alertThresholds: {
    highLatencyMs: 100,
    highPacketLoss: 0.05, // 丢包率告警阈值: 5%（8% 丢包体验已很差）
  },
  probe: {
    // 路由跟踪目标: example.com 是 RFC 2606 保留域名, 稳定可达且语义中立
    traceTarget: 'example.com',
    nodes: [
      {
        id: 'local-gateway',
        name: '本地网关',
        target: '192.168.100.1',
        type: 'icmp',
        intervalSec: 30,
        timeoutSec: 10,
        enabled: true,
      },
      {
        id: 'public-ping',
        name: '公网 Ping',
        target: '1.1.1.1',
        type: 'icmp',
        intervalSec: 60,
        timeoutSec: 5,
        enabled: true,
      },
      {
        id: 'dns-resolve',
        name: 'DNS 解析',
        target: '8.8.8.8',
        type: 'dns',
        intervalSec: 60,
        timeoutSec: 5,
        enabled: true,
      },
      {
        id: 'dns-dual-check',
        name: 'DNS 双轨探测',
        target: 'google.com|8.8.8.8',
        type: 'dns_dual',
        intervalSec: 60,
        timeoutSec: 5,
        enabled: true,
      },
      {
        id: 'tls-check',
        name: 'TLS 探测',
        target: 'www.cloudflare.com',
        type: 'tls',
        intervalSec: 120,
        timeoutSec: 10,
        enabled: false,
      },
    ],
  },
  version: '0.1.0',
};

export class ConfigManager {
  private configPath: string;
  private config: AppConfig;

  constructor() {
    const userDataPath = app.getPath('userData');
    const configDir = path.join(userDataPath, 'config');

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    this.configPath = path.join(configDir, 'config.json');
    this.config = this.load();
  }

  /**
   * 加载配置
   */
  private load(): AppConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf-8');
        const loaded = JSON.parse(data) as AppConfig;

        // 合并默认配置(处理新增字段)
        return this.mergeConfig(DEFAULT_CONFIG, loaded);
      }
    } catch (error) {
      console.error('[ConfigManager] Failed to load config:', error);
    }

    // 首次运行,使用默认配置
    this.save(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  /**
   * 深度合并配置
   */
  private mergeConfig(defaults: AppConfig, loaded: Partial<AppConfig>): AppConfig {
    return {
      collector: { ...defaults.collector, ...loaded.collector },
      prometheus: { ...defaults.prometheus, ...loaded.prometheus },
      notifications: {
        telegram: loaded.notifications?.telegram 
          ? { ...defaults.notifications.telegram!, ...loaded.notifications.telegram }
          : defaults.notifications.telegram,
        webhook: loaded.notifications?.webhook
          ? {
              ...defaults.notifications.webhook!,
              ...loaded.notifications.webhook,
              // 迁移：老版本允许 'PUT'，现在只支持 GET / POST
              method:
                loaded.notifications.webhook.method === 'GET'
                  ? 'GET'
                  : 'POST',
            }
          : defaults.notifications.webhook,
        email: loaded.notifications?.email
          ? { ...defaults.notifications.email!, ...loaded.notifications.email }
          : defaults.notifications.email,
      },
      grafana: { ...defaults.grafana, ...loaded.grafana },
      alertThresholds: { ...defaults.alertThresholds, ...loaded.alertThresholds },
      // 探针配置: 老配置文件里没有这个字段 ⇒ 用默认值兜底。
      // nodes 是数组, **不合并** —— 用户删掉的节点不该被默认值"复活"。
      probe: {
        traceTarget: loaded.probe?.traceTarget ?? defaults.probe.traceTarget,
        nodes: Array.isArray(loaded.probe?.nodes)
          ? loaded.probe.nodes
          : defaults.probe.nodes,
      },
      version: loaded.version || defaults.version,
    };
  }

  /**
   * 保存配置
   */
  private save(config: AppConfig): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
      console.log('[ConfigManager] Config saved');
    } catch (error) {
      console.error('[ConfigManager] Failed to save config:', error);
      throw error;
    }
  }

  /**
   * 获取完整配置
   */
  getConfig(): AppConfig {
    return { ...this.config };
  }

  /**
   * 更新采集器配置
   */
  updateCollectorConfig(config: Partial<CollectorConfig>): void {
    this.config.collector = { ...this.config.collector, ...config };
    this.save(this.config);
  }

  /**
   * 更新 Prometheus 配置
   */
  updatePrometheusConfig(config: Partial<PrometheusConfig>): void {
    this.config.prometheus = { ...this.config.prometheus, ...config };
    this.save(this.config);
  }

  /**
   * 更新探针配置(节点列表 + 路由跟踪目标)
   */
  updateProbeConfig(config: Partial<ProbeConfig>): void {
    this.config.probe = { ...this.config.probe, ...config };
    this.save(this.config);
  }

  /**
   * 更新通知配置
   */
  updateNotificationConfig(config: Partial<NotificationConfig>): void {
    this.config.notifications = {
      telegram: config.telegram 
        ? { ...this.config.notifications.telegram!, ...config.telegram }
        : this.config.notifications.telegram,
      webhook: config.webhook
        ? { ...this.config.notifications.webhook!, ...config.webhook }
        : this.config.notifications.webhook,
      email: config.email
        ? { ...this.config.notifications.email!, ...config.email }
        : this.config.notifications.email,
    };
    this.save(this.config);
  }

  /**
   * 更新 Grafana 配置
   */
  updateGrafanaConfig(config: Partial<GrafanaConfig>): void {
    this.config.grafana = { ...this.config.grafana, ...config };
    this.save(this.config);
  }

  /**
   * 重置为默认配置
   */
  reset(): void {
    this.config = { ...DEFAULT_CONFIG };
    this.save(this.config);
  }

  /**
   * 导出配置
   */
  exportConfig(exportPath: string): void {
    fs.copyFileSync(this.configPath, exportPath);
  }

  /**
   * 导入配置
   */
  importConfig(importPath: string): void {
    const data = fs.readFileSync(importPath, 'utf-8');
    const imported = JSON.parse(data) as AppConfig;
    this.config = this.mergeConfig(DEFAULT_CONFIG, imported);
    this.save(this.config);
  }
}

// 单例实例
let instance: ConfigManager | null = null;

export function getConfigManager(): ConfigManager {
  if (!instance) {
    instance = new ConfigManager();
  }
  return instance;
}