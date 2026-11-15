/**
 * 升级管理器（主进程侧）—— electron-updater 封装
 *
 * 设计依据：CloudServer/DESIGN.md §3（升级链路 路线 A）
 *
 * ## 铁律：升级嗅探绝不能影响 7×24 监控主职
 *
 * 任何异常都在这里被吞掉并降级成状态，绝不外抛到主进程、绝不打断采集器。
 * 渲染层拿到的状态永远是**结构校验过**的（踩坑 §23：不可信数据不得直进渲染层，
 * 否则一个坏形状能把整个仪表盘清空）。
 *
 * ## 轮询节奏
 *
 * 启动后 30s 首查（避开开机高峰）→ 之后每 12h ± 随机抖动。
 * 抖动是刻意的：没有抖动的话，全网客户端会在同一秒打同一个更新源。
 *
 * ## 更新源
 *
 * 走 electron-updater 的 **generic provider**，feed URL 来自配置
 * `cloud.updateFeedUrl`（可以是 GitHub Releases 的 latest.yml，也可以是
 * 自建 VPS 上的 feed）。留空 = 不检查更新 —— 这样在 GitHub 仓库建好之前，
 * 客户端可以先发布、不会产生 404 噪音。
 */

import { createRequire } from 'module';
import type { CloudUpgradeRecord } from './cloudClient';
import type { AppConfig } from '../config/manager';

export type UpdateStatus =
  | 'disabled'      // 未配置更新源 / 开发模式
  | 'idle'          // 空闲
  | 'checking'      // 正在检查
  | 'available'     // 有新版本
  | 'up-to-date'    // 已是最新
  | 'downloading'   // 下载中
  | 'downloaded'    // 下载完成，等待安装
  | 'error';        // 检查失败（静默降级，不打扰用户）

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  releaseNotes?: string;
  /** 下载进度 0-100 */
  percent?: number;
  error?: string;
  /** 上次检查时间戳（毫秒） */
  checkedAt?: number;
}

export interface UpdateManagerOptions {
  getConfig: () => AppConfig;
  getAppVersion: () => string;
  /** 是否是打包后的应用 —— 开发态不查更新 */
  isPackaged: () => boolean;
  /** 状态变化回调（广播给渲染层） */
  onState: (state: UpdateState) => void;
  /** 升级事件上报（打点到云端） */
  report: (record: CloudUpgradeRecord) => void;
  /** 首查延迟（毫秒） */
  firstCheckDelayMs?: number;
  /** 检查间隔（小时） */
  intervalHours?: number;
  /** 单次检查超时（毫秒） */
  checkTimeoutMs?: number;
  /**
   * 运行平台，默认 process.platform。
   * ⚠️ 测试里必须用这个注入, 不要用 Object.defineProperty(process, 'platform', ...)
   *    —— 本机开发环境就是 darwin, 篡改全局 process.platform 会污染同文件
   *    里所有「非 darwin」假设的其他用例(踩过一次：改完这个测试, 隔壁一条
   *    完全无关的用例莫名其妙断言失败)。
   */
  platform?: NodeJS.Platform;
}

const DEFAULT_FIRST_CHECK_DELAY_MS = 30_000;
const DEFAULT_INTERVAL_HOURS = 12;
const DEFAULT_CHECK_TIMEOUT_MS = 10_000;
/** 抖动上限：±30 分钟 */
const JITTER_MS = 30 * 60 * 1000;

const VALID_STATUS: UpdateStatus[] = [
  'disabled', 'idle', 'checking', 'available', 'up-to-date',
  'downloading', 'downloaded', 'error',
];

/**
 * electron-updater 是 CommonJS 且带动态 require，
 * 交给 esbuild 打包会踩坑 —— 这里用 createRequire 在运行时加载，
 * 由 electron-builder 把它当生产依赖原样打进 asar。
 */
function loadAutoUpdater(): any | null {
  try {
    const req = createRequire(import.meta.url);
    return req('electron-updater').autoUpdater;
  } catch (err) {
    console.warn('[Updater] electron-updater 不可用:', err);
    return null;
  }
}

/** 状态结构校验：渲染层只接受合法形状 */
function sanitizeState(state: UpdateState): UpdateState {
  const out: UpdateState = {
    status: VALID_STATUS.includes(state.status) ? state.status : 'error',
    currentVersion: typeof state.currentVersion === 'string' ? state.currentVersion : '0.0.0',
  };
  if (typeof state.availableVersion === 'string') out.availableVersion = state.availableVersion;
  if (typeof state.releaseNotes === 'string') out.releaseNotes = state.releaseNotes;
  if (typeof state.percent === 'number' && Number.isFinite(state.percent)) out.percent = state.percent;
  if (typeof state.error === 'string') out.error = state.error;
  if (typeof state.checkedAt === 'number') out.checkedAt = state.checkedAt;
  return out;
}

