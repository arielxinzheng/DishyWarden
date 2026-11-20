/**
 * 应用版本号的唯一来源（主进程侧）。
 *
 * ## 为什么不能直接用 `app.getVersion()`
 *
 * 它以「Electron 认为的 app 目录」为基准读 package.json：
 *
 *   - 打包后  app 目录 = asar 根，里面有 package.json ⇒ 返回值正确；
 *   - 开发态  是 `electron dist-electron/main/index.js` 直接跑一个 JS 文件，
 *             app 目录里**没有** package.json ⇒ Electron 退回成**它自己的版本号**
 *             （开发机上实测 33.4.11，正是 Electron 33.4.11）。
 *
 * 后者会污染整条升级链路（见 CloudServer/UPGRADE-CHAIN.md）：
 *
 *   - 设置页「当前版本 33.4.11」与 latest.yml 里的 1.0.1 无法对照；
 *   - electron-updater 拿 33.4.11 和 1.0.1 比 semver，结论恒为「已是最新」；
 *   - 上报云端的 `app_version` 变成 Electron 版本，版本分布统计直接失真。
 *
 * 开发态改读项目根的 package.json —— 和打包发版用的是同一份文件，也是
 * `__APP_VERSION__`（vite.config.ts 注入给渲染层左下角）的同一个来源。
 *
 * ⚠️ 打包态的取值路径**不变**（仍走 `app.getVersion()`），所以升级链路的
 * 线上行为零变化：Release workflow 校验 `tag == package.json version`，
 * electron-builder 把该 version 写进安装包与 latest.yml，客户端读到的仍是它。
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { app } from 'electron';

/**
 * 开发态 package.json 的位置。
 *
 * 主进程产物是 dist-electron/main/index.js（esbuild 单文件 bundle），
 * 往上两级就是项目根 —— 与 `resolveAppIcon` 取 build/icon.png 同一个相对位置。
 */
const DEV_PACKAGE_JSON = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'package.json'
);

function readPackageVersion(): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(DEV_PACKAGE_JSON, 'utf8'));
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'string' && version.length > 0 ? version : undefined;
  } catch {
    // 读不到就退回 Electron 的版本号：显示一个错了的版本，好过启动失败
    return undefined;
  }
}

let cached: string | undefined;

/** 应用版本号，例如 `1.0.0`。package.json 运行期不会变，读一次即缓存 */
export function resolveAppVersion(): string {
  if (cached === undefined) {
    cached = app.isPackaged ? app.getVersion() : (readPackageVersion() ?? app.getVersion());
  }
  return cached;
}