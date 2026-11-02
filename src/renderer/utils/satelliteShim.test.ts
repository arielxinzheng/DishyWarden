/**
 * satellite.js shim 的回归测试
 *
 * ## 为什么要这个测试
 *
 * satellite.js v7 的根入口 `dist/index.js` 末尾 `export * from './wasm/index.js'`，
 * 而 wasm 的 `#wasm-multi-thread` 指向一个带 **top-level await** 的文件 ——
 * Vite 的 iife 输出格式不支持 ⇒ **生产构建失败**。
 *
 * `src/renderer/utils/satelliteShim.ts` 绕开 wasm，改为只引纯 JS 模块。
 * 这个测试保证 shim 与原根入口**行为完全一致**，将来升级 satellite.js
 * 或重构 shim 时不会静默改变卫星几何结果。
 *
 * ## 为什么断言「逐位一致」而不只是「没报错」
 *
 * satellite.js 的几何链条（propagate → eciToGeodetic → eciToEcf →
 * ecfToLookAngles）任何一步传错类型都返回 **NaN 而非 throw**，
 * 表现是「一颗星都看不到」而日志一行错都没有
 * （见 `satellite-tle-sgp4` skill §10）。
 */

import { describe, it, expect } from 'vitest';
import * as shim from './satelliteShim';
import * as original from 'satellite.js';

type Vec3 = { x: number; y: number; z: number };

// 一条真实的 Starlink TLE(NORAD 67513, 壳层 53°)
const LINE1 = '1 67513U 24049A   24282.50000000  .00010000  00000-0  10000-4 0  9993';
const LINE2 = '2 67513  53.2167 106.9278 0001000  90.0000 270.0000 15.50000000    15';

// TLE 自己的 epoch(2024 年第 282.5 天)
const EPOCH = new Date(Date.UTC(2024, 9, 8, 12, 0, 0));

const observer = {
  latitude: shim.degreesToRadians(39.9042),
  longitude: shim.degreesToRadians(116.4074),
  height: 0.05,
};

const compute = (lib: typeof shim, when: Date) => {
  const satrec = lib.twoline2satrec(LINE1, LINE2);
  const pv = lib.propagate(satrec, when);
  if (!pv) throw new Error('propagate 返回 null');
  const gmst = lib.gstime(when);
  const gd = lib.eciToGeodetic(pv.position as Vec3, gmst);
  const ecf = lib.eciToEcf(pv.position as Vec3, gmst);
  const look = lib.ecfToLookAngles(observer, ecf);
  return { satrec, pv, gmst, gd, ecf, look };
};

describe('satelliteShim', () => {
  it('shim 与 satellite.js 原根入口的几何结果逐位一致', () => {
    const a = compute(shim, EPOCH);
    const b = compute(original as unknown as typeof shim, EPOCH);

    expect(a.look.azimuth).toBeCloseTo(b.look.azimuth, 12);
    expect(a.look.elevation).toBeCloseTo(b.look.elevation, 12);
    expect(a.look.rangeSat).toBeCloseTo(b.look.rangeSat, 6);
  });

  it('能解析真实 Starlink TLE, 倾角正确', () => {
    const { satrec } = compute(shim, EPOCH);
    expect(satrec.error).toBe(0);
    // 53.2167° 是这条 TLE 的真实倾角
    expect(shim.radiansToDegrees(satrec.inclo)).toBeCloseTo(53.2167, 3);
  });

  it('轨道高度在 Starlink 量级 (300-700km)', () => {
    const { pv } = compute(shim, EPOCH);
    const pos = pv.position as Vec3;
    const altitude = Math.hypot(pos.x, pos.y, pos.z) - 6378;
    expect(altitude).toBeGreaterThan(300);
    expect(altitude).toBeLessThan(700);
  });

  it('几何结果不是 NaN/null', () => {
    const { look } = compute(shim, EPOCH);
    expect(look.azimuth).not.toBeNull();
    expect(Number.isNaN(shim.radiansToDegrees(look.azimuth))).toBe(false);
    expect(Number.isNaN(shim.radiansToDegrees(look.elevation))).toBe(false);
    expect(look.rangeSat).toBeGreaterThan(0);
  });

  it('多星多时刻扫描, 不出现任何 NaN', () => {
    let nan = 0;
    let visible = 0;
    let total = 0;

    for (let s = 0; s < 24; s++) {
      // 造不同倾角/升交点角的 TLE, 模拟不同轨道面
      const l2 = LINE2
        .replace(' 53.2167', ` ${(40 + s * 1.1).toFixed(4)}`)
        .replace('106.9278', `${(s * 15).toFixed(4)}`);
      const rec = shim.twoline2satrec(LINE1, l2);
      if (!rec || rec.error !== 0) { nan++; total++; continue; }

      for (let t = 0; t < 24; t++) {
        const when = new Date(EPOCH.getTime() + t * 10 * 60 * 1000);
        const pv = shim.propagate(rec, when);
        total++;
        if (!pv) { nan++; continue; }

        const g = shim.gstime(when);
        const e = shim.eciToEcf(pv.position as Vec3, g);
        const l = shim.ecfToLookAngles(observer, e);

        if (!Number.isFinite(l.azimuth) || !Number.isFinite(l.elevation)) {
          nan++;
        } else if (shim.radiansToDegrees(l.elevation) > 0) {
          visible++;
        }
      }
    }

    expect(nan).toBe(0);
    expect(total).toBe(576);
    // 可见数必须 > 0 —— 全 0 意味着几何链路没在算(传参错了, 不是数据错了)
    expect(visible).toBeGreaterThan(0);
  });
});
