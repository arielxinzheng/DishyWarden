import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCE_DEG,
  elevationModel,
  judgeAlignment,
  rotationModel,
  shortestDelta,
} from './alignmentGuidance';

/**
 * 断言对象是**语义码 + 数值**（action / direction / adjustDeg），不是文案。
 * 文案由 guidanceText.ts 组装，换语言不该让这些用例失败。
 */
describe('shortestDelta', () => {
  it('常规差值', () => {
    expect(shortestDelta(20, 30)).toBe(10);
    expect(shortestDelta(30, 20)).toBe(-10);
  });

  it('跨 0° 走最短路径而不是绕一圈', () => {
    expect(shortestDelta(350, 10)).toBe(20);
    expect(shortestDelta(10, 350)).toBe(-20);
  });

  it('结果落在 [-180, 180)', () => {
    for (const from of [0, 45, 179, 181, 270, 359]) {
      for (const to of [0, 45, 179, 181, 270, 359]) {
        const delta = shortestDelta(from, to);
        expect(delta).toBeGreaterThanOrEqual(-180);
        expect(delta).toBeLessThan(180);
      }
    }
  });
});

describe('rotationModel', () => {
  it('落在容差内时判进带，指针与带同时在另一侧也不会误判', () => {
    // 358° 与 2° 跨过 0°，真实差值只有 4°
    const model = rotationModel(358, 2);
    expect(model.inBand).toBe(true);
    expect(model.action).toBe('aligned');
    expect(model.direction).toBe('none');
    expect(model.adjustDeg).toBeNull();
    expect(model.nudgeClockwise).toBeNull();
  });

  it('需要向东转时给出 rotate / cw 与顺时针箭头', () => {
    const model = rotationModel(10, 30);
    expect(model.inBand).toBe(false);
    expect(model.action).toBe('rotate');
    expect(model.direction).toBe('cw');
    expect(model.adjustDeg).toBeCloseTo(20, 10);
    expect(model.nudgeClockwise).toBe(true);
  });

  it('需要向西转时给出 rotate / ccw 与逆时针箭头', () => {
    const model = rotationModel(30, 10);
    expect(model.action).toBe('rotate');
    expect(model.direction).toBe('ccw');
    expect(model.adjustDeg).toBeCloseTo(20, 10);
    expect(model.nudgeClockwise).toBe(false);
  });

  it('推荐带跨度是 2 倍容差，且起点允许为负（跨 0° 的画法）', () => {
    const model = rotationModel(0, 2);
    expect(model.bandSpanCompass).toBe(DEFAULT_TOLERANCE_DEG * 2);
    expect(model.bandStartCompass).toBe(2 - DEFAULT_TOLERANCE_DEG);
    expect(model.bandStartCompass).toBeLessThan(0);
  });

  it('推荐区间边界按方位角归一化，供视图层直接格式化', () => {
    const model = rotationModel(0, 2);
    expect(model.bandLowDeg).toBeCloseTo(357, 10);
    expect(model.bandHighDeg).toBeCloseTo(7, 10);
  });

  it('设备没给期望值时不出带、也不判对齐', () => {
    const model = rotationModel(120, undefined);
    expect(model.hasBand).toBe(false);
    expect(model.inBand).toBe(false);
    expect(model.action).toBe('no_expected');
    expect(model.direction).toBe('none');
    expect(model.adjustDeg).toBeNull();
    expect(model.bandLowDeg).toBeNull();
    expect(model.bandHighDeg).toBeNull();
    expect(model.deltaDeg).toBeNull();
    expect(model.nudgeClockwise).toBeNull();
  });

  it('恰好等于容差算进带（边界是闭区间）', () => {
    expect(rotationModel(25, 30).inBand).toBe(true);
    expect(rotationModel(24.5, 30).inBand).toBe(false);
  });
});

describe('elevationModel', () => {
  it('仰角换算成罗盘角：垂直向上 = 0°，水平 = 90°', () => {
    expect(elevationModel(90, 90).pointerCompass).toBe(0);
    expect(elevationModel(0, 0).pointerCompass).toBe(90);
  });

  it('仰角不足时给出 raise / ccw，且箭头指向罗盘角减小方向', () => {
    const model = elevationModel(60, 76);
    expect(model.inBand).toBe(false);
    expect(model.action).toBe('raise');
    expect(model.direction).toBe('ccw');
    expect(model.adjustDeg).toBeCloseTo(16, 10);
    expect(model.nudgeClockwise).toBe(false);
  });

  it('仰角过高时给出 lower / cw', () => {
    const model = elevationModel(88, 76);
    expect(model.action).toBe('lower');
    expect(model.direction).toBe('cw');
    expect(model.adjustDeg).toBeCloseTo(12, 10);
    expect(model.nudgeClockwise).toBe(true);
  });

  it('推荐带的罗盘起点取「期望 + 容差」，仰角越高罗盘角越小', () => {
    const tolerance = DEFAULT_TOLERANCE_DEG;
    const model = elevationModel(76, 76, tolerance);
    expect(model.bandStartCompass).toBe(90 - (76 + tolerance));
    expect(model.bandSpanCompass).toBe(tolerance * 2);
    expect(model.bandLowDeg).toBe(76 - tolerance);
    expect(model.bandHighDeg).toBe(76 + tolerance);
    expect(model.inBand).toBe(true);
    expect(model.action).toBe('aligned');
  });
});

describe('judgeAlignment', () => {
  const inBand = rotationModel(30, 30);
  const outOfBand = rotationModel(10, 30);

  it('三件事同时成立才算对齐', () => {
    const verdict = judgeAlignment(true, inBand, inBand);
    expect(verdict.aligned).toBe(true);
    expect(verdict.code).toBe('aligned');
    expect(verdict.pending).toEqual([]);
  });

  it('滤波器没收敛时不催用户转天线，先要求等状态就绪', () => {
    const verdict = judgeAlignment(false, outOfBand, outOfBand);
    expect(verdict.aligned).toBe(false);
    expect(verdict.code).toBe('calibrating');
    expect(verdict.pending).toEqual([]);
  });

  it('缺少期望值时明确说明无法自动判断', () => {
    const verdict = judgeAlignment(true, rotationModel(30, undefined), inBand);
    expect(verdict.aligned).toBe(false);
    expect(verdict.code).toBe('missing_expected');
  });

  it('部分进带时把还差的动作都列出来（语义码，可组装任何语言）', () => {
    const verdict = judgeAlignment(true, outOfBand, elevationModel(60, 76));
    expect(verdict.aligned).toBe(false);
    expect(verdict.code).toBe('almost');
    expect(verdict.pending).toHaveLength(2);
    expect(verdict.pending[0]).toEqual({ action: 'rotate', direction: 'cw', adjustDeg: 20 });
    expect(verdict.pending[1]).toEqual({ action: 'raise', direction: 'ccw', adjustDeg: 16 });
  });

  it('只有一个盘没进带时只列一条', () => {
    const verdict = judgeAlignment(true, inBand, elevationModel(60, 76));
    expect(verdict.code).toBe('almost');
    expect(verdict.pending).toHaveLength(1);
    expect(verdict.pending[0]!.action).toBe('raise');
  });
});
