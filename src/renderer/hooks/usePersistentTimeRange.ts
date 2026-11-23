/**
 * 仪表盘时间范围（15m / 1h / 6h）的**持久化偏好**。
 *
 * ## 为什么需要它
 *
 * 时间范围原本是 Dashboard 组件内部的 `useState` —— 切到别的页面时组件卸载，
 * 状态随之丢失，回到仪表盘又变回默认 1h。用户每次进页面都要重选一遍。
 *
 * ## 为什么用 localStorage
 *
 * 这是**纯渲染进程的界面偏好**，不是业务配置：
 *   - 项目里已有的本地偏好（终端位置 `terminal_latitude` / `terminal_longitude`、
 *     星历缓存 `starlink_tle_cache`、已读告警 `slmonitor.dashboard.dismissedResolved`）
 *     全部走渲染进程的 `localStorage`；
 *   - 设置页里真正需要主进程落盘的配置（采集地址、Webhook 等）才走
 *     `electronAPI.getConfig/saveConfig`（config.json）。
 *
 * 本偏好不需要主进程参与，也不能写进 config.json（那是另一个通道），
 * 所以沿用 **localStorage** 这套既有机制，不引入第三种存储。
 *
 * ## 存储值约定
 *
 * 存的是**裸字符串** `'15m' | '1h' | '6h'`（不做 JSON 包装），便于人工排查。
 * 读取时一律做合法性校验：老版本遗留值、手改过的值、损坏的值
 * 统统回落到默认 `1h`，绝不把空选择交给 UI。
 */

import { useCallback, useState } from 'react';

/** 仪表盘可选的时间范围（与右上角周期选择器一致） */
export type TimeRange = '15m' | '1h' | '6h';

/** 首次启动 / 存储不可用时的默认范围 */
export const DEFAULT_TIME_RANGE: TimeRange = '1h';

/** 选择器上按顺序渲染的选项 */
export const TIME_RANGE_OPTIONS: readonly TimeRange[] = ['15m', '1h', '6h'];

/**
 * 时间范围 → 查询秒数。
 *
 * 页面上的选择器和图表/历史查询都从这里派生，避免各自写死时间窗。
 */
export const TIME_RANGE_SECONDS: Record<TimeRange, number> = {
  '15m': 15 * 60,
  '1h': 60 * 60,
  '6h': 6 * 60 * 60,
};

/**
 * localStorage 键名。
 *
 * 命名沿用仪表盘已读告警的 `slmonitor.dashboard.*` 前缀，
 * 让「仪表盘本地偏好」在 localStorage 里成一组。
 */
export const TIME_RANGE_STORAGE_KEY = 'slmonitor.dashboard.timeRange';

/**
 * 存储访问的最小结构。
 *
 * 用结构化接口而不是直接依赖 DOM 的 `Storage`：单测可以在 node 环境里
 * 注入内存实现，不需要 jsdom / 真实浏览器。
 */
export interface TimeRangeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 默认存储 = 渲染进程的 localStorage；不可用时返回 null（不抛） */
function getLocalStorage(): TimeRangeStorage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    // 隐私模式 / 权限受限时，连访问 `window.localStorage` 都可能抛
    return null;
  }
}

/** 存储值是否是一个合法的时间范围 */
export function isValidTimeRange(value: unknown): value is TimeRange {
  return typeof value === 'string' && (TIME_RANGE_OPTIONS as readonly string[]).includes(value);
}

/**
 * 读取已保存的时间范围。
 *
 * 任何异常路径（存储不可用、读失败、值非法/损坏）都回落到默认 1h ——
 * 让 UI 永远拿到一个可用选项，而不是空白选择器。
 */
export function readTimeRange(
  storage: TimeRangeStorage | null = getLocalStorage(),
): TimeRange {
  if (!storage) return DEFAULT_TIME_RANGE;
  try {
    const raw = storage.getItem(TIME_RANGE_STORAGE_KEY);
    return isValidTimeRange(raw) ? raw : DEFAULT_TIME_RANGE;
  } catch {
    return DEFAULT_TIME_RANGE;
  }
}

/**
 * 写入时间范围。非法值不写（返回 false）。
 *
 * 写失败（配额满 / 隐私模式）不阻断交互：调用方仍然切换当前会话里的状态，
 * 只是下次启动回到默认值。
 */
export function writeTimeRange(
  range: TimeRange,
  storage: TimeRangeStorage | null = getLocalStorage(),
): boolean {
  if (!storage || !isValidTimeRange(range)) return false;
  try {
    storage.setItem(TIME_RANGE_STORAGE_KEY, range);
    return true;
  } catch {
    return false;
  }
}

/**
 * 持久化的周期选择器状态。
 *
 * 组件卸载不影响：重新挂载时 `readTimeRange()` 会从 localStorage 恢复。
 * 当前应用只有仪表盘消费这个范围（LatencyChart 通过 props 接收），
 * 所以不需要跨窗口同步。
 */
export function usePersistentTimeRange(): [TimeRange, (next: TimeRange) => void] {
  const [timeRange, setTimeRangeState] = useState<TimeRange>(readTimeRange);

  const setTimeRange = useCallback((next: TimeRange) => {
    // 防御：调用方传来非法值时不切换、不落盘，避免把 UI 卡在无效选择上
    if (!isValidTimeRange(next)) return;
    setTimeRangeState(next);
    writeTimeRange(next);
  }, []);

  return [timeRange, setTimeRange];
}
