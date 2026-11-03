/**
 * 路由器探测结果的**运行时**形状校验
 *
 * ## 为什么需要单独一个文件
 *
 * 1. `RouterStatusRow.tsx` 是组件文件, 在里面导出函数会触发
 *    `react-refresh/only-export-components` 警告 —— Fast Refresh
 *    要求组件文件只导出组件。
 * 2. 这个校验是**纯函数**, 不依赖 React, 放独立文件才能直接被单测 import。
 *
 * ## 为什么需要校验
 *
 * ⚠️ **TypeScript 的类型只在编译期存在** —— `ipcMain.handle` 返回什么,
 * 渲染层就拿到什么, 编译器管不到。主进程 handler 返回 `undefined`、
 * 或者别处误改了返回形状, 都会让调用方的 `.toFixed()` 炸掉。
 *
 * 实测过的崩溃: `RouterStatusRow` 原来写的是
 *
 * ```tsx
 * {probe.rttMs !== null ? `RTT ${probe.rttMs.toFixed(2)}ms` : 'RTT —'}
 * ```
 *
 * `undefined !== null` **为真** ⇒ 对 undefined 调 `.toFixed()`
 * ⇒ `TypeError: Cannot read properties of undefined (reading 'toFixed')`
 * ⇒ 整页被 ErrorBoundary 接管, 仪表盘**完全打不开**。
 *
 * ⇒ 必须在**运行时**校验形状, 而不是相信类型标注。
 */

import type { RouterProbeResult } from '../../../core/routerProbeTypes';

/**
 * 校验 IPC 返回值是否真的是 `RouterProbeResult`。
 *
 * 判据(缺一不可):
 *   - 是普通对象(排除 `null` / 数组 / 字符串)
 *   - `reachable` 是 boolean
 *   - `rttMs` 是 number 或 null(**不是 undefined**)
 *   - `packetLoss` 是 number
 *
 * 可选字段(`httpOk` / `trusted` / `trustNote` / `timestamp`)缺失不影响判定。
 */
export function isValidProbe(value: unknown): value is RouterProbeResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const p = value as Partial<RouterProbeResult>;
  if (typeof p.reachable !== 'boolean') return false;
  // `rttMs` 允许 null(不可达时), 但不接受 undefined ——
  // undefined 是"字段缺失", 不是"没有 RTT"。
  if (p.rttMs !== null && typeof p.rttMs !== 'number') return false;
  if (typeof p.packetLoss !== 'number') return false;

  return true;
}
