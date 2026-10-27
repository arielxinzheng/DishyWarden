import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCollector, DataCollector } from '../collector/historian';
import { createExporter, PrometheusExporter } from '../collector/exporter';
import { createPrometheusManager, PrometheusManager } from './prometheus';
import { loadTLESeed, warmupTLESeed } from './tleSeed';
import { AlertManager } from '../alerting/manager';
import { getConfigManager } from '../config/manager';
import { createGrafanaManager, GrafanaManager } from '../prometheus/grafana';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let collector: DataCollector | null = null;
let exporter: PrometheusExporter | null = null;
let prometheus: PrometheusManager | null = null;
let alertManager: AlertManager | null = null;
let grafanaManager: GrafanaManager | null = null;
let storagePruneTimer: NodeJS.Timeout | null = null;
const configManager = getConfigManager();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    backgroundColor: '#0a0a0a', // 深色背景，匹配应用 dark mode
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    show: true, // 立即显示窗口
  });

  // 开发模式：使用 Vite 开发服务器
  // 生产模式：加载打包后的文件
  const url = process.env.VITE_DEV_SERVER_URL
  if (url) {
    console.log('[Main] Loading URL:', url);
    mainWindow.loadURL(url);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  // 监听加载事件
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Main] Page loaded successfully');
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[Main] Failed to load:', errorCode, errorDescription);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * 启动后台服务（数据采集器 + Prometheus exporter + Prometheus）
 */
async function startBackgroundServices() {
  try {
    // 加载配置
    const config = configManager.getConfig();

    // 1. 启动 Prometheus（如果二进制存在）
    try {
      prometheus = createPrometheusManager(config.prometheus);
      
      await prometheus.start();
      console.log('[Main] Prometheus started successfully');
    } catch (error) {
      console.warn('[Main] Prometheus not available (binary not found), skipping...');
      console.warn('[Main] Run `npm run download-prometheus` to download Prometheus binaries');
    }

    // 2. 创建数据采集器
    collector = createCollector(config.collector);

    // 监听采集事件
    collector.on('data', (data) => {
      // 发送数据到渲染进程
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('telemetry-update', data);
      }

      // 告警检查
      if (alertManager) {
        alertManager.checkTelemetry(data).catch((err) => {
          console.error('[Main] Alert check error:', err);
        });
      }
    });

    collector.on('anomalies', (anomalies) => {
      console.log('[Main] Detected anomalies:', anomalies);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('anomalies-detected', anomalies);
      }
    });

    collector.on('error', (error) => {
      console.error('[Main] Collector error:', error);
    });

    // 启动采集器
    collector.start();

    // 历史库维护: 启动即清一次过期数据, 之后每 6 小时一次
    try {
      const pruned = collector.pruneStorage();
      if (pruned && (pruned.samples || pruned.hourly)) {
        console.log(`[Main] 历史库清理: 明细 ${pruned.samples} 行, 聚合 ${pruned.hourly} 行`);
      }
    } catch (error) {
      console.warn('[Main] 历史库清理失败:', error);
    }

    storagePruneTimer = setInterval(() => {
      try {
        collector?.pruneStorage();
      } catch (error) {
        console.warn('[Main] 历史库定期清理失败:', error);
      }
    }, 6 * 60 * 60 * 1000);

    // 3. 创建 Prometheus exporter
    exporter = createExporter(collector, {
      port: 9817,
      host: '0.0.0.0',
    });

    // 启动 exporter
    await exporter.start();
    console.log('[Main] Prometheus exporter started on :9817/metrics');

    // 4. 启动告警管理器
    alertManager = new AlertManager(config.notifications);
    
    // 启动定期检查需要更新通知的告警
    alertManager.startUpdateNotificationCheck(60000); // 每分钟检查一次

    // 监听告警事件
    alertManager.on('alert:new', (alert) => {
      console.log('[Main] New alert:', alert.summary);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('alert-new', alert);
      }
    });

    alertManager.on('alert:resolved', (alert) => {
      console.log('[Main] Alert resolved:', alert.summary);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('alert-resolved', alert);
      }
    });

    console.log('[Main] Alert manager started');

    console.log('[Main] All background services started successfully');

  } catch (error) {
    console.error('[Main] Failed to start background services:', error);
  }
}

