/**
 * `isValidProbe` 的回归测试
 *
 * ## 背景
 *
 * `RouterStatusRow` 原本直接 `setProbe(result)`, 渲染时用
 * `probe.rttMs !== null ? probe.rttMs.toFixed(2) : 'RTT —'`。
 *
 * ⚠️ `undefined !== null` **为真** ⇒ 对 undefined 调 `.toFixed()`
 * ⇒ `TypeError: Cannot read properties of undefined (reading 'toFixed')`
 * ⇒ 整页被 ErrorBoundary 接管, 仪表盘**完全打不开**。
 *
 * 而 `getRouterProbe()` 的返回类型 `RouterProbeResult | null`
 * 只是 TypeScript 的承诺 —— 运行时没人校验:
 *   - handler 可能返回 `undefined`(没 return)
 *   - 探针 stub 可能返回 `[]`(形状完全不对)
 *   - 对象可能缺字段
 *
 * ⇒ 必须在**运行时**校验形状。
 */

import { describe, it, expect } from 'vitest';
import { isValidProbe } from './routerProbeShape';

describe('isValidProbe', () => {
  it('接受形状正确的结果', () => {
    expect(isValidProbe({
      reachable: true,
      rttMs: 1.23,
      packetLoss: 0,
      httpOk: null,
      timestamp: Date.now(),
      trusted: true,
    })).toBe(true);
  });

  it('接受 rttMs 为 null(不可达时)', () => {
    expect(isValidProbe({
      reachable: false,
      rttMs: null,
      packetLoss: 1,
      httpOk: null,
      timestamp: Date.now(),
    })).toBe(true);
  });

  it('拒绝 null / undefined', () => {
    expect(isValidProbe(null)).toBe(false);
    expect(isValidProbe(undefined)).toBe(false);
  });

  it('拒绝数组(探针 stub 误返回 [] 时)', () => {
    // 这正是踩到过的那个崩溃: stub 里写成了 `ipcMain.handle(ch, () => [])`
    expect(isValidProbe([])).toBe(false);
    expect(isValidProbe([1, 2, 3])).toBe(false);
  });

  it('拒绝非对象', () => {
    expect(isValidProbe('probe')).toBe(false);
    expect(isValidProbe(42)).toBe(false);
    expect(isValidProbe(true)).toBe(false);
  });

  it('拒绝 rttMs 为 undefined —— 这正是崩溃的根因', () => {
    // `undefined !== null` 为真 ⇒ 原代码会对它调 .toFixed() ⇒ TypeError
    expect(isValidProbe({
      reachable: true,
      rttMs: undefined,
      packetLoss: 0,
      timestamp: Date.now(),
    })).toBe(false);
  });

  it('拒绝缺 reachable 的对象', () => {
    expect(isValidProbe({ rttMs: 1, packetLoss: 0, timestamp: 1 })).toBe(false);
  });

  it('拒绝缺 packetLoss 的对象', () => {
    expect(isValidProbe({ reachable: true, rttMs: 1, timestamp: 1 })).toBe(false);
  });

  it('拒绝字段类型不对的对象', () => {
    expect(isValidProbe({ reachable: 'yes', rttMs: 1, packetLoss: 0 })).toBe(false);
    expect(isValidProbe({ reachable: true, rttMs: '1.0', packetLoss: 0 })).toBe(false);
    expect(isValidProbe({ reachable: true, rttMs: 1, packetLoss: '0' })).toBe(false);
  });

  it('可选字段缺失不影响判定', () => {
    // httpOk / trusted / trustNote / timestamp 都是可选的
    expect(isValidProbe({ reachable: true, rttMs: 1, packetLoss: 0 })).toBe(true);
  });
});
