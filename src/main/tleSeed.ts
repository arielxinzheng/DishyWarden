/**
 * 内置 TLE 种子数据加载器
 *
 * 作用: 客户现场断网 / CelesTrak 限流时, 仍能算出卫星位置。
 * 种子是构建时抓取的真实 TLE (见 scripts/generate-tle-seed.mjs.py),
 * 只覆盖主要壳层 —— 它是可用性兜底, 不是精度来源。
 *
 * preload 在 sandbox 下没有 fs 权限, 所以由主进程读取并通过 IPC 暴露。
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TLESeed {
  fetchedAt: number;
  source: string;
  shells: { inclination: number; periodMin: number; count: number }[];
  data: { name: string; line1: string; line2: string }[];
}

let seedCache: TLESeed | null = null;
let loadError: string | null = null;

/** 定位种子文件: 开发态从 src, 打包态从 app 根目录 */
function resolveSeedPath(): string {
  const candidates = [
    // 打包后: <app>/resources/app.asar/dist-electron/main -> 回到 app 根
    path.join(__dirname, '../../src/renderer/assets/tle-seed.json.gz'),
    // 打包后 (asar 展开)
    path.join(app.getAppPath(), 'src/renderer/assets/tle-seed.json.gz'),
    // 开发态
    path.join(__dirname, '../../src/renderer/assets/tle-seed.json.gz'),
  ];
  return candidates[0];
}

/**
 * 加载种子数据。结果缓存在内存中 —— 8604 条记录解压+解析约需几十毫秒,
 * 不应该在每次 IPC 调用时重复做。
 */
export function loadTLESeed(): TLESeed | null {
  if (seedCache) return seedCache;
  if (loadError) return null;

  const seedPath = resolveSeedPath();

  try {
    if (!fs.existsSync(seedPath)) {
      loadError = `种子文件不存在: ${seedPath}`;
      console.warn('[TLESeed]', loadError);
      return null;
    }

    const gz = fs.readFileSync(seedPath);
    const json = zlib.gunzipSync(gz).toString('utf-8');
    const parsed = JSON.parse(json) as TLESeed;

    if (!Array.isArray(parsed.data) || parsed.data.length === 0) {
      loadError = '种子文件内容为空';
      console.warn('[TLESeed]', loadError);
      return null;
    }

    seedCache = parsed;
    console.log(
      `[TLESeed] 已加载 ${parsed.data.length} 条内置星历 ` +
      `(来源: ${parsed.source}, 抓取于 ${new Date(parsed.fetchedAt).toISOString().slice(0, 10)})`
    );
    return seedCache;
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
    console.warn('[TLESeed] 加载失败:', loadError);
    return null;
  }
}

/** 启动时预热, 避免首次 IPC 调用卡顿 */
export function warmupTLESeed(): void {
  // 不阻塞启动
  setTimeout(() => loadTLESeed(), 1000);
}