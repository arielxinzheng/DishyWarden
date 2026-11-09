/**
 * TLE 数据获取和缓存服务
 *
 * 客户现场的约束:
 *  - 网络本身就是被监控对象, 可能不通 / 不稳
 *  - CelesTrak 有 2 小时更新周期, 频繁请求会被限流返回 403
 *  - TLE 是轨道参数, 不是遥测 —— 不需要实时, 过期几天仍有参考价值
 *
 * 所以采用「三级回退」而不是「拉不到就没数据」:
 *   1. 内存/localStorage 缓存(新鲜)
 *   2. 过期缓存(降级使用, 标注新鲜度)
 *   3. 内置种子(随安装包分发, 完全离线)
 *   4. 联网拉取(多源轮询)
 *
 * 任何一级成功都不会让页面卡在「正在计算」。
 */

import type { TLEData } from './satelliteCalculator';

/** 数据来源, 用于 UI 提示数据新鲜度 */
export type TLESource = 'cache' | 'stale-cache' | 'seed' | 'network';

export interface TLEResult {
  data: TLEData[];
  source: TLESource;
  /** 数据获取时刻 (ms), 用于计算新鲜度 */
  fetchedAt: number;
  /** 若来自过期缓存/种子, 说明它有多旧 */
  age: number;
  /** 数据来自哪个源 */
  origin?: string;
}

export interface TLEErrorDetail {
  message: string;
  /** 每个源失败的原因 */
  attempts: { source: string; error: string }[];
}

// ---------------------------------------------------------------------------
// 上游源
// ---------------------------------------------------------------------------

const UPSTREAMS: { name: string; url: string }[] = [
  { name: 'CelesTrak', url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle' },
  { name: 'CelesTrak(GP)', url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle-3le' },
];

/** 单次请求超时 —— 没有它, 网络黑洞会让界面永远转圈 */
const FETCH_TIMEOUT_MS = 15000;

const CACHE_KEY = 'starlink_tle_cache';
/** 缓存有效期: 对齐 CelesTrak 的 2 小时更新周期, 留出余量 */
const CACHE_FRESH_MS = 3 * 60 * 60 * 1000;
/** 缓存最长可用时间: 超过就宁愿用内置种子(种子是构建时抓的, 更新鲜) */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface TLECache {
  timestamp: number;
  data: TLEData[];
  origin?: string;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 解析 TLE 文本。格式为每 3 行一组 (名称, line1, line2)。
 * 容错: 有些源不带名称行, 此时首行以 "1 " 开头。
 */
export function parseTLEText(text: string): TLEData[] {
  const lines = text.trim().split('\n');
  const tles: TLEData[] = [];

  let i = 0;
  // 跳过前导空白/注释行
  while (i < lines.length && !lines[i].trim().startsWith('1 ') && !lines[i].trim()) i++;

  while (i < lines.length) {
    // 名称行 (可能不存在)
    let name = '';
    if (!lines[i].trim().startsWith('1 ')) {
      name = lines[i].trim();
      i++;
    }
    if (i + 1 >= lines.length) break;

    const line1 = lines[i].trim();
    const line2 = lines[i + 1].trim();

    if (line1.startsWith('1 ') && line2.startsWith('2 ')) {
      // 没有名称行时, 用 NORAD ID 兜底
      tles.push({ name: name || `SAT-${line1.slice(2, 7).trim()}`, line1, line2 });
      i += 2;
    } else {
      i++;
    }
  }

  return tles;
}

// ---------------------------------------------------------------------------
// 网络
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 从网络拉取, 依次尝试各上游源 */
async function fetchFromNetwork(): Promise<{ data: TLEData[]; origin: string; attempts: TLEErrorDetail['attempts'] }> {
  const attempts: TLEErrorDetail['attempts'] = [];

  for (const up of UPSTREAMS) {
    try {
      const text = await fetchWithTimeout(up.url);
      const data = parseTLEText(text);
      if (data.length === 0) {
        throw new Error('empty-tle-response');
      }
      return { data, origin: up.name, attempts };
    } catch (e) {
      // 失败原因是**技术码**（timeout / empty-tle-response / HTTP 5xx 原文），
      // 只进日志与 attempts，不直接展示给用户 —— 展示文案由页面用 i18n 组装。
      const reason = e instanceof Error
        ? (e.name === 'AbortError' ? 'timeout' : e.message)
        : String(e);
      attempts.push({ source: up.name, error: reason });
    }
  }

  throw new TLEFetchError(
    `ephemeris fetch failed: ${attempts.map((a) => `${a.source} ${a.error}`).join('; ')}`,
    attempts
  );
}

export class TLEFetchError extends Error {
  attempts: TLEErrorDetail['attempts'];
  constructor(message: string, attempts: TLEErrorDetail['attempts']) {
    super(message);
    this.name = 'TLEFetchError';
    this.attempts = attempts;
  }
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

function readCache(): TLECache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw) as TLECache;
    if (!Array.isArray(cache.data) || cache.data.length === 0) return null;
    return cache;
  } catch {
    return null;
  }
}

function writeCache(data: TLEData[], origin: string): void {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ timestamp: Date.now(), data, origin } satisfies TLECache)
    );
  } catch (e) {
    // localStorage 满了 (TLE 较大) —— 不致命, 只是下次要重新拉
    console.warn('[tleService] cache write failed:', e);
  }
}

export function clearTLECache(): void {
  localStorage.removeItem(CACHE_KEY);
}

