/**
 * Prometheus 进程管理
 * 
 * 负责启动和管理内置的 Prometheus 二进制文件
 */

import { spawn, ChildProcess } from 'child_process';
import { app } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

export interface PrometheusConfig {
  dataDir: string;           // 数据存储目录
  configPath: string;        // prometheus.yml 配置文件路径
  port: number;              // HTTP 监听端口
  retentionTime?: string;    // 数据保留时间
  scrapeInterval?: string;   // 采集间隔
}

export class PrometheusManager {
  private config: Required<PrometheusConfig>;
  private process: ChildProcess | null = null;
  private isRunning = false;

  constructor(config: Partial<PrometheusConfig> = {}) {
    const dataDir = config.dataDir || path.join(app.getPath('userData'), 'data', 'prometheus');
    
    this.config = {
      dataDir,
      configPath: config.configPath || path.join(dataDir, 'prometheus.yml'),
      port: config.port || 9090,
      retentionTime: config.retentionTime || '90d',
      scrapeInterval: config.scrapeInterval || '30s',
    };
  }

  /**
   * 启动 Prometheus
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('[Prometheus] Already running');
      return;
    }

    // 确保数据目录存在
    await this.ensureDirectories();

    // 生成配置文件
    await this.generateConfig();

    // 获取 Prometheus 二进制路径
    const prometheusBin = this.getPrometheusBinary();

    if (!existsSync(prometheusBin)) {
      throw new Error(`Prometheus binary not found at: ${prometheusBin}`);
    }

    // 启动 Prometheus 进程
    const args = [
      `--config.file=${this.config.configPath}`,
      `--storage.tsdb.path=${this.config.dataDir}`,
      `--web.listen-address=:${this.config.port}`,
      `--storage.tsdb.retention.time=${this.config.retentionTime}`,
      '--web.enable-lifecycle',
      '--web.enable-admin-api',
    ];

    console.log(`[Prometheus] Starting: ${prometheusBin} ${args.join(' ')}`);

    this.process = spawn(prometheusBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (data) => {
      console.log(`[Prometheus] ${data.toString().trim()}`);
    });

    this.process.stderr?.on('data', (data) => {
      console.error(`[Prometheus] ${data.toString().trim()}`);
    });

    this.process.on('error', (error) => {
      console.error('[Prometheus] Process error:', error);
      this.isRunning = false;
    });

    this.process.on('exit', (code) => {
      console.log(`[Prometheus] Process exited with code ${code}`);
      this.isRunning = false;
      this.process = null;
    });

    this.isRunning = true;

    // 等待 Prometheus 启动
    await this.waitForReady();
  }

  /**
   * 停止 Prometheus
   */
  async stop(): Promise<void> {
    if (!this.process || !this.isRunning) {
      return;
    }

    return new Promise((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      this.process.once('exit', () => {
        console.log('[Prometheus] Stopped');
        this.isRunning = false;
        this.process = null;
        resolve();
      });

      // 发送 SIGTERM 信号
      this.process.kill('SIGTERM');

      // 5秒后强制杀死
      setTimeout(() => {
        if (this.process) {
          console.warn('[Prometheus] Force killing process');
          this.process.kill('SIGKILL');
        }
      }, 5000);
    });
  }

  /**
   * 重载配置
   */
  async reload(): Promise<void> {
    if (!this.isRunning) {
      throw new Error('Prometheus is not running');
    }

    // 生成新配置
    await this.generateConfig();

    // 发送 SIGHUP 信号重载配置
    this.process?.kill('SIGHUP');
    console.log('[Prometheus] Configuration reloaded');
  }

  /**
   * 获取 Prometheus 状态
   */
  getStatus() {
    return {
      running: this.isRunning,
      port: this.config.port,
      dataDir: this.config.dataDir,
      pid: this.process?.pid,
    };
  }

  /**
   * 确保必要的目录存在
   */
  private async ensureDirectories(): Promise<void> {
    await fs.mkdir(this.config.dataDir, { recursive: true });
    await fs.mkdir(path.dirname(this.config.configPath), { recursive: true });
  }

