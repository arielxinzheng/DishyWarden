import { describe, expect, it } from 'vitest';
import { describeAttitudeState } from './attitudeState';
import { formatDeg, formatSignedDeg } from './format';

describe('formatDeg', () => {
  it('把浮点噪声收敛到一位小数', () => {
    expect(formatDeg(24.799999237060547)).toBe('24.8°');
    expect(formatDeg(76.20000000000002)).toBe('76.2°');
  });

  it('无有效值统一显示占位符，不出现 NaN°', () => {
    expect(formatDeg(undefined)).toBe('—');
    expect(formatDeg(null)).toBe('—');
    expect(formatDeg(Number.NaN)).toBe('—');
    expect(formatDeg(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('-0 不渲染成 -0.0', () => {
    expect(formatDeg(-0)).toBe('0.0°');
  });
});

describe('formatSignedDeg', () => {
  it('正偏差带 + 号，负偏差保留 - 号', () => {
    expect(formatSignedDeg(3.24)).toBe('+3.2°');
    expect(formatSignedDeg(-3.24)).toBe('-3.2°');
    expect(formatSignedDeg(0)).toBe('0.0°');
  });
});

describe('describeAttitudeState', () => {
  it('FILTER_CONVERGED 渲染为「已就绪 + 精度」，而不是枚举原文', () => {
    const view = describeAttitudeState('FILTER_CONVERGED', 0.4);
    expect(view.tone).toBe('ok');
    expect(view.icon).toBe('🟢');
    expect(view.label).toBe('姿态传感器已就绪 (精度 ±0.4°)');
    expect(view.converged).toBe(true);
  });

  it('拿不到精度时不渲染空括号', () => {
    const view = describeAttitudeState('FILTER_CONVERGED', undefined);
    expect(view.label).toBe('姿态传感器已就绪');
  });

  it('收敛告警中 / 初始化 / 重置 都算未收敛', () => {
    for (const state of ['FILTER_CONVERGENCE_WARNING', 'FILTER_INITIALIZING', 'FILTER_RESET']) {
      const view = describeAttitudeState(state, 1.2);
      expect(view.converged).toBe(false);
      expect(view.tone).toBe('warn');
    }
  });

  it('大小写不影响判定', () => {
    expect(describeAttitudeState('filter_converged', 0.4).converged).toBe(true);
  });

  it('INVALID_STATE 是红色异常', () => {
    expect(describeAttitudeState('INVALID_STATE', undefined).tone).toBe('bad');
  });

  it('未知枚举不猜结论，但把原始值露出来便于排查', () => {
    const view = describeAttitudeState('SOMETHING_NEW', undefined);
    expect(view.tone).toBe('neutral');
    expect(view.converged).toBe(false);
    expect(view.label).toContain('SOMETHING_NEW');
  });

  it('空状态走「暂未收到」而不是未知枚举', () => {
    expect(describeAttitudeState(undefined, undefined).label).toBe('暂未收到姿态状态');
  });

  it('历史 bug 回归：VALID 不是协议里的枚举，不能判成已对齐', () => {
    expect(describeAttitudeState('VALID', 0.4).converged).toBe(false);
  });
});