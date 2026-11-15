import { describe, it, expect } from 'vitest';
import { resolveLocation } from './locationFallback';

const deps = (over: Partial<Parameters<typeof resolveLocation>[0]> = {}) => ({
  fromDish: async () => ({ lat: 40.050835, lon: 116.296371 }),
  fromBrowser: async () => ({ lat: '1.000000', lon: '2.000000' }),
  formatDishFailure: (e: unknown) => `dish 失败: ${String(e)}`,
  formatBrowserFailure: (e: unknown) => `browser 失败: ${String(e)}`,
  ...over,
});

describe('resolveLocation（终端 GPS → 浏览器定位）', () => {
  it('终端取到就返回，不调用浏览器', async () => {
    let browserCalled = false;
    const out = await resolveLocation(
      deps({
        fromBrowser: async () => {
          browserCalled = true;
          return { lat: '0', lon: '0' };
        },
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.source).toBe('dish');
      expect(out.lat).toBe('40.050835');
      expect(out.lon).toBe('116.296371');
    }
    expect(browserCalled).toBe(false);
  });

  it('终端返回 null ⇒ 自动回落浏览器（这就是用户要的兜底）', async () => {
    const out = await resolveLocation(deps({ fromDish: async () => null }));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.source).toBe('browser');
      expect(out.lat).toBe('1.000000');
    }
  });

  it('终端抛异常 ⇒ 自动回落浏览器', async () => {
    const out = await resolveLocation(
      deps({
        fromDish: async () => {
          throw new Error('PERMISSION_DENIED');
        },
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.source).toBe('browser');
  });

  it('两边都失败 ⇒ 两条原因都在，且尝试顺序是 终端→浏览器', async () => {
    const out = await resolveLocation(
      deps({
        fromDish: async () => {
          throw new Error('code 7');
        },
        fromBrowser: async () => {
          throw new Error('POSITION_UNAVAILABLE');
        },
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.attempted).toEqual(['dish', 'browser']);
      expect(out.reasons.join(' | ')).toContain('code 7');
      expect(out.reasons.join(' | ')).toContain('POSITION_UNAVAILABLE');
    }
  });

  it('终端失败 + 浏览器失败 ⇒ 不会只报一条原因', async () => {
    const out = await resolveLocation(
      deps({
        fromDish: async () => null,
        fromBrowser: async () => {
          throw new Error('TIMEOUT');
        },
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reasons.length).toBe(2);
  });
});
