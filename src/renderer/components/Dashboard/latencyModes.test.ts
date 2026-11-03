/**
 * 卫星切换标记的**模式可见性**测试
 *
 * ## 为什么要按模式区分
 *
 * 三个延迟维度走不同的物理路径：
 * - PoP / Public：终端 → 卫星 → 对端 ⇒ 卫星切换会影响延迟
 * - Local：终端 → 本地网关/路由器 ⇒ **不经卫星**，切换对它毫无影响
 *
 * 在 Local 折线上标 ★ 卫星切换是语义错误 ——
 * 用户会把本地链路故障误判成卫星问题，故障定位方向就跑偏了。
 *
 * ⇒ Local 模式下必须清空该 series 的数据 + 隐藏图层。
 */

import { describe, it, expect } from 'vitest';
import { showsSatelliteHandoffs } from './latencyModes';

describe('showsSatelliteHandoffs', () => {
  it('PoP 显示卫星切换标记(经卫星链路)', () => {
    expect(showsSatelliteHandoffs('pop')).toBe(true);
  });

  it('Public 显示卫星切换标记(经卫星链路)', () => {
    expect(showsSatelliteHandoffs('public')).toBe(true);
  });

  it('Local 不显示卫星切换标记(本地链路不经卫星)', () => {
    expect(showsSatelliteHandoffs('gateway')).toBe(false);
  });
});