export class UpdateManager {
  private readonly options: UpdateManagerOptions;
  private state: UpdateState;
  private timer: NodeJS.Timeout | null = null;
  private firstTimer: NodeJS.Timeout | null = null;
  private autoUpdater: any | null = null;
  private listenersBound = false;
  private checking = false;

  constructor(options: UpdateManagerOptions) {
    this.options = options;
    this.state = sanitizeState({
      status: 'idle',
      currentVersion: options.getAppVersion(),
    });
  }

  /** 当前状态快照（渲染层拉取用） */
  getState(): UpdateState {
    return this.sanitize(this.state);
  }

  private sanitize(state: UpdateState): UpdateState {
    return sanitizeState(state);
  }

  private setState(patch: Partial<UpdateState>): void {
    this.state = sanitizeState({ ...this.state, ...patch });
    try {
      this.options.onState(this.state);
    } catch {
      // 渲染层广播失败不影响主流程
    }
  }

  /** 更新源地址（空 = 不检查） */
  private feedUrl(): string {
    // macOS 没有自动升级支持：应用未签名（无付费 Apple Developer 证书），
    // electron-updater 的 MacUpdater 走 Squirrel.Mac，校验新旧签名一致才能
    // 更新——未签名应用这一步不可靠（版本间行为不一致，常直接失败或被
    // Gatekeeper 拦截）。发行包里也没有 latest-mac.yml 要求的 .zip
    // （package.json 的 mac.target 只有 dmg，故意不加 zip）。
    // 返回空字符串 ⇒ 走 disabled 分支，不会假装"有更新"再在下载时报错。
    // mac 用户走手动下载 dmg 升级（见 README/设置页"检查更新"文案）。
    const platform = this.options.platform ?? process.platform;
    if (platform === 'darwin') return '';
    const raw = this.options.getConfig()?.cloud?.updateFeedUrl ?? '';
    return raw.trim();
  }

  /** 检查间隔（小时），来自配置 */
  private intervalHours(): number {
    const value = this.options.getConfig()?.cloud?.checkIntervalHours;
    return typeof value === 'number' && value > 0 ? value : DEFAULT_INTERVAL_HOURS;
  }

  /**
   * 启动轮询。
   * 首查延迟 + 之后按间隔（带抖动）循环。
   */
  start(): void {
    this.stop();

    const firstDelay = this.options.firstCheckDelayMs ?? DEFAULT_FIRST_CHECK_DELAY_MS;
    const intervalMs = Math.max(1, this.intervalHours()) * 3600_000;

    this.firstTimer = setTimeout(() => {
      void this.check(false);
      // 每次重排都重新掷一次抖动，避免固定节奏被识别
      const jitter = Math.floor(Math.random() * JITTER_MS * 2) - JITTER_MS;
      this.timer = setInterval(() => {
        void this.check(false);
      }, intervalMs + jitter);
    }, firstDelay);

    // 首查计时器不该阻止进程退出
    this.firstTimer.unref?.();
    this.timer?.unref?.();
  }

  stop(): void {
    if (this.firstTimer) {
      clearTimeout(this.firstTimer);
      this.firstTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 检查更新。
   *
   * @param manual 用户手动触发（手动触发时失败也给用户看错误，自动检查则静默）
   */
  async check(manual: boolean): Promise<UpdateState> {
    if (this.checking) return this.getState();
    this.checking = true;

    try {
      if (!this.options.isPackaged()) {
        // 开发态（未打包）electron-updater 会直接抛错 —— 直接判定为不可用。
        // 注意：开发态下 node_modules 里存在 electron 这个 npm 包，
        // electron-updater 内部的 require('electron') 会解析到那个 shim（一个路径字符串）
        // 而不是 Electron 内置模块 ⇒ 模块加载即抛错。所以**打包判断必须在前**。
        this.setState({ status: 'disabled', error: 'dev_mode' });
        return this.getState();
      }

      const feedUrl = this.feedUrl();
      if (!feedUrl) {
        this.setState({ status: 'disabled', error: undefined });
        return this.getState();
      }

      const updater = this.getAutoUpdater();
      if (!updater) {
        this.setState({ status: 'disabled', error: 'updater_unavailable' });
        return this.getState();
      }
      this.bindListeners(updater, feedUrl);
      // 用户确认后才下载（需求 2.8.2）
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;

      this.setState({ status: 'checking', error: undefined });

      const timeoutMs = this.options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
      const result = await withTimeout(
        Promise.resolve(updater.checkForUpdates()),
        timeoutMs,
        'check_timeout',
      );

      const checkedAt = Date.now();
      // 不抛异常时，electron-updater 会把结果放在事件流里；
      // 这里只负责兜底：超时或事件缺失时给一个明确状态
      if (result === 'timeout') {
        this.setState({ status: 'error', error: 'check_timeout', checkedAt });
        this.report({ type: 'upgrade_check', result: 'error', error: 'check_timeout' });
        return this.getState();
      }

      if (this.state.status === 'checking') {
        // 事件没来（异常路径）→ 保守地认为已是最新
        this.setState({ status: 'up-to-date', checkedAt });
        this.report({ type: 'upgrade_check', result: 'no_update' });
      } else {
        this.setState({ checkedAt });
      }
      return this.getState();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ status: 'error', error: message, checkedAt: Date.now() });
      this.report({ type: 'upgrade_check', result: 'error', error: message.slice(0, 200) });
      return this.getState();
    } finally {
      this.checking = false;
      void manual;
    }
  }

