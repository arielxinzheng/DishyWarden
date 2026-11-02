/**
 * Prometheus Exporter
 * 
 * 将 Starlink 遥测数据导出为 Prometheus metrics 格式
 * 在端口 9817 提供 /metrics 端点
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import type { TelemetryData } from '../core/dishClient';
import type { RouterProbeResult } from '../core/routerProbeTypes';
import type { DataCollector } from './historian';

export interface ExporterConfig {
  port: number;              // HTTP 监听端口
  host?: string;             // 监听地址
  metricsPath?: string;      // metrics 端点路径
}

/**
 * Prometheus Exporter
 */
export class PrometheusExporter {
  private config: Required<ExporterConfig>;
  private collector: DataCollector;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(collector: DataCollector, config: Partial<ExporterConfig> = {}) {
    this.collector = collector;
    this.config = {
      port: config.port || 9817,
      host: config.host || '0.0.0.0',
      metricsPath: config.metricsPath || '/metrics',
    };
  }

  /**
   * 启动 HTTP 服务器
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        console.warn('[Exporter] Already running');
        resolve();
        return;
      }

      this.server = createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (error) => {
        console.error('[Exporter] Server error:', error);
        reject(error);
      });

      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`[Exporter] Listening on http://${this.config.host}:${this.config.port}${this.config.metricsPath}`);
        resolve();
      });
    });
  }

  /**
   * 停止 HTTP 服务器
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => {
        console.log('[Exporter] Stopped');
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * 处理 HTTP 请求
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse) {
    const { url } = req;

    if (url === this.config.metricsPath) {
      this.serveMetrics(req, res);
    } else if (url === '/health' || url === '/healthz') {
      this.serveHealth(req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }

  /**
   * 提供 /metrics 端点
   */
  private serveMetrics(_req: IncomingMessage, res: ServerResponse) {
    const telemetry = this.collector.getLatest();
    const routerProbe = this.collector.getRouterProbeResult();
    
    if (!telemetry) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('# No data available\n');
      return;
    }