/**
 * 停止后台服务
 */
async function stopBackgroundServices() {
  console.log('[Main] Stopping background services...');

  if (storagePruneTimer) {
    clearInterval(storagePruneTimer);
    storagePruneTimer = null;
  }

  if (collector) {
    // dispose 会一并关闭历史库(WAL checkpoint + close)
    collector.dispose();
    collector = null;
  }

  if (exporter) {
    await exporter.stop();
    exporter = null;
  }

  if (alertManager) {
    alertManager.stop();
    alertManager = null;
  }

  if (prometheus) {
    await prometheus.stop();
    prometheus = null;
  }

  console.log('[Main] Background services stopped');
}

/**
 * IPC 处理器：获取最新遥测数据
 */
ipcMain.handle('get-latest-telemetry', () => {
  return collector?.getLatest() || null;
});

/**
 * IPC 处理器：获取最新一份遮挡图及其采集时刻
 *
 * 单独开一个通道而不是塞进 get-latest-telemetry, 是因为遮挡图
 * 需要独立标注数据时间和来源(真实/模拟) —— 用户必须能分辨
 * 看到的是设备实测还是演示数据。
 */
ipcMain.handle('get-latest-obstruction', () => {
  return collector?.getLatestObstruction() || null;
});

/**
 * IPC 处理器：获取历史数据
 */
ipcMain.handle('get-history', (_event, seconds: number) => {
  return collector?.getHistory(seconds) || [];
});

/**
 * IPC 处理器：获取区间统计摘要（概览带用）
 */
ipcMain.handle('get-history-summary', (_event, seconds: number) => {
  return collector?.getSummary(seconds) || null;
});

/**
 * IPC 处理器：获取历史库物理状态
 */
ipcMain.handle('get-storage-stats', () => {
  return collector?.getStorageStats() || null;
});

/**
 * IPC 处理器：手动清理过期数据
 */
ipcMain.handle('prune-storage', () => {
  return collector?.pruneStorage() || null;
});

/**
 * IPC 处理器：获取采集器统计信息
 */
ipcMain.handle('get-collector-stats', () => {
  return collector?.getStats() || null;
});

/**
 * IPC 处理器：更新采集器配置
 */
ipcMain.handle('update-collector-config', (_event, config) => {
  collector?.updateConfig(config);
  return { success: true };
});

/**
 * IPC 处理器：获取 Prometheus 状态
 */
ipcMain.handle('get-prometheus-status', () => {
  return prometheus?.getStatus() || { running: false };
});

/**
 * IPC 处理器：获取活跃告警列表
 */
ipcMain.handle('get-active-alerts', () => {
  return alertManager?.getActiveAlerts() || [];
});

/**
 * IPC 处理器：获取告警历史
 */
ipcMain.handle('get-alert-history', (_event, params: {
  limit?: number;
  offset?: number;
  severity?: string;
  status?: string;
}) => {
  if (!alertManager) return { alerts: [], total: 0 };
  
  const { limit = 100, offset = 0, severity, status } = params;
  const alerts = alertManager.getAlertHistory(
    limit,
    offset,
    severity as any,
    status as any
  );
  const total = alertManager.getAlertCount(
    severity as any,
    status as any
  );
  
  return { alerts, total };
});

/**
 * IPC 处理器：更新告警通知配置
 */