  /**
   * 下载更新（用户确认后调用）。
   */
  async download(): Promise<boolean> {
    const updater = this.getAutoUpdater();
    if (!updater) return false;
    try {
      this.setState({ status: 'downloading', percent: 0 });
      await withTimeout(
        Promise.resolve(updater.downloadUpdate()),
        10 * 60_000,
        'download_timeout',
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ status: 'error', error: message });
      this.report({ type: 'upgrade_download', ok: false, error: message.slice(0, 200) });
      return false;
    }
  }

  /**
   * 安装并重启（需求 2.8.3）。
   *
   * NSIS 走「应用退出 → 安装器接管 → runAfterFinish 自动拉起」，
   * 顺带规避了 Windows 运行中 exe 的文件占用锁（需求 2.8.2）。
   */
  install(toVersion?: string): boolean {
    const updater = this.getAutoUpdater();
    if (!updater) return false;
    try {
      this.report({ type: 'upgrade_install', to_version: toVersion });
      updater.quitAndInstall(false, true);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ status: 'error', error: message });
      return false;
    }
  }

  /** 启动上报（应用启动心跳 —— 兼作升级成功确认） */
  reportHeartbeat(): void {
    this.report({ type: 'upgrade_heartbeat' });
  }

  private getAutoUpdater(): any | null {
    if (!this.autoUpdater) {
      this.autoUpdater = loadAutoUpdater();
    }
    return this.autoUpdater;
  }

  /**
   * 绑定 electron-updater 事件 → 状态机。
   * 只绑一次（listenersBound），避免重复绑定导致回调翻倍。
   */
  private bindListeners(updater: any, feedUrl: string): void {
    if (this.listenersBound) {
      // feed 地址可能改过，重新设置
      try {
        updater.setFeedURL({ provider: 'generic', url: feedUrl });
      } catch { /* 设置失败继续用旧值 */ }
      return;
    }

    try {
      updater.setFeedURL({ provider: 'generic', url: feedUrl });
    } catch (err) {
      console.warn('[Updater] 设置更新源失败:', err);
    }

    updater.on('update-available', (info: any) => {
      const version = typeof info?.version === 'string' ? info.version : undefined;
      const notes = typeof info?.releaseNotes === 'string' ? info.releaseNotes : undefined;
      this.setState({ status: 'available', availableVersion: version, releaseNotes: notes });
      this.report({ type: 'upgrade_check', result: 'available', latest_version: version });
    });

    updater.on('update-not-available', () => {
      this.setState({ status: 'up-to-date' });
      this.report({ type: 'upgrade_check', result: 'no_update' });
    });

    updater.on('download-progress', (progress: any) => {
      const percent = typeof progress?.percent === 'number' ? Math.round(progress.percent) : undefined;
      this.setState({ status: 'downloading', percent });
    });

    updater.on('update-downloaded', (info: any) => {
      const version = typeof info?.version === 'string' ? info.version : undefined;
      this.setState({ status: 'downloaded', percent: 100, availableVersion: version ?? this.state.availableVersion });
      this.report({ type: 'upgrade_download', ok: true });
    });

    updater.on('error', (err: any) => {
      const message = typeof err?.message === 'string' ? err.message : String(err);
      this.setState({ status: 'error', error: message });
      this.report({ type: 'upgrade_check', result: 'error', error: message.slice(0, 200) });
    });

    this.listenersBound = true;
  }

  private report(record: CloudUpgradeRecord): void {
    try {
      this.options.report(record);
    } catch {
      // 上报失败不影响升级流程
    }
  }
}

/**
 * 给 promise 加超时。
 * 超时返回 TIMEOUT 标记（而不是抛错），让调用方决定怎么降级。
 */
const TIMEOUT = Symbol('timeout');

async function withTimeout<T>(promise: Promise<T>, ms: number, _reason: string): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
