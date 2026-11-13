import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { createCollector, DataCollector } from '../collector/historian';
import { createExporter, PrometheusExporter } from '../collector/exporter';
import { ProbeRunner } from '../core/probeRunner';
import { createPrometheusManager, PrometheusManager } from './prometheus';
import { loadTLESeed, warmupTLESeed } from './tleSeed';
import { AlertManager } from '../alerting/manager';
import { getConfigManager } from '../config/manager';
import { createGrafanaManager, GrafanaManager } from '../prometheus/grafana';
import { CloudClient } from '../core/cloudClient';
import { UpdateManager, UpdateState } from '../core/updater';
import { runDishApiDump } from './dishApiDump';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let collector: DataCollector | null = null;
let exporter: PrometheusExporter | null = null;
let prometheus: PrometheusManager | null = null;
let alertManager: AlertManager | null = null;
let grafanaManager: GrafanaManager | null = null;
let probeRunner: ProbeRunner | null = null;
let storagePruneTimer: NodeJS.Timeout | null = null;
let cloudClient: CloudClient | null = null;
let updateManager: UpdateManager | null = null;
const configManager = getConfigManager();

/**
 * 固定打包态的 userData 目录。
 *
 * 产品从 SLMonitor 改名为 DishyWarden 之后，`name` / `productName` 一变，
 * Electron 推导出的 userData 路径就跟着漂（实测旧版本在不同平台分别落到了
 * `…/Application Support/SLMonitor` 和 `…/slmonitor` 两个目录）。
 * 路径漂移会直接造成「升级后配置和 3 天历史全没了」，云端升级方案也没法做
 * 版本对照 —— 所以这里显式钉死，并一次性迁移旧目录里的数据。
 *
 * 开发态保持 Electron 默认目录（`…/Electron`）不动，避免开发数据污染发布数据。
 */
function pinUserDataDir(): void {
  // 允许在未打包环境验证迁移逻辑（仅测试用，跑完删掉测试目录）
  if (!app.isPackaged && process.env.DW_USERDATA_TEST !== '1') return;
  const target = path.join(app.getPath('appData'), 'DishyWarden');
  // 旧版本可能落在这两个目录里（productName / name 两种解析结果）
  const legacy = ['SLMonitor', 'slmonitor']
    .map((n) => path.join(app.getPath('appData'), n))
    .filter((dir) => fs.existsSync(dir));

  // 注意用「是否已初始化」而不是「目录是否存在」：
  // Electron 在 setPath 生效前就可能先把 userData 目录建出来（里面只有 Cache 之类），
  // 按存在性判断会永远跳过迁移。
  const alreadyInitialized = fs.existsSync(path.join(target, 'config', 'config.json'));
  if (!alreadyInitialized) {
    const source = legacy.find((dir) => fs.existsSync(path.join(dir, 'config', 'config.json')))
      ?? legacy[0];
    if (source) {
      try {
        // 只迁需要保留的三样：配置、遥测/告警库、语言等 localStorage
        for (const sub of ['config', 'data', 'Local Storage']) {
          const from = path.join(source, sub);
          if (fs.existsSync(from)) {
            fs.cpSync(from, path.join(target, sub), { recursive: true });
          }
        }
        console.log(`[Main] userData 已从旧目录迁移: ${source} → ${target}`);
      } catch (err) {
        console.warn('[Main] userData 迁移失败（将使用空目录）:', err);
      }
    }
  }
  app.setPath('userData', target);
}

pinUserDataDir();

/**
 * 初始化云端相关能力（上报客户端 + 升级管理器）。
 *
 * 两者都**默认静默**：
 * - 没配 endpoint ⇒ 一个字节都不发
 * - 没配 updateFeedUrl ⇒ 不检查更新
 *
 * 这样云端服务还没上线时，客户端可以照常发布、零噪音。
 */