    const metrics = this.generateMetrics(telemetry, routerProbe);
    
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(metrics);
  }

  /**
   * 提供 /health 端点
   */
  private serveHealth(_req: IncomingMessage, res: ServerResponse) {
    const stats = this.collector.getStats();
    const isHealthy = this.collector.isActive() && stats.lastSuccessTime !== null;

    res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: isHealthy ? 'healthy' : 'unhealthy',
      collector: {
        active: this.collector.isActive(),
        totalSamples: stats.totalSamples,
        failedSamples: stats.failedSamples,
        lastSuccess: stats.lastSuccessTime?.toISOString(),
        uptime: stats.uptime,
      },
    }));
  }

  /**
   * 生成 Prometheus metrics 文本
   */
  private generateMetrics(telemetry: TelemetryData, routerProbe: RouterProbeResult | null): string {
    const lines: string[] = [];

    // Helper function to add metric
    const addMetric = (name: string, value: number | string, help: string, type: string = 'gauge', labels?: Record<string, string>) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      
      const labelStr = labels 
        ? '{' + Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',') + '}'
        : '';
      
      lines.push(`${name}${labelStr} ${value}`);
    };

    // ========== Dish 指标 ==========
    
    // 连接状态
    const stateValue = telemetry.state === 'ONLINE' ? 1 : 0;
    addMetric('starlink_dish_up', stateValue, 'Dish online status (1=online, 0=offline)');
    addMetric('starlink_dish_uptime_seconds', telemetry.uptime, 'Dish uptime in seconds', 'counter');

    // 网络性能指标
    addMetric('starlink_ping_latency_ms', telemetry.popPingLatencyMs, 'Ping latency to Starlink PoP in milliseconds');
    addMetric('starlink_ping_drop_rate', telemetry.popPingDropRate, 'Ping packet drop rate (0.0-1.0)');
    
    // 额外延迟指标
    if (telemetry.publicPingLatencyMs !== undefined) {
      addMetric('starlink_public_ping_ms', telemetry.publicPingLatencyMs, 'Public ping latency in milliseconds (ICMP to probe node)');
    }
    if (telemetry.localGatewayLatencyMs !== undefined) {
      addMetric('starlink_local_gateway_ping_ms', telemetry.localGatewayLatencyMs, 'Local gateway ping latency in milliseconds (ICMP to default gateway)');
    }
    
    addMetric('starlink_downlink_throughput_bps', telemetry.downlinkThroughputBps, 'Downlink throughput in bits per second');
    addMetric('starlink_uplink_throughput_bps', telemetry.uplinkThroughputBps, 'Uplink throughput in bits per second');

    // 信号质量
    addMetric('starlink_snr', telemetry.snr, 'Signal-to-Noise Ratio');
    addMetric('starlink_currently_obstructed', telemetry.currentlyObstructed ? 1 : 0, 'Currently obstructed status');
    addMetric('starlink_fraction_obstructed', telemetry.fractionObstructed, 'Fraction of sky obstructed (0.0-1.0)');
    addMetric('starlink_seconds_obstructed', telemetry.secondsObstructed, 'Total seconds obstructed', 'counter');

    // 卫星信息
    addMetric('starlink_satellite_id', telemetry.satelliteId, 'Current satellite ID');
    addMetric('starlink_seconds_to_first_nonempty_slot', telemetry.secondsToFirstNonemptySlot, 'Seconds to first non-empty slot');

    // 硬件状态
    addMetric('starlink_dish_temperature_celsius', telemetry.dishTemperature, 'Dish temperature in Celsius');
    addMetric('starlink_power_supply_temperature_celsius', telemetry.powerSupplyTemperature, 'Power supply temperature in Celsius');

    // 版本信息（作为 label）
    addMetric('starlink_info', 1, 'Starlink device information', 'gauge', {
      hardware_version: telemetry.hardwareVersion,
      software_version: telemetry.softwareVersion,
    });

    // 告警计数
    addMetric('starlink_alerts_total', telemetry.alerts.length, 'Total number of active alerts');

    // ========== 采集器健康指标 ==========
    
    const stats = this.collector.getStats();
    
    // 采集器最后成功时间戳（Unix timestamp in seconds）
    const lastSuccessTs = stats.lastSuccessTime 
      ? Math.floor(stats.lastSuccessTime.getTime() / 1000) 
      : 0;
    addMetric('starlink_collector_last_success_timestamp', lastSuccessTs, 
      'Unix timestamp of last successful data collection (0 if never succeeded)', 'gauge');
    
    // 采集器总采样数和失败数
    addMetric('starlink_collector_samples_total', stats.totalSamples, 
      'Total number of samples collected', 'counter');
    addMetric('starlink_collector_samples_failed_total', stats.failedSamples, 
      'Total number of failed sample attempts', 'counter');

    // ========== Router 指标 ==========
    
    if (routerProbe) {
      // 路由器可达性
      addMetric('starlink_router_up', routerProbe.reachable ? 1 : 0, 'Router reachability status (1=reachable, 0=unreachable)');
      
      // RTT 延迟（不可达时为 -1）
      const rttValue = routerProbe.rttMs !== null ? routerProbe.rttMs : -1;
      addMetric('starlink_router_rtt_ms', rttValue, 'Router round-trip time in milliseconds (-1 if unreachable)');
      
      // 丢包率
      addMetric('starlink_router_packet_loss', routerProbe.packetLoss, 'Router packet loss rate (0.0-1.0)');
      
      // HTTP 健康检查（未启用时为 -1）
      const httpValue = routerProbe.httpOk === null ? -1 : (routerProbe.httpOk ? 1 : 0);
      addMetric('starlink_router_http_ok', httpValue, 'Router HTTP health check status (1=ok, 0=failed, -1=not enabled)');
      
      // 可信度标记（用于识别 VPN/隧道环境的 ICMP 篡改）
      const trustedValue = routerProbe.trusted === undefined ? -1 : (routerProbe.trusted ? 1 : 0);
      addMetric('starlink_router_probe_trusted', trustedValue, 'Router probe result trustworthiness (1=trusted, 0=untrusted due to ICMP spoofing, -1=not checked)');
    }

    return lines.join('\n') + '\n';
  }
}

/**
 * 创建 Prometheus exporter
 */
export function createExporter(collector: DataCollector, config?: Partial<ExporterConfig>): PrometheusExporter {
  return new PrometheusExporter(collector, config);
}