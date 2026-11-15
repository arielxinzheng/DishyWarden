import { describe, it, expect } from 'vitest';
import { resolveLocation } from './locationFallback';

const deps = (over: Partial<Parameters<typeof resolveLocation>[0]> = {}) => ({
  fromDish: async () => ({ lat: 40.050835, lon: 116.296371 }),
  fromBrowser: async () => ({ lat: '1.000000', lon: '2.000000' }),
  formatDishFailure: (e: unknown) => `dish 失败: ${String(e)}`,
  formatBrowserFailure: (e: unknown) => `browser 失败: ${String(e)}`,
  ...over,
});

describe('resolveLocation（浏览器定位 → 终端 GPS → 手动）', () => {
  it('浏览器定位成功就直接返回，不去碰终端（多数终端已封闭该接口）', async () => {
    let dishCalled = false;
    const out = await resolveLocation(
      deps({
        fromDish: async () => {
          dishCalled = true;
          return { lat: 40.050835, lon: 116.296371 };
        },
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.source).toBe('browser');
      expect(out.lat).toBe('1.000000');
    }
    expect(dishCalled).toBe(false);
  });

  it('浏览器定位失败 ⇒ 自动回落到终端 GPS', async () => {
    const out = await resolveLocation(
      deps({
        fromBrowser: async () => {
          throw new Error('POSITION_UNAVAILABLE');
        },
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.source).toBe('dish');
      expect(out.lat).toBe('40.050835');
    }
  });

  it('浏览器定位失败 + 终端抛异常 ⇒ 自动回落到终端 GPS', async () => {
    const out = await resolveLocation(
      deps({
        fromBrowser: async () => {
          throw new Error('PERMISSION_DENIED');
        },
        fromDish: async () => {
          throw new Error('UNIMPLEMENTED');
        },
      }),
    );
    expect(out.ok).toBe(false);
  });

  it('两边都失败 ⇒ 两条原因都在，且尝试顺序是 浏览器→终端', async () => {
    const out = await resolveLocation(
      deps({
        fromBrowser: async () => {
          throw new Error('POSITION_UNAVAILABLE');
        },
        fromDish: async () => {
          throw new Error('code 7');
        },
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.attempted).toEqual(['browser', 'dish']);
      expect(out.reasons.join(' | ')).toContain('POSITION_UNAVAILABLE');
      expect(out.reasons.join(' | ')).toContain('code 7');
    }
  });

  it('终端返回 null（不支持）也算失败 ⇒ 两条原因都在', async () => {
    const out = await resolveLocation(
      deps({
        fromBrowser: async () => {
          throw new Error('TIMEOUT');
        },
        fromDish: async () => null,
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reasons.length).toBe(2);
  });
});
