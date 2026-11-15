/**
 * 修复 electron-builder 打包时污染本地原生模块的问题。
 *
 * ## 问题
 *
 * electron-builder 的 `installAppDependencies()` 默认会跑 `npm rebuild`，
 * 并把**目标架构**传进去（见 `app-builder-lib/out/packager.js`）：
 *
 * ```js
 * await installOrRebuild(config, this.appDir, {
 *   frameworkInfo, platform: platform.nodeName,
 *   arch: builder_util_1.Arch[arch],   // ← 目标架构
 *   ...
 * });
 * ```
 *
 * 本项目 `package.json` 的 mac target 同时要 `arm64` 和 `x64`。
 * 打包 x64 时，better-sqlite3 的 install 脚本会用
 * `npm_config_arch=x64` 重新编译/下载 **x86_64** 的 `.node`，
 * **直接覆盖掉 `node_modules/` 里那个为 arm64 + Electron ABI 130 编好的二进制**。
 *
 * 后果：打包跑完，本机 `npm run dev` 立刻炸：
 *
 * ```
 * dlopen(.../better_sqlite3.node): (mach-o file, but is an incompatible
 * architecture (have 'x86_64', need 'arm64e' or 'arm64'))
 * ```
 *
 * 采集器还能跑，但**历史库写不进去**（`new Database()` 直接抛），
 * 表现为「指标正常但库里没有新数据」—— 很难第一时间联想到是打包搞的。
 *
 * ## 修法
 *
 * `beforeBuild` 钩子返回 `false` ⇒ electron-builder 认为
 * 「node_modules 已在外部处理好」，**跳过 rebuild**。
 *
 * 这样：
 * - 本地 `node_modules/` 保持 arm64 + ABI 130 不动
 * - 打包时直接把现有的 `.node` 收进包里
 *
 * ⚠️ **代价**：x64 的包会打进 arm64 的 `.node` ⇒ **x64 包在 Intel Mac 上跑不了**。
 * 这是取舍：保住开发环境不被破坏，比在本机产出 Intel 包更重要。
 * 真要出 Intel 包，应该在 x64 机器/CI 上单独构建。
 *
 * ## 用法
 *
 * 挂在 package.json 的 build 配置里：
 *
 * ```json
 * "build": {
 *   "beforeBuild": "scripts/guard-native-modules.mjs"
 * }
 * ```
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(__dirname, '..');

/** 需要保护架构的原生模块 */
const PROTECTED = [
  {
    name: 'better-sqlite3',
    binary: 'build/Release/better_sqlite3.node',
    /** 本机 Electron ABI —— 必须是 130（Electron 33） */
    abi: 130,
    /** 必须是 arm64（Apple Silicon） */
    arch: 'arm64',
  },
];

function isArm64Electron() {
  // 只在 Apple Silicon 上保护；Intel 机不需要
  return process.platform === 'darwin' && process.arch === 'arm64';
}

/**
 * 检查一个原生模块当前是否是我们要的架构 + ABI。
 * 用 `file` 命令读 Mach-O 头，比解析二进制可靠。
 */
function inspectBinary(path) {
  if (!existsSync(path)) return { exists: false, arch: null };

  // Mach-O 头解析: 0xFEEDFACF = 64 位
  // 读 CPU type 字段(偏移 4, 小端):
  //   0x01000007 = x86_64
  //   0x0100000C = arm64
  const buf = readFileSync(path);
  if (buf.length < 8) return { exists: true, arch: 'unknown' };

  const magic = buf.readUInt32LE(0);
  if (magic !== 0xfeedfacf && magic !== 0xfeedface) {
    return { exists: true, arch: 'unknown' };
  }
  const cpuType = buf.readUInt32LE(4);
  const arch =
    cpuType === 0x01000007 ? 'x86_64'
    : cpuType === 0x0100000c ? 'arm64'
    : `0x${cpuType.toString(16)}`;
  return { exists: true, arch };
}

const results = [];

for (const mod of PROTECTED) {
  const binPath = join(APP_DIR, 'node_modules', mod.name, mod.binary);
  const info = inspectBinary(binPath);

  if (!info.exists) {
    results.push(`  ⚠️ ${mod.name}: 没找到 ${mod.binary}（跳过）`);
    continue;
  }

  if (info.arch === mod.arch) {
    results.push(`  ✅ ${mod.name}: ${info.arch} ✓（保持不动）`);
    continue;
  }

  results.push(
    `  ❌ ${mod.name}: 当前是 ${info.arch}，期望 ${mod.arch}` +
    ` —— 需要用 node-gyp 重编（见 CONTRIBUTING.md 的「不要做的事」）`
  );
}

const needsRepair = results.some((r) => r.includes('❌'));

console.log('[guard-native-modules] 原生模块架构检查:');
results.forEach((r) => console.log(r));

if (needsRepair && isArm64Electron()) {
  console.log(
    '[guard-native-modules] ⚠️ 架构不匹配。\n' +
    '    重建命令:\n' +
    '      cd node_modules/better-sqlite3 && \\\n' +
    '        npx node-gyp rebuild --arch=arm64 --target=33.4.11 \\\n' +
    '          --dist-url=https://electronjs.org/headers --build-from-source'
  );
}

// ⚠️ 这个脚本**不能**作为 electron-builder 的 beforeBuild 钩子:
// 钩子是在 electron-builder 进程内 require 并调用的,
// 任何 process.exit() 都会把 electron-builder 一起干掉
// (表现为「打包静默停止, release/ 空」)。
//
// 真正的防护是 package.json 里的 `"npmRebuild": false` ——
// electron-builder 见到它就跳过 npm rebuild, 不会覆盖 node_modules/。
// 本脚本只是**独立运行**的体检工具, 用来确认架构对不对。
//
//   node scripts/guard-native-modules.mjs
//
// 退出码: 0 = 架构正确; 1 = 架构不对(需要重编)
console.log('[guard-native-modules] 提示: 打包防护由 package.json 的 npmRebuild:false 提供');
process.exit(needsRepair ? 1 : 0);
