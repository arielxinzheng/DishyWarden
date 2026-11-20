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
  /** Starlink 终端地址（真机默认 192.168.100.1） */
  dishAddress: string;
  /** Dish 原生 gRPC 端口（HTTP/2，反射服务在这里） */
  dishPort: number;
  /**
   * Dish grpc-web 端口（HTTP/1.1）。
   *
   * 真机在 9200 的原生 gRPC 上可能对 Handle 回 `12 UNIMPLEMENTED`，
   * 而 9201 的 grpc-web 正常 ⇒ 原生失败时自动改走这个端口。
   */
  dishWebPort: number;
  /** Starlink 路由器地址（真机默认 192.168.1.1，用于 ICMP 探测） */
  routerAddress: string;
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

/**
 * 云端服务（SL Cloud）配置。
 *
 * 全部留空 = 完全不触网 —— 这样在云端服务上线前，客户端可以照常发布。
 */
export interface CloudConfig {
  /** 云端地址，如 https://cloud.example.com（空 = 不上报） */
  endpoint: string;
  /** 匿名装机 ID（随机 UUID v4，首次运行时生成） */
  clientId: string;
  /** 是否上报告警误报负样本 */
  feedbackEnabled: boolean;
  /** 更新源 feed URL（空 = 不检查更新） */
  updateFeedUrl: string;
  /** 检查更新间隔（小时） */
  checkIntervalHours: number;
}

/**
 * 云端服务端点 —— **由后台固定，设置页不再暴露**。
 *
 * 云端已部署在 cloud.dishywarden.com（见 CloudServer/DEPLOYMENT-STATUS.md）。
 * 不交给用户配置的理由：
 * 1. 填错一个字符 ⇒ 上报静默全失败（上报本身刻意不抛错，用户永远发现不了）
 * 2. 旧版本把「留空」当作关闭上传的开关，留着旧值会让上报永久失效
 * 3. 可被诱导指向第三方 ⇒ 数据外流
 * 4. 部署事实只有一个，没有"让用户自己填"的必要
 */
export const CLOUD_ENDPOINT = 'https://cloud.dishywarden.com';

/**
 * 更新源 feed —— 同样后台固定。
 *
 * **托管方 = GitHub Releases（路线 A）**：
 * https://github.com/arielxinzheng/DishyWarden/releases/latest/download/
 *
 * ## ⚠️ 结尾的斜杠不能省, 且**不要**再补 `latest.yml`
 *
 * electron-updater 用的是 **generic provider**
 * (`src/core/updater.ts`: `setFeedURL({ provider: 'generic', url: feedUrl })`),
 * 它按「发布目录」语义拼 URL:
 *
 *   baseUrl     = newBaseUrl(feedUrl)   ← 路径不以 / 结尾就强制补 /
 *   channelFile = `${channel}.yml`      ← channel 默认 'latest' ⇒ latest.yml
 *   最终请求     = new URL(channelFile, baseUrl)
 *
 * 实测(electron-updater/out/util.js):
 *
 *   feed = .../latest/download/latest.yml  ⇒ 实际请求
 *          .../latest/download/latest.yml/latest.yml   ❌ 404
 *   feed = .../latest/download/            ⇒ 实际请求
 *          .../latest/download/latest.yml              ✅
 *
 * ⇒ 这里必须是**目录形式**(带尾斜杠)。文档 docs/CLOUD-UPGRADE.md §2.3
 *   写的完整文件路径是错的, 已同步修正。
 *
 * ## 与 build.publish 的关系
 *
 * `build.publish` 的 github provider 决定**产物发到哪里**;
 * 这个常量决定**客户端去哪里取清单**。两者指向同一个 Release,
 * 但 URL 形态不同(publish 是 repo 坐标, 这里是目录)。
 *
 * ⚠️ 通道就位前这个值是空串（= 不检查更新，界面显示「更新通道未开放」）。
 *    填上之后必须**重新打包发版**才会生效（值编译进包）。
 */
export const UPDATE_FEED_URL =
  'https://github.com/arielxinzheng/DishyWarden/releases/latest/download/';

export interface AppConfig {
  collector: CollectorConfig;
  prometheus: PrometheusConfig;
  notifications: NotificationConfig;
  grafana: GrafanaConfig;
  alertThresholds: AlertThresholds;
  probe: ProbeConfig;
  cloud: CloudConfig;
  version: string;
}

