/**
 * 配置管理器
 * 持久化用户配置到 JSON 文件
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { NotificationConfig } from '../alerting/notifier';

export interface CollectorConfig {
  interval: number; // 采集间隔(毫秒)
  bufferSize: number; // 历史数据缓冲大小
  dishAddress: string; // Starlink 设备地址
  dishPort: number; // Dish gRPC 端口
  routerAddress: string; // Starlink 路由器地址
  routerPort: number; // Router gRPC 端口
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

export interface AppConfig {
  collector: CollectorConfig;
  prometheus: PrometheusConfig;
  notifications: NotificationConfig;
  grafana: GrafanaConfig;
  version: string;
}

const DEFAULT_CONFIG: AppConfig = {
  collector: {
    interval: 30000,
    bufferSize: 2880,
    dishAddress: '127.0.0.1',
    dishPort: 9200,
    routerAddress: '127.0.0.1',
    routerPort: 9200,
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
          ? { ...defaults.notifications.webhook!, ...loaded.notifications.webhook }
          : defaults.notifications.webhook,
        email: loaded.notifications?.email
          ? { ...defaults.notifications.email!, ...loaded.notifications.email }
          : defaults.notifications.email,
      },
      grafana: { ...defaults.grafana, ...loaded.grafana },
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