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

/**
 * 只断言语义码 / 数值，不出现任何语言的文案 —— 翻译在视图层。
 */
describe('describeAttitudeState', () => {
  it('FILTER_CONVERGED → converged / ok / 已收敛', () => {
    const view = describeAttitudeState('FILTER_CONVERGED', 0.4);
    expect(view.state).toBe('converged');
    expect(view.tone).toBe('ok');
    expect(view.icon).toBe('🟢');
    expect(view.converged).toBe(true);
    expect(view.uncertaintyDeg).toBe(0.4);
  });

  it('拿不到精度时不带 uncertaintyDeg（视图层据此不加括号）', () => {
    const view = describeAttitudeState('FILTER_CONVERGED', undefined);
    expect(view.state).toBe('converged');
    expect(view.uncertaintyDeg).toBeUndefined();
  });

  it('精度为 NaN/Infinity 时同样不带', () => {
    expect(describeAttitudeState('FILTER_CONVERGED', Number.NaN).uncertaintyDeg).toBeUndefined();
    expect(describeAttitudeState('FILTER_CONVERGED', Number.POSITIVE_INFINITY).uncertaintyDeg).toBeUndefined();
  });

  it('收敛告警中 / 初始化 / 重置 都算未收敛', () => {
    const expected: Record<string, string> = {
      FILTER_CONVERGENCE_WARNING: 'convergence_warning',
      FILTER_INITIALIZING: 'initializing',
      FILTER_RESET: 'reset',
    };
    for (const [raw, state] of Object.entries(expected)) {
      const view = describeAttitudeState(raw, 1.2);
      expect(view.state).toBe(state);
      expect(view.converged).toBe(false);
      expect(view.tone).toBe('warn');
    }
  });

  it('大小写不影响判定', () => {
    expect(describeAttitudeState('filter_converged', 0.4).converged).toBe(true);
  });

  it('INVALID_STATE 是红色异常', () => {
    const view = describeAttitudeState('INVALID_STATE', undefined);
    expect(view.state).toBe('invalid');
    expect(view.tone).toBe('bad');
  });

  it('未知枚举不猜结论，但把原始值露出来便于排查', () => {
    const view = describeAttitudeState('SOMETHING_NEW', undefined);
    expect(view.state).toBe('unknown');
    expect(view.tone).toBe('unknown');
    expect(view.converged).toBe(false);
    expect(view.rawState).toContain('SOMETHING_NEW');
  });

  it('空状态走「未上报」，而不是未知枚举', () => {
    const view = describeAttitudeState(undefined, undefined);
    expect(view.state).toBe('unreported');
    expect(view.tone).toBe('unknown');
    expect(view.rawState).toBeUndefined();
  });

  it('历史 bug 回归：VALID 不是协议里的枚举，不能判成已对齐', () => {
    const view = describeAttitudeState('VALID', 0.4);
    expect(view.converged).toBe(false);
    expect(view.state).toBe('unknown');
  });
});