export function getCacheInfo(): { hasCached: boolean; age: number | null; count: number | null } {
  const cache = readCache();
  if (!cache) return { hasCached: false, age: null, count: null };
  return { hasCached: true, age: Date.now() - cache.timestamp, count: cache.data.length };
}

// ---------------------------------------------------------------------------
// 内置种子
// ---------------------------------------------------------------------------

/**
 * 内置种子数据。通过 IPC 从主进程读取 (preload 在 sandbox 下没有 fs 权限)。
 * 种子是构建时从 CelesTrak 抓取的真实 TLE, 只覆盖主要壳层,
 * 作用是「完全离线也能算出卫星位置」, 不是精度来源。
 */
let seedPromise: Promise<{ data: TLEData[]; fetchedAt: number; source: string } | null> | null = null;

function readSeed(): Promise<{ data: TLEData[]; fetchedAt: number; source: string } | null> {
  if (seedPromise) return seedPromise;

  seedPromise = (async () => {
    try {
      if (typeof window === 'undefined' || !window.electronAPI?.getTLESeed) return null;
      const seed = await window.electronAPI.getTLESeed();
      if (!seed || !Array.isArray(seed.data) || seed.data.length === 0) return null;
      console.log(`[tleService] loaded ${seed.data.length} built-in ephemerides from the main process`);
      return { data: seed.data as TLEData[], fetchedAt: seed.fetchedAt, source: seed.source };
    } catch (e) {
      console.warn('[tleService] failed to load built-in ephemeris:', e);
      return null;
    }
  })();

  return seedPromise;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 获取 TLE 数据, 按优先级回退。
 *
 * @param forceRefresh 跳过新鲜缓存, 强制走网络 (但网络失败仍会降级)
 * @returns TLEResult —— 一定成功或抛 TLEFetchError, 不会卡住
 */
export async function getTLEData(forceRefresh = false): Promise<TLEResult> {
  const now = Date.now();
  const cache = readCache();

  // 1. 新鲜缓存直接用, 不碰网络
  if (!forceRefresh && cache) {
    const age = now - cache.timestamp;
    if (age < CACHE_FRESH_MS) {
      return { data: cache.data, source: 'cache', fetchedAt: cache.timestamp, age, origin: cache.origin };
    }

    // 2. 过期但还在可接受范围内 —— 降级使用, 同时后台尝试刷新
    if (age < CACHE_MAX_AGE_MS) {
      // 不 await: 先把旧数据给出去, 让界面立刻可用
      void refreshInBackground();
      return {
        data: cache.data,
        source: 'stale-cache',
        fetchedAt: cache.timestamp,
        age,
        origin: cache.origin,
      };
    }
    // 超过 CACHE_MAX_AGE_MS: 丢弃, 走后面的种子/网络
  }

  // 3. 网络
  try {
    const { data, origin } = await fetchFromNetwork();
    writeCache(data, origin);
    return { data, source: 'network', fetchedAt: Date.now(), age: 0, origin };
  } catch (e) {
    // 4. 内置种子兜底
    const seed = await readSeed();
    if (seed) {
      console.warn('[tleService] network unavailable, falling back to built-in seed data');
      return {
        data: seed.data,
        source: 'seed',
        fetchedAt: seed.fetchedAt,
        age: seed.fetchedAt ? Date.now() - seed.fetchedAt : Number.MAX_SAFE_INTEGER,
        origin: seed.source,
      };
    }
    throw e;
  }
}

/** 后台刷新, 失败静默 —— 失败时用户已经在用旧数据了 */
async function refreshInBackground(): Promise<void> {
  try {
    const { data, origin } = await fetchFromNetwork();
    writeCache(data, origin);
    window.dispatchEvent(new CustomEvent('tle-data-refreshed'));
  } catch {
    // 静默: 保留旧缓存
  }
}

/** 数据新鲜度的**语义描述**：视图层据此挑文案与插值，模块本身不出句子 */
export interface TLEAge {
  unit: 'hours' | 'days';
  count: number;
}

export type TLEFreshness =
  | { kind: 'network' }
  | { kind: 'cache_under_hour' }
  | { kind: 'cache_hours'; count: number }
  | { kind: 'stale_cache'; age: TLEAge }
  | { kind: 'seed'; age: TLEAge };

/**
 * 把新鲜度折算成语义码。
 *
 * 原先这里返回「已从网络获取最新星历」这类中文句子 —— 渲染层拿到就直接拼进
 * 提示条，切到英文时整条提示仍是中文。现在只给 kind + 数量，文案归视图层。
 */
export function describeFreshness(result: TLEResult): TLEFreshness {
  const hours = result.age / 3600000;
  if (result.source === 'network') return { kind: 'network' };
  if (result.source === 'cache') {
    if (hours < 1) return { kind: 'cache_under_hour' };
    return { kind: 'cache_hours', count: Math.round(hours) };
  }

  const age: TLEAge =
    hours < 24
      ? { unit: 'hours', count: Math.round(hours) }
      : { unit: 'days', count: Math.round(hours / 24) };

  return result.source === 'stale-cache'
    ? { kind: 'stale_cache', age }
    : { kind: 'seed', age };
}

// ---------------------------------------------------------------------------
// 旧接口兼容 (SatelliteRadar 仍在用)
// ---------------------------------------------------------------------------

/** @deprecated 用 getTLEData() —— 它带回退链和来源信息 */
export async function getStarlinkTLEs(forceRefresh = false): Promise<TLEData[]> {
  const result = await getTLEData(forceRefresh);
  return result.data;
}