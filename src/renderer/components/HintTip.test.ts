/**
 * HintTip：把「常驻小字说明」变成「ⓘ 悬浮帮助」之后，
 * 要保证三件事：
 *   1. 触发元素是**真按钮** ⇒ 键盘可达（Tab / Enter / Space），无障碍不丢；
 *   2. 提示正文**在 DOM 里可读**（不是只存在于 title 属性里）；
 *   3. 标题与正文都原样带出去（多行用 \n 分隔，浮层按 pre-line 显示）。
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HintTip, buildTipText } from './HintTip';

describe('HintTip', () => {
  it('渲染成真按钮（键盘可达、读屏器能念）', () => {
    const html = renderToStaticMarkup(
      createElement(HintTip, { text: '提示正文', label: '帮助' }),
    );
    expect(html).toContain('<button');
    expect(html).toContain('type="button"');
    // 无障碍标签必须给上，否则读屏器只念"按钮"
    expect(html).toContain('aria-label="帮助"');
  });

  it('没有显式 label 时用通用标签，**不把正文塞进 aria-label**', () => {
    // 正文可能好几行，塞进 aria-label 会让读屏器整段念出来
    const html = renderToStaticMarkup(createElement(HintTip, { text: '很长很长的正文…' }));
    expect(html).toContain('aria-label="帮助"');
    expect(html).not.toContain('很长很长的正文');
  });

  it('图标用 Info（lucide）且不可被读屏器重复念', () => {
    const html = renderToStaticMarkup(createElement(HintTip, { text: 'x' }));
    expect(html).toContain('lucide-info');
    expect(html).toContain('aria-hidden="true"');
  });

  it('未悬停时不渲染浮层（提示不进 DOM，避免常驻占版面）', () => {
    const html = renderToStaticMarkup(createElement(HintTip, { text: '不该出现' }));
    expect(html).not.toContain('不该出现');
    expect(html).not.toContain('role="tooltip"');
  });
});

describe('buildTipText', () => {
  it('多行用 \\n 连接', () => {
    expect(buildTipText(['第一行', '第二行'])).toBe('第一行\n第二行');
  });

  it('丢掉空行（避免浮层里出现多余空隙）', () => {
    expect(buildTipText(['A', '   ', '', 'B'])).toBe('A\nB');
  });

  it('空数组 ⇒ 空串', () => {
    expect(buildTipText([])).toBe('');
  });
});
