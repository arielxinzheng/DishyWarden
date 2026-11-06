import { describe, expect, it } from 'vitest';
import { arcPath, donutSectorPath, polar } from './dialGeometry';

/** 从 path 字符串里抠出所有数字（用于校验端点） */
function numbers(d: string): number[] {
  return (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
}

/** 按 SVG 指令拆开 path：{ cmd: 'A', args: [rx, ry, rot, largeArc, sweep, x, y] } */
function commands(d: string): { cmd: string; args: number[] }[] {
  return (d.match(/[A-Z][^A-Z]*/g) ?? []).map((s) => ({
    cmd: s[0],
    args: numbers(s.slice(1)),
  }));
}

describe('polar', () => {
  it('罗盘角 0° 在正上方，90° 在正右方', () => {
    expect(polar(100, 100, 50, 0)).toEqual({ x: 100, y: 50 });
    expect(polar(100, 100, 50, 90)).toEqual({ x: 150, y: 100 });
  });

  it('180° 在正下方，270° 在正左方', () => {
    expect(polar(100, 100, 50, 180)).toEqual({ x: 100, y: 150 });
    expect(polar(100, 100, 50, 270)).toEqual({ x: 50, y: 100 });
  });

  it('半径就是到圆心的距离', () => {
    const p = polar(46, 174, 100, 25);
    expect(Math.hypot(p.x - 46, p.y - 174)).toBeCloseTo(100, 6);
  });
});

describe('donutSectorPath', () => {
  it('路径是：外圈弧 → 直连 → 内圈弧 → 闭合', () => {
    const cmds = commands(donutSectorPath(100, 100, 50, 72, 0, 10));
    expect(cmds.map((c) => c.cmd)).toEqual(['M', 'A', 'L', 'A', 'Z']);
  });

  it('起点是外圈起点，外圈终点落在预期位置', () => {
    const cmds = commands(donutSectorPath(100, 100, 50, 72, 0, 10));
    const start = polar(100, 100, 72, 0);
    const end = polar(100, 100, 72, 10);
    expect(cmds[0].args[0]).toBeCloseTo(start.x, 6);
    expect(cmds[0].args[1]).toBeCloseTo(start.y, 6);
    // A rx ry rot largeArc sweep x y —— 端点在最后两个参数
    expect(cmds[1].args[5]).toBeCloseTo(end.x, 6);
    expect(cmds[1].args[6]).toBeCloseTo(end.y, 6);
  });

  it('跨 0° 的带也能正常给出起点（起点允许为负）', () => {
    const cmds = commands(donutSectorPath(100, 100, 50, 72, -5, 10));
    const start = polar(100, 100, 72, -5);
    expect(cmds[0].args[0]).toBeCloseTo(start.x, 6);
    expect(cmds[0].args[1]).toBeCloseTo(start.y, 6);
  });
});

describe('arcPath', () => {
  it('两端落在同一半径上，跨度与给定角度一致', () => {
    const cmds = commands(arcPath(100, 100, 79, -5, 10));
    expect(cmds.map((c) => c.cmd)).toEqual(['M', 'A']);
    const start = polar(100, 100, 79, -5);
    const end = polar(100, 100, 79, 5);
    expect(cmds[0].args[0]).toBeCloseTo(start.x, 6);
    expect(cmds[0].args[1]).toBeCloseTo(start.y, 6);
    expect(cmds[1].args[5]).toBeCloseTo(end.x, 6);
    expect(cmds[1].args[6]).toBeCloseTo(end.y, 6);
  });

  it('弧的两个端点到圆心等距（不会画歪）', () => {
    const cmds = commands(arcPath(46, 174, 106, 20, 10));
    const start = { x: cmds[0].args[0], y: cmds[0].args[1] };
    const end = { x: cmds[1].args[5], y: cmds[1].args[6] };
    expect(Math.hypot(start.x - 46, start.y - 174)).toBeCloseTo(106, 6);
    expect(Math.hypot(end.x - 46, end.y - 174)).toBeCloseTo(106, 6);
  });
});
