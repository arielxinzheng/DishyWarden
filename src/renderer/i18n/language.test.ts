import { describe, it, expect } from 'vitest';
import { resolveLanguage } from './index';

/**
 * 语言嗅探的判定逻辑（纯函数部分）。
 *
 * 需求规定的优先级：
 *   ① 用户显式选择（localStorage `i18nextLng`）—— detector 负责，优先级最高；
 *   ② 浏览器 / 系统语言（navigator.language）；
 *   ③ 不支持的语言 ⇒ **静默降级到 en**，不报错、不显示键名。
 *
 * 这里覆盖 ②③ 的收敛规则：把浏览器可能给出的各种语言标记
 * （`zh`、`zh-Hans`、`ja-JP`、`ar`…）映射到受支持的语言码。
 */
describe('语言嗅探：浏览器语言 → 受支持语言码', () => {
  it('精确命中受支持的语言码', () => {
    expect(resolveLanguage('zh-CN')).toBe('zh-CN');
    expect(resolveLanguage('en')).toBe('en');
    expect(resolveLanguage('ja')).toBe('ja');
    expect(resolveLanguage('ko')).toBe('ko');
    expect(resolveLanguage('vi')).toBe('vi');
  });

  it('大小写不敏感', () => {
    expect(resolveLanguage('ZH-cn')).toBe('zh-CN');
    expect(resolveLanguage('EN')).toBe('en');
  });

  it('中文的各种写法统一收敛到 zh-CN', () => {
    expect(resolveLanguage('zh')).toBe('zh-CN');
    expect(resolveLanguage('zh-Hans')).toBe('zh-CN');
    expect(resolveLanguage('zh-Hans-CN')).toBe('zh-CN');
    expect(resolveLanguage('zh-SG')).toBe('zh-CN');
  });

  it('繁体中文暂无语言包 ⇒ 静默降级英文', () => {
    expect(resolveLanguage('zh-TW')).toBe('en');
    expect(resolveLanguage('zh-HK')).toBe('en');
    expect(resolveLanguage('zh-Hant')).toBe('en');
  });

  it('带地区码的其它语言按语种收敛', () => {
    expect(resolveLanguage('ja-JP')).toBe('ja');
    expect(resolveLanguage('ko-KR')).toBe('ko');
    expect(resolveLanguage('vi-VN')).toBe('vi');
    expect(resolveLanguage('en-US')).toBe('en');
    expect(resolveLanguage('en-GB')).toBe('en');
  });

  it('未支持的语言（阿拉伯语等）静默降级英文', () => {
    expect(resolveLanguage('ar')).toBe('en');
    expect(resolveLanguage('ar-SA')).toBe('en');
    expect(resolveLanguage('fr')).toBe('en');
    expect(resolveLanguage('de-DE')).toBe('en');
    expect(resolveLanguage('ru')).toBe('en');
  });

  it('拿不到语言标记时也降级英文（不猜中文）', () => {
    expect(resolveLanguage(undefined)).toBe('en');
    expect(resolveLanguage(null)).toBe('en');
    expect(resolveLanguage('')).toBe('en');
  });

  it('结果一定是受支持的语言码（不会漏出原始标记）', () => {
    const supported = new Set(['zh-CN', 'en', 'ja', 'ko', 'vi']);
    for (const raw of ['zh', 'zh-Hans', 'zh-TW', 'ja-JP', 'ko', 'vi-VN', 'ar', 'fr-CA', 'xx', '']) {
      expect(supported.has(resolveLanguage(raw))).toBe(true);
    }
  });
});