ipcMain.handle('update-notification-config', (_event, config) => {
  configManager.updateNotificationConfig(config);
  
  // 重新创建告警管理器以应用新配置
  if (alertManager) {
    alertManager.stop();
    alertManager = new AlertManager(configManager.getConfig().notifications);
    alertManager.startUpdateNotificationCheck(60000);
    
    // 重新绑定事件监听
    alertManager.on('alert:new', (alert) => {
      console.log('[Main] New alert:', alert.summary);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('alert-new', alert);
      }
    });

    alertManager.on('alert:resolved', (alert) => {
      console.log('[Main] Alert resolved:', alert.summary);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('alert-resolved', alert);
      }
    });
  }

  return { success: true };
});

/**
 * IPC 处理器：获取配置
 */
ipcMain.handle('get-config', () => {
  return configManager.getConfig();
});

/**
 * IPC 处理器：更新采集器配置
 */
ipcMain.handle('update-collector-config-settings', (_event, config) => {
  configManager.updateCollectorConfig(config);
  
  // 应用到当前运行的采集器
  if (collector) {
    collector.updateConfig(config);
  }
  
  return { success: true };
});

/**
 * IPC 处理器：更新 Prometheus 配置
 */
ipcMain.handle('update-prometheus-config', (_event, config) => {
  configManager.updatePrometheusConfig(config);
  
  // 注意: Prometheus 配置更改需要重启服务
  return { success: true, requiresRestart: true };
});

/**
 * IPC 处理器：重置配置
 */
ipcMain.handle('reset-config', () => {
  configManager.reset();
  return { success: true, requiresRestart: true };
});

/**
 * IPC 处理器：更新 Grafana 配置
 */
ipcMain.handle('update-grafana-config', (_event, config) => {
  configManager.updateGrafanaConfig(config);
  return { success: true };
});

/**
 * IPC 处理器：配置 Grafana (一键配置)
 */
ipcMain.handle('provision-grafana', async () => {
  try {
    const config = configManager.getConfig();
    
    if (!config.grafana.enabled) {
      return { success: false, error: 'Grafana integration is not enabled' };
    }

    // 创建 Grafana 管理器
    grafanaManager = createGrafanaManager({
      url: config.grafana.url,
      apiKey: config.grafana.apiKey || undefined,
      username: config.grafana.username || undefined,
      password: config.grafana.password || undefined,
    });

    // 执行自动配置
    const prometheusUrl = `http://localhost:${config.prometheus.port}`;
    const result = await grafanaManager.provision(prometheusUrl);

    return {
      success: true,
      dataSourceId: result.dataSourceId,
      dashboardUrl: result.dashboardUrl,
    };
  } catch (error) {
    console.error('[Main] Grafana provisioning failed:', error);
    return {
      success: false,
      error: (error as Error).message,
    };
  }
});

/**
 * IPC 处理器：检查 Grafana 连接
 */
ipcMain.handle('check-grafana-connection', async () => {
  try {
    const config = configManager.getConfig();
    
    if (!config.grafana.enabled) {
      return { connected: false, error: 'Grafana integration is not enabled' };
    }

    const manager = createGrafanaManager({
      url: config.grafana.url,
      apiKey: config.grafana.apiKey || undefined,
      username: config.grafana.username || undefined,
      password: config.grafana.password || undefined,
    });

    const connected = await manager.checkConnection();
    return { connected };
  } catch (error) {
    return {
      connected: false,
      error: (error as Error).message,
    };
  }
});

/**
 * IPC 处理器：获取内置 TLE 种子数据
 *
 * 卫星雷达在断网 / 上游限流时用它兜底，保证页面不会卡在「正在计算」。
 */
ipcMain.handle('get-tle-seed', () => {
  const seed = loadTLESeed();
  if (!seed) return null;
  return {
    fetchedAt: seed.fetchedAt,
    source: seed.source,
    shells: seed.shells,
    data: seed.data,
  };
});

app.whenReady().then(async () => {
  // 后台预热种子数据, 不阻塞窗口显示
  warmupTLESeed();

  await startBackgroundServices();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  await stopBackgroundServices();
});