function initCloudServices(): void {
  // 匿名装机 ID：首次运行时生成随机 UUID v4 并落盘。
  // 不派生自任何硬件/用户信息，只用于升级漏斗按"装机"统计。
  try {
    if (!configManager.getConfig().cloud.clientId) {
      configManager.updateCloudConfig({ clientId: randomUUID() });
      console.log('[Main] 已生成匿名装机 ID');
    }
  } catch (err) {
    console.warn('[Main] 生成匿名装机 ID 失败:', err);
  }

  cloudClient = new CloudClient({
    getConfig: () => configManager.getConfig(),
    getAppVersion: () => app.getVersion(),
    getPlatform: () => process.platform,
  });

  updateManager = new UpdateManager({
    getConfig: () => configManager.getConfig(),
    getAppVersion: () => app.getVersion(),
    isPackaged: () => app.isPackaged,
    onState: (state: UpdateState) => {
      sendToRenderer('update-state', state);
    },
    report: (record) => {
      void cloudClient?.report(record);
    },
  });
}

/**
 * 解析应用图标路径。
 *
 * 打包后图标在 app 根目录的 build/icon.png（已在 build.files 白名单里）；
 * 开发态用项目根目录的同一个文件。两处都找不到时返回 undefined ——
 * Electron 会退回默认图标，不该因此起不来。
 */
