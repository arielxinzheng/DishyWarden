/**
 * 方位角归一化的回归测试
 *
 * ## 为什么需要这个测试
 *
 * 真机上出现过：天空视图**只画蓝色可见卫星**，红色当前服务卫星、橙色候选卫星、
 * 紫色设备波束十字全部消失，卡片数据却完全正常（角距离、仰角、候选数都对）。
 *
 * 根因：`satellite.js` 的 `lookAngles.azimuth` 是 **-π..π**，`radiansToDegrees`
 * 转出来是 **-180..180**；而设备上报的波束方位角也是带符号的（实测 -55.7°）。
 * 天空视图的极坐标角度轴是固定区间 `0..360`，**负数角度落在轴范围外会被
 * ECharts 静默丢弃** —— 不报错、不留日志，点就是不画。
 *
 * 服务卫星、候选卫星、波束指向三者方位角必然很接近（候选就是"离波束最近的几颗"），
 * 所以一旦那个方位角是负的，三层标记会**同时**消失，而其余卫星照常显示。
 *
 * 这个测试钉住归一化本身，避免有人"优化"掉它。
 */
import { describe, it, expect } from 'vitest';
import { normalizeAzimuth } from './satelliteCalculator';

describe('normalizeAzimuth', () => {
  it('保留已经在 [0, 360) 内的角度', () => {
    expect(normalizeAzimuth(0)).toBe(0);
    expect(normalizeAzimuth(90)).toBe(90);
    expect(normalizeAzimuth(359.9)).toBeCloseTo(359.9, 6);
  });

  it('把负角度折回正区间 —— 这正是真机丢点的原因', () => {
    // 真机上报过的样本
    expect(normalizeAzimuth(-55.7)).toBeCloseTo(304.3, 6);
    expect(normalizeAzimuth(-180)).toBeCloseTo(180, 6);
    expect(normalizeAzimuth(-1)).toBeCloseTo(359, 6);
  });

  it('处理超过一圈的角度', () => {
    expect(normalizeAzimuth(360)).toBe(0);
    expect(normalizeAzimuth(725)).toBeCloseTo(5, 6);
    expect(normalizeAzimuth(-365)).toBeCloseTo(355, 6);
  });

  it('非有限值原样返回，不制造虚假方位', () => {
    expect(Number.isNaN(normalizeAzimuth(Number.NaN))).toBe(true);
    expect(normalizeAzimuth(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(normalizeAzimuth(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('归一化结果永远落在 [0, 360)', () => {
    for (let deg = -720; deg <= 720; deg += 7.3) {
      const az = normalizeAzimuth(deg);
      expect(az).toBeGreaterThanOrEqual(0);
      expect(az).toBeLessThan(360);
    }
  });
});