const DEFAULT_CONFIG: AppConfig = {
  collector: {
    interval: 30000,
    bufferSize: 2880,
    // ↓ 真机默认值（依据 dishylink 的真机实测：README + core/routerEndpoint.ts）
    //   dish  : 192.168.100.1  9200=原生 gRPC(HTTP/2, 有反射) / 9201=grpc-web(HTTP/1.1)
    //   router: 192.168.1.1    9001=路由器 gRPC
    dishAddress: '192.168.100.1',
    dishPort: 9200,
    dishWebPort: 9201,
    routerAddress: '192.168.1.1', // Starlink 路由器 LAN 地址
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
        // Starlink 路由器默认 192.168.1.1（dishylink core/routerEndpoint.ts 同款）
        // 实际 ping 走的是自动探测到的默认网关，这个字段是展示与兜底目标
        target: '192.168.1.1',
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
  cloud: {
    // endpoint / updateFeedUrl 由后台常量固定，设置页不再暴露（见文件上方注释）。
    // feedbackEnabled 默认 true —— 误报样本是训练告警规则的主要来源，
    // 用户可在设置页随时关闭（opt-out）。
    endpoint: CLOUD_ENDPOINT,
    clientId: '',
    feedbackEnabled: true,
    updateFeedUrl: UPDATE_FEED_URL,
    checkIntervalHours: 12,
  },
  // ⚠️ 这个字段**不是**应用版本号的来源 ——
  //    上报用的 app_version 来自主进程 `app.getVersion()`（读 package.json），
  //    见 src/main/index.ts 的 getAppVersion 与 src/core/cloudClient.ts。
  //    这里只是配置结构的占位, 升版本时不必改（改了也不会生效）。
  version: '1.0.0',
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
    if (fs.existsSync(this.configPath)) {
      try {
        const data = fs.readFileSync(this.configPath, 'utf-8');
        const loaded = JSON.parse(data) as AppConfig;

        // 合并默认配置(处理新增字段)
        return this.mergeConfig(DEFAULT_CONFIG, loaded);
      } catch (error) {
        // 解析失败(半截 JSON / 编码坏了) —— **绝不能直接覆盖用户的文件**:
        // 旧实现会走到下面 save(DEFAULT_CONFIG), 把用户配置整个抹掉且不留证据。
        // 这里把坏文件改名留证, 然后用默认值启动(应用仍可用)。
        const corruptPath = `${this.configPath}.corrupt`;
        try {
          fs.renameSync(this.configPath, corruptPath);
          console.error(
            `[ConfigManager] 配置文件解析失败, 已备份为 ${corruptPath}: `,
            error,
          );
        } catch (renameError) {
          console.error('[ConfigManager] 备份损坏配置文件失败:', renameError);
        }
      }
    }

    // 首次运行(或配置损坏) —— 用默认值
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
      // 云端配置: 老配置文件里没有这一段 ⇒ 必须用默认值兜底,
      // 否则 loaded.cloud 是 undefined, 读 .cloud.endpoint 直接抛。
      //
      // ⚠️ endpoint / updateFeedUrl 是后台常量，**不采纳**本地存的值：
      //    老用户库里可能存着空串（当时靠"留空"关闭上传）或填错的地址，
      //    沿用旧值会让上报永久失效。放在 spread 之后强制覆盖 = 自愈。
      cloud: {
        ...defaults.cloud,
        ...loaded.cloud,
        endpoint: CLOUD_ENDPOINT,
        updateFeedUrl: UPDATE_FEED_URL,
      },
      version: loaded.version || defaults.version,
    };
  }

  /**
   * 保存配置
   */
  /**
   * 落盘配置。
   *
   * 原子写: 先写 .tmp 再 rename —— 同一文件系统上的 rename 是原子操作,
   * 所以**永远看不到半截 JSON**。直接 writeFileSync 覆盖写时, 进程在写一半
   * 被杀/断电就会留下截断文件, 下次启动解析失败 ⇒ 用户配置全丢。
   *
   * 同时保留上一份好配置为 .bak: 出问题时能手工捞回来。
   */
  private save(config: AppConfig): void {
    const tmpPath = `${this.configPath}.tmp`;
    const payload = JSON.stringify(config, null, 2);

    try {
      fs.writeFileSync(tmpPath, payload, 'utf-8');

      // 覆盖前先留一份上一版(只在已有有效配置时留, 避免 .bak 是刚写的同一份)
      if (fs.existsSync(this.configPath)) {
        try {
          fs.copyFileSync(this.configPath, `${this.configPath}.bak`);
        } catch (backupError) {
          console.warn('[ConfigManager] 备份上一版配置失败(不阻断保存):', backupError);
        }
      }

      fs.renameSync(tmpPath, this.configPath);
      console.log('[ConfigManager] Config saved');
    } catch (error) {
      console.error('[ConfigManager] Failed to save config:', error);
      // 清掉半截临时文件, 免得留在目录里让人误会
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        /* 清理失败不影响主流程 */
      }
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
   * 更新云端配置(地址 / 反馈开关 / 更新源)
   */
  /**
   * 更新云端配置。
   *
   * ⚠️ 只接受 clientId / feedbackEnabled / checkIntervalHours 三个字段。
   * endpoint 与 updateFeedUrl 由后台常量固定（CLOUD_ENDPOINT / UPDATE_FEED_URL），
   * 渲染层传什么都不采纳 —— 否则一个被篡改的渲染层就能把上报指向第三方。
   */
  updateCloudConfig(config: Partial<CloudConfig>): void {
    const { clientId, feedbackEnabled, checkIntervalHours } = config;
    this.config.cloud = {
      ...this.config.cloud,
      ...(clientId !== undefined ? { clientId } : {}),
      ...(feedbackEnabled !== undefined ? { feedbackEnabled } : {}),
      ...(checkIntervalHours !== undefined ? { checkIntervalHours } : {}),
    };
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