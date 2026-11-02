/**
 * satellite.js 的**精简入口** —— 绕开 wasm runtime。
 *
 * ## 为什么需要这个文件
 *
 * satellite.js v7 的根入口 `dist/index.js` 末尾有：
 *
 * ```js
 * export * from './wasm/index.js';
 * ```
 *
 * 而 `dist/wasm/runtimes/index.js` 里的 `#wasm-multi-thread` 指向
 * `wasm-build/pthreads-release/index.js` —— 那个文件带 **top-level await**。
 *
 * Vite 的默认输出格式 `iife` **不支持 top-level await**，于是生产构建直接失败：
 *
 * ```
 * [commonjs--resolver] Module format "iife" does not support top-level await.
 * file: node_modules/satellite.js/wasm-build/pthreads-release/index.js
 * ```
 *
 * ## 为什么可以绕开
 *
 * wasm runtime 只服务于 **BulkPropagator**（一次传播几千颗星的批量接口）。
 * 本项目走的是单颗传播路径，全部在**纯 JS 模块**里，与 wasm 零依赖：
 *
 * | 用到的 API | 所在模块 | 依赖 wasm? |
 * |---|---|---|
 * | `twoline2satrec` | `dist/io.js` | ❌ |
 * | `propagate` / `gstime` | `dist/propagation.js` | ❌ |
 * | `eciToGeodetic` / `eciToEcf` / `ecfToLookAngles` | `dist/transforms.js` | ❌ |
 *
 * 已实测核验：上述全部模块对 `wasm` 的引用数为 **0**。
 *
 * ## 为什么用相对路径而不是 `satellite.js/dist/io.js`
 *
 * satellite.js 的 `package.json` 的 `exports` 只开放了 `"."`，
 * 裸模块名的深路径导入会被 Node 报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
 *
 * 相对路径直接指向文件，绕开 package `exports` 限制，
 * TypeScript 与 Vite 都能正常解析（同名 `.d.ts` 就在旁边）。
 *
 * ## 维护提示
 *
 * 升级 satellite.js 大版本后要复核两件事：
 * 1. 这几个函数是否还在同名文件里（io.js / propagation.js / transforms.js）
 * 2. `ecfToLookAngles` 的单位 —— v6 返回度，v7 返回**弧度**
 *    （见 `satellite-tle-sgp4` skill §12）
 */

// src/renderer/utils/ → ../../../ 到项目根 → node_modules/satellite.js/dist/...
export { twoline2satrec, json2satrec } from '../../../node_modules/satellite.js/dist/io.js';
export { propagate, sgp4, gstime } from '../../../node_modules/satellite.js/dist/propagation.js';
export { checkForDecay } from '../../../node_modules/satellite.js/dist/propagation/check-for-decay.js';
export { dopplerFactor } from '../../../node_modules/satellite.js/dist/dopplerFactor.js';
export {
  radiansToDegrees,
  degreesToRadians,
  degreesLat,
  degreesLong,
  radiansLat,
  radiansLong,
  geodeticToEcf,
  eciToGeodetic,
  eciToEcf,
  ecfToEci,
  ecfToLookAngles,
} from '../../../node_modules/satellite.js/dist/transforms.js';
export { sunPos } from '../../../node_modules/satellite.js/dist/sun.js';
export { jday, invjday } from '../../../node_modules/satellite.js/dist/ext.js';
export { SatRecError } from '../../../node_modules/satellite.js/dist/propagation/SatRec.js';
export * as constants from '../../../node_modules/satellite.js/dist/constants.js';