  /**
   * 生成 Prometheus 配置文件
   */
  private async generateConfig(): Promise<void> {
    const config = `
# Prometheus configuration for DishyWarden
global:
  scrape_interval: ${this.config.scrapeInterval}
  evaluation_interval: ${this.config.scrapeInterval}
  external_labels:
    monitor: 'slmonitor'

# Scrape configurations
scrape_configs:
  # Starlink metrics from local exporter
  - job_name: 'starlink'
    static_configs:
      - targets: ['localhost:9817']
        labels:
          source: 'slmonitor-exporter'

# Alerting rules
rule_files:
  - 'alerts.yml'

# Alertmanager configuration (optional)
# alerting:
#   alertmanagers:
#     - static_configs:
#         - targets: ['localhost:9093']
`.trim();

    await fs.writeFile(this.config.configPath, config, 'utf-8');
    console.log(`[Prometheus] Configuration written to ${this.config.configPath}`);

    // 生成告警规则文件
    await this.generateAlertRules();
  }

  /**
   * 生成告警规则
   */
  private async generateAlertRules(): Promise<void> {
    const alertsPath = path.join(path.dirname(this.config.configPath), 'alerts.yml');
    
    const rules = `
groups:
  - name: starlink_alerts
    interval: 30s
    rules:
      # 设备离线
      - alert: StarlinkDishOffline
        expr: starlink_dish_up == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Starlink dish is offline"
          description: "Dish has been offline for more than 2 minutes"

      # 高延迟
      - alert: StarlinkHighLatency
        expr: starlink_ping_latency_ms > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High latency detected"
          description: "Ping latency is {{ $value }}ms (threshold: 100ms)"

      # 严重高延迟
      - alert: StarlinkCriticalLatency
        expr: starlink_ping_latency_ms > 200
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Critical latency detected"
          description: "Ping latency is {{ $value }}ms (threshold: 200ms)"

      # 高丢包率
      - alert: StarlinkHighPacketLoss
        expr: starlink_ping_drop_rate > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High packet loss detected"
          description: "Packet loss is {{ $value | humanizePercentage }} (threshold: 5%)"

      # 低吞吐量
      - alert: StarlinkLowThroughput
        expr: starlink_downlink_throughput_bps < 10000000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Low throughput detected"
          description: "Download speed is {{ $value | humanize }}bps (threshold: 10Mbps)"

      # 遮挡
      - alert: StarlinkObstruction
        expr: starlink_fraction_obstructed > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Sky obstruction detected"
          description: "{{ $value | humanizePercentage }} of sky is obstructed"

      # 严重遮挡
      - alert: StarlinkSevereObstruction
        expr: starlink_fraction_obstructed > 0.15
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Severe sky obstruction"
          description: "{{ $value | humanizePercentage }} of sky is obstructed"

      # 高温
      - alert: StarlinkHighTemperature
        expr: starlink_dish_temperature_celsius > 60
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High dish temperature"
          description: "Dish temperature is {{ $value }}°C (threshold: 60°C)"

      # 采集器心跳失联（3分钟未更新）
      - alert: StarlinkCollectorHeartbeatLost
        expr: (time() - starlink_collector_last_success_timestamp) > 180
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Collector heartbeat lost"
          description: "No successful data collection for {{ $value | humanizeDuration }} (threshold: 3 minutes)"

      # 采集器指标缺失（备用规则，用于检测 exporter 完全下线）
      - alert: StarlinkCollectorAbsent
        expr: absent(starlink_collector_last_success_timestamp)
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Collector metrics absent"
          description: "Starlink collector metrics are not being scraped"
`.trim();

    await fs.writeFile(alertsPath, rules, 'utf-8');
    console.log(`[Prometheus] Alert rules written to ${alertsPath}`);
  }

  /**
   * 获取 Prometheus 二进制路径
   */
  private getPrometheusBinary(): string {
    const platform = process.platform;
    const isDev = !app.isPackaged;

    let binaryName = 'prometheus';
    if (platform === 'win32') {
      binaryName = 'prometheus.exe';
    }

    if (isDev) {
      // 开发环境：从 resources 目录
      return path.join(process.cwd(), 'resources', 'prometheus', platform, binaryName);
    } else {
      // 生产环境：从打包后的 resources 目录
      return path.join(process.resourcesPath, 'prometheus', platform, binaryName);
    }
  }

  /**
   * 等待 Prometheus 就绪
   */
  private async waitForReady(timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(`http://localhost:${this.config.port}/-/ready`);
        if (response.ok) {
          console.log('[Prometheus] Ready');
          return;
        }
      } catch (error) {
        // 继续等待
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    throw new Error('Prometheus failed to start within timeout');
  }
}

/**
 * 创建 Prometheus 管理器实例
 */
export function createPrometheusManager(config?: Partial<PrometheusConfig>): PrometheusManager {
  return new PrometheusManager(config);
}