function resolveAppIcon(): string | undefined {
  const candidates = [
    path.join(app.getAppPath(), 'build', 'icon.png'),
    path.join(__dirname, '../../build/icon.png'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 读不到就换下一个 */
    }
  }
  console.warn('[Main] 未找到应用图标 build/icon.png，使用 Electron 默认图标');
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    backgroundColor: '#0a0a0a', // 深色背景，匹配应用 dark mode
    // 窗口/任务栏图标。
    // Windows 上任务栏与 Alt-Tab 用的是**窗口图标**，不是 exe 内嵌图标 ——
    // 而 exe 内嵌图标要靠 rcedit 写（macOS 上需要 wine，wine 4.0.1 在新版
    // macOS 上根本跑不起来）。这里直接指定 PNG，绕开 exe 资源编辑，
    // 任务栏/Alt-Tab/标题栏图标都能正确显示。
    icon: resolveAppIcon(),
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
 * 安全地给渲染层推消息。
 *
 * ## 为什么不能只用 `mainWindow.isDestroyed()`
 *
 * `webContents.send()` 内部走的是 `webContents.mainFrame`(`WebFrameMain`),
 * 而**窗口活着不代表 frame 活着**:
 *
 * - 渲染进程崩溃 ⇒ frame 死, 但 window 与 webContents 都还"活着"
 * - 退出时 GPU 进程被 SIGTERM ⇒ network service 重启 ⇒ frame 被回收
 *
 * 实测(强杀渲染进程后):
 * ```
 *   win.isDestroyed()               = false   ← 窗口活着
 *   win.webContents.isDestroyed()   = false   ← webContents 也活着
 *   win.webContents.mainFrame       → 访问即抛 / send 抛
 *     "Render frame was disposed before WebFrameMain could be accessed"
 * ```
 *
 * ⇒ 守卫必须**再查一层 frame**。
 *
 * @param channel IPC 频道
 * @param payload  负载
 * @returns 是否真的发出去了
 */
function sendToRenderer(channel: string, payload: unknown): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  const wc = mainWindow.webContents;
  if (wc.isDestroyed()) return false;

  // frame 层守卫 —— 这一层才是真正会抛错的地方
  try {
    if (wc.mainFrame.isDestroyed()) return false;
  } catch {
    // 连 mainFrame 都访问不到 ⇒ frame 已经没了
    return false;
  }

  try {
    wc.send(channel, payload);
    return true;
  } catch (e) {
    // 竞态: 查完 frame 之后、send 之前, frame 可能正好被回收
    console.warn(`[Main] 推送到渲染层失败(${channel}):`, e);
    return false;
  }
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
    collector = createCollector({
      ...config.collector,
      probeNodes: config.probe.nodes, // 传递探针节点配置
    });
    
    console.log('[Main] 探针节点配置:', config.probe.nodes.map(n => `${n.id}(${n.type},enabled=${n.enabled})`).join(', '));

    // 监听采集事件
    collector.on('data', (data) => {
      // 发送数据到渲染进程
      sendToRenderer('telemetry-update', data);

      // 告警检查
      if (alertManager) {
        alertManager.checkTelemetry(data).catch((err) => {
          console.error('[Main] Alert check error:', err);
        });
      }
    });

    collector.on('anomalies', (anomalies) => {
      console.log('[Main] Detected anomalies:', anomalies);
      sendToRenderer('anomalies-detected', anomalies);
    });

    // 监听 outage 事件（非切换类中断）
    collector.on('outages', (outages) => {
      console.log(`[Main] 检测到 ${outages.length} 个 outage 事件`);
      if (alertManager) {
        alertManager.checkOutages(outages).catch((err) => {
          console.error('[Main] Outage check error:', err);
        });
      }
    });

    collector.on('error', (error) => {
      console.error('[Main] Collector error:', error);
    });

    // 启动采集器
    collector.start();

    // 启动探针节点管理(需求文档 2.1.3 网络连通性探测)
    probeRunner = new ProbeRunner(config.probe);
    probeRunner.on('result', (result, state) => {
      const tag = result.ok ? 'OK' : 'FAIL';
      console.log(
        `[Probe] ${tag} ${result.nodeId}: ` +
        (result.ok
          ? `${result.rttMs?.toFixed(1) ?? '?'}ms${result.detail ? ' / ' + result.detail : ''}`
          : result.error ?? '未知错误')
      );
      // 实时推给渲染层(设置页的状态灯)
      sendToRenderer('probe-result', result);

      // 将探针结果传递给告警管理器
      if (alertManager) {
        // DNS 双轨探测
        if (result.dualDns) {
          alertManager.checkDnsProbe(result);
        }
        // ICMP 探针状态（供依赖压制逻辑使用）
        if (state.nodeId === 'public-ping' || state.nodeId === 'local-gateway') {
          alertManager.updateIcmpProbeState(
            state.nodeId,
            state.reachable,
            state.consecutiveFailures
          );
        }
      }
    });
    probeRunner.start();

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
    alertManager = new AlertManager(config.notifications, config.alertThresholds);
    
    // 启动定期检查需要更新通知的告警
    alertManager.startUpdateNotificationCheck(60000); // 每分钟检查一次
    
    // 启动采集器心跳检查（3 分钟超时，每 30 秒检查一次）
    alertManager.startHeartbeatCheck(3, 30000);
    // 离线队列兜底清理：每 24 小时回收一次已冲刷的记录
    alertManager.startOfflineQueueCleanup(86400000);

    // 监听告警事件
    alertManager.on('alert:new', (alert) => {
      console.log('[Main] New alert:', alert.summary);
      sendToRenderer('alert-new', alert);
    });

    alertManager.on('alert:resolved', (alert) => {
      console.log('[Main] Alert resolved:', alert.summary);
      sendToRenderer('alert-resolved', alert);
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

  if (probeRunner) {
    probeRunner.stop();
    probeRunner = null;
  }

  if (exporter) {
    await exporter.stop();
    exporter = null;
  }

  if (alertManager) {
    // ⚠️ 方法名是 close() 不是 stop() —— 3f7717a 重命名时漏改了调用点。
    //    调 stop() 会抛 TypeError, 导致退出流程中断(定时器不清理、DB 不关)。
    alertManager.close();
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
 * IPC 处理器：获取区间内的卫星切换事件
 *
 * 渲染层在「延迟与丢包走势」图上标注 ★ 卫星切换 点时用。
 */
ipcMain.handle('get-handoffs', (_event, seconds: number) => {
  return collector?.getHandoffs(seconds) || [];
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
 * IPC 处理器：获取遮挡事件历史
 * 
 * @param fromMs 起始时间 epoch ms
 * @param toMs 结束时间 epoch ms
 * @param limit 最多返回多少条事件
 */
ipcMain.handle('get-obstruction-events', (_event, fromMs: number, toMs: number, limit?: number) => {
  const store = (collector as any)?.store; // 访问 collector 的 private store
  if (!store) return [];
  return store.queryObstructionEvents(fromMs, toMs, limit);
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
 * IPC 处理器：立即重试设备连接（场景 A 引导页的「重试连接」按钮）
 *
 * `updateConfig({})` 传空对象 = 配置不变但强制 stop()/start() ——
 * start() 会立刻 collect() 一次, 结果经既有事件流回渲染层:
 *   成功 → collector 'data' → 'telemetry-update' → 引导页自动消失
 *   失败 → collect() 抛错被 catch, 渲染层靠下一次 getLatestTelemetry
 *          仍拿不到数据维持 error 态
 *
 * ⚠️ `historian.collect()` 失败只 emit('error') 打日志, 不产生新遥测 ——
 * 所以渲染层的判定依据仍然是「是否收到 telemetry-update」, 与
 * 本 IPC 的返回值无关。返回值只表示「已触发重试」。
 */
ipcMain.handle('retry-dish-connection', () => {
  if (!collector) return { success: false, error: 'collector 未初始化' };
  collector.updateConfig({});
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
 * IPC 处理器：忽略告警
 */
ipcMain.handle('snooze-alert', (_event, params: {
  alertKey: string;
  snoozeType: 'temporary' | 'until_resolved';
  durationMs?: number;
}) => {
  if (!alertManager) return { success: false, error: 'AlertManager 未初始化' };
  
  try {
    alertManager.snoozeAlert(params.alertKey, params.snoozeType, params.durationMs);
    // 广播状态变更：仪表盘横幅与告警中心都要重拉，保证跨页面一致
    sendToRenderer('alerts-changed', { alertKey: params.alertKey, action: 'snooze' });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : '操作失败' };
  }
});

/**
 * IPC 处理器：取消忽略告警
 */
ipcMain.handle('unsnooze-alert', (_event, alertKey: string) => {
  if (!alertManager) return { success: false, error: 'AlertManager 未初始化' };
  
  try {
    alertManager.unsnoozeAlert(alertKey);
    sendToRenderer('alerts-changed', { alertKey, action: 'unsnooze' });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : '操作失败' };
  }
});

/**
 * IPC 处理器：撤销误报标记（把告警退回活跃列表）
 */
ipcMain.handle('unmark-false-positive', (_event, alertKey: string) => {
  if (!alertManager) return { success: false, error: 'AlertManager 未初始化' };

  try {
    alertManager.unmarkFalsePositive(alertKey);
    sendToRenderer('alerts-changed', { alertKey, action: 'unmark-false-positive' });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : '操作失败' };
  }
});

/**
 * IPC 处理器：标记误报
 */
ipcMain.handle('mark-false-positive', (_event, params: {
  alertKey: string;
  deviceId?: string;
}) => {
  if (!alertManager) return { success: false, error: 'AlertManager 未初始化' };
  
  try {
    alertManager.markFalsePositive(params.alertKey, params.deviceId);
    sendToRenderer('alerts-changed', { alertKey: params.alertKey, action: 'mark-false-positive' });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : '操作失败' };
  }
});

/**
 * IPC 处理器：获取升级状态
 */
ipcMain.handle('get-update-state', () => {
  if (!updateManager) {
    return { status: 'disabled', currentVersion: app.getVersion() };
  }
  return updateManager.getState();
});

/**
 * IPC 处理器：手动检查更新（设置页按钮）
 */
ipcMain.handle('check-for-update', async () => {
  if (!updateManager) {
    return { status: 'disabled', currentVersion: app.getVersion() };
  }
  return await updateManager.check(true);
});

/**
 * IPC 处理器：下载更新（用户确认后）
 */
ipcMain.handle('download-update', async () => {
  if (!updateManager) return { success: false, error: '更新管理器未初始化' };
  const ok = await updateManager.download();
  return ok ? { success: true } : { success: false, error: '下载失败' };
});

/**
 * IPC 处理器：安装更新并重启（需求 2.8.3）
 */
ipcMain.handle('install-update', (_event, params?: { toVersion?: string }) => {
  if (!updateManager) return { success: false, error: '更新管理器未初始化' };
  const ok = updateManager.install(params?.toVersion);
  return ok ? { success: true } : { success: false, error: '安装失败' };
});

/**
 * IPC 处理器：保存云端配置（地址 / 反馈开关 / 更新源）
 */
ipcMain.handle('update-cloud-config', (_event, params: {
  // endpoint / updateFeedUrl 不在可写字段里 —— 由后台常量固定
  // （见 config/manager.ts 的 CLOUD_ENDPOINT / UPDATE_FEED_URL）
  clientId?: string;
  feedbackEnabled?: boolean;
  checkIntervalHours?: number;
}) => {
  try {
    configManager.updateCloudConfig(params ?? {});
    // 配置变了 ⇒ 轮询节奏与更新源都可能变，重新排一次
    updateManager?.start();
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : '保存失败' };
  }
});

/**
 * IPC 处理器：上报告警误报负样本
 *
 * 只在用户明确确认后调用；上报失败不影响本地标记（本地才是真值）。
 */
ipcMain.handle('report-false-positive', (_event, params: {
  alertKey: string;
  severity?: string;
  title?: string;
  evidence?: unknown;
  note?: string;
}) => {
  if (!cloudClient) return { success: false, skipped: true };
  if (!params || typeof params.alertKey !== 'string') {
    return { success: false, error: '缺少 alertKey' };
  }
  void cloudClient.report({
    type: 'alert_false_positive',
    alert_key: params.alertKey,
    severity: params.severity,
    title: params.title,
    evidence: params.evidence,
    note: params.note,
  });
  return { success: true };
});

/**
 * IPC 处理器：获取最新 DNS 探测结果
 */
ipcMain.handle('get-latest-dns-probe', () => {
  if (!probeRunner) return null;
  
  // 查找 DNS 探测节点（id 为 dns-dual-check）
  const dnsState = probeRunner.getState('dns-dual-check');
  if (!dnsState || !dnsState.last) return null;
  
  const result = dnsState.last;
  // 确保有 dualDns 数据
  if (!result.dualDns) return null;
  
  return {
    node_id: result.nodeId,
    timestamp: result.ts,
    user_dns: result.dualDns.user,
    baseline_dns: result.dualDns.baseline,
  };
});

/**
 * IPC 处理器：获取告警历史
 *
 * 条件是契约对象，原样透传给 manager。IPC 层不做字段拆解、不设默认值 ——
 * 否则每加一个筛选维度（时间范围就是这么来的）都要在这里再写一遍转发。
 */
ipcMain.handle(
  'get-alert-history',
  (_event, params: import('../alerting/database').AlertHistoryQuery = {}) => {
    if (!alertManager) return { alerts: [], total: 0 };
    return alertManager.queryHistory(params ?? {});
  }
);

/**
 * IPC 处理器：更新告警通知配置
 */
ipcMain.handle('update-notification-config', (_event, config) => {
  configManager.updateNotificationConfig(config);
  
  // 重新创建告警管理器以应用新配置
  if (alertManager) {
    alertManager.close();
    const config = configManager.getConfig();
    alertManager = new AlertManager(config.notifications, config.alertThresholds);
    alertManager.startUpdateNotificationCheck(60000);
    // ⚠️ 必须一起重启心跳检查 —— stop() 会 clearInterval(heartbeatInterval),
    //    不重启的话, 用户改过一次通知设置后, 采集器失联就永远不再告警了。
    alertManager.startHeartbeatCheck(3, 30000);
    // 离线队列兜底清理：每 24 小时回收一次已冲刷的记录
    alertManager.startOfflineQueueCleanup(86400000);
    
    // 重新绑定事件监听
    alertManager.on('alert:new', (alert) => {
      console.log('[Main] New alert:', alert.summary);
      sendToRenderer('alert-new', alert);
    });

    alertManager.on('alert:resolved', (alert) => {
      console.log('[Main] Alert resolved:', alert.summary);
      sendToRenderer('alert-resolved', alert);
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
 * IPC 处理器：更新探针配置(节点列表 + 路由跟踪目标)
 */
ipcMain.handle('update-probe-config', (_event, config) => {
  configManager.updateProbeConfig(config);

  // 探针节点改动要重启探测服务才能生效(间隔/超时变了必须重建定时器)
  if (probeRunner) {
    probeRunner.applyConfig(configManager.getConfig().probe);
  }

  return { success: true };
});

/**
 * IPC 处理器：取所有探针节点的当前状态
 */
ipcMain.handle('get-probe-states', () => {
  return probeRunner?.getStates() ?? [];
});

/**
 * IPC 处理器：手动探测某个节点一次(设置页的"立即测试")
 */
ipcMain.handle('probe-node-now', async (_event, nodeId: string) => {
  const result = await probeRunner?.probeNow(nodeId);
  return result ?? null;
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

/**
 * IPC 处理器：获取最近一次路由器探测结果
 *
 * 需求文档 2.1.2「路由器状态监控」的数据出口。
 * 之前探测结果只存在于 collector 内部, 既不进 Prometheus 也不进 UI ——
 * 采集了但用户看不到。
 *
 * `trusted` 字段来自 ICMP 基线自检: 某些网络环境(VPN/隧道)会应答所有 ICMP,
 * 此时可达性与延迟都是环境造出来的假象, 界面必须如实标注。
 */
ipcMain.handle('get-router-probe', () => {
  return collector?.getRouterProbeResult() ?? null;
});

/**
 * 执行 traceroute
 * 
 * 默认目标: 8.8.8.8 (Google DNS，全球可达性好)
 * 可通过参数指定其他目标
 */
ipcMain.handle('run-traceroute', async (_event, target?: string) => {
  const { traceroute } = await import('../core/traceroute');
  // 默认目标取配置(设置页的「探针节点管理」), 默认 example.com。
  // 原来硬编码 8.8.8.8 —— 在受限网络(公司 VPN/防火墙)下必然每跳超时,
  // 用户只能看到一串 `*`。
  const fallback = configManager.getConfig().probe?.traceTarget || 'example.com';
  return traceroute(target?.trim() || fallback, {
    maxHops: 15,        // 限制跳数，Starlink 通常 5-10 跳
    timeout: 30000,     // 30s 总超时
    // 单跳等待 1s（原来 2s）。实测本链路 RTT 最大 360ms，1s 足够；
    // 而无响应的跳每跳要白等一个 hopTimeout，是总耗时的大头（关掉反查 DNS 后
    // 15 跳从 20-23s 降到 7-10s，反查本身另占约 13s）。
    hopTimeout: 1,
    // 每跳只探 1 次（系统默认 3 次）。高延迟链路（200-300ms/跳）上 3 次探测
    // 串行跑完再叠加无响应跳的 3×2s 等待，10-15 跳必然撞 30s 总超时，
    // 界面永远只有半截路径、结论永远是「未到达」。降到 1 次后几秒即可跑完。
    probes: 1,
  });
});

app.whenReady().then(async () => {
  // ── 诊断模式：--dump-dish-api ─────────────────────────────
  // 打印完就退出，不开窗口、不启动采集。用来问设备「支持哪些 oneof 分支」。
  if (process.argv.includes('--dump-dish-api')) {
    const argv = process.argv;
    const ipIdx = argv.indexOf('--dish-ip');
    const portIdx = argv.indexOf('--dish-port');
    const cfg = configManager.getConfig().collector;
    const host = ipIdx >= 0 && argv[ipIdx + 1] ? argv[ipIdx + 1] : cfg.dishAddress;
    const port = portIdx >= 0 && argv[portIdx + 1] ? Number(argv[portIdx + 1]) : cfg.dishPort;
    try {
      await runDishApiDump({ host, port });
    } catch (err) {
      console.error('[DishApiDump] 探测失败:', err);
    }
    app.exit(0);
    return;
  }

  // 后台预热种子数据, 不阻塞窗口显示
  warmupTLESeed();

  initCloudServices();

  await startBackgroundServices();
  createWindow();

  // 升级嗅探：延迟首查 + 之后按间隔轮询（12h ± 抖动）。
  // 任何失败都在 UpdateManager 内部降级，绝不影响监控主职。
  updateManager?.start();
  // 启动心跳：兼作"升级成功"确认与版本分布统计
  updateManager?.reportHeartbeat();

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
  updateManager?.stop();
  await stopBackgroundServices();
});