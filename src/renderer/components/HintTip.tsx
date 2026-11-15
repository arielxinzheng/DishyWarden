/**
 * 通用「ⓘ 悬浮帮助」组件。
 *
 * ## 为什么不用原生 `title`
 *
 * 原生 `title` 在 Electron/Chromium 里：出现有约 1 秒延迟、完全由系统控制、
 * **样式不可控**，而且在 Electron 里经常根本不弹 ⇒ 做不出统一的帮助浮层。
 *
 * 本组件是 `Dashboard/StatusTooltip.tsx` 那套浮层逻辑的**通用化版本**：
 * 纯 React state 驱动、跟随鼠标、自动避让视口边缘、点击别处/滚动/Esc 关闭。
 *
 * ## 交互
 *
 * - **PC**：鼠标悬停 ⓘ ⇒ 80ms 后显示（延迟避免"划过时闪烁"）
 * - **键盘**：ⓘ 是真 `<button>` ⇒ Tab 可聚焦、Enter/Space 可展开、Esc 关闭
 * - **触屏**：长按 500ms 显示
 *
 * ## 用法
 *
 * ```tsx
 * <HintTip text={t('settings:location.rdp_hint')} />
 * <HintTip title={t('settings:location.usage_title')} text={usageBody} />
 * ```
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

interface TipContent {
  text: string;
  title?: string;
  rect: DOMRect;
  pointer?: { x: number; y: number };
}

/** 浮层相对鼠标的偏移 */
const CURSOR_OFFSET = 14;
/** 浮层最大宽度 */
const MAX_WIDTH = 320;
/** 悬停多久显示 */
const SHOW_DELAY_MS = 80;
/** 触屏长按多久显示 */
const LONG_PRESS_MS = 500;

export interface HintTipProps {
  /** 提示正文，支持 `\n` 换行 */
  text: string;
  /** 可选标题（加粗显示在正文上方） */
  title?: string;
  /**
   * 无障碍标签（给读屏器念的）。
   *
   * ⚠️ 不要退回用 `text` 当标签 —— 正文可能有好几行，
   * 读屏器会把它整段念出来，而且正文此时**并不在浮层里**（未悬停就没渲染）。
   * 没给标签时用通用的"帮助"，含义仍然明确。
   */
  label?: string;
  /** 图标尺寸类名，默认 w-4 h-4 */
  className?: string;
}

export function HintTip({ text, title, label, className }: HintTipProps) {
  const [content, setContent] = useState<TipContent | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const longPressTimer = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const close = useCallback(() => {
    clearTimers();
    setContent(null);
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  // 浮层尺寸测量 + 视口边缘避让
  useEffect(() => {
    if (!content || !tipRef.current) return;
    const r = tipRef.current.getBoundingClientRect();
    const anchorX = content.pointer?.x ?? content.rect.left + content.rect.width / 2;
    const anchorY = content.pointer?.y ?? content.rect.top;

    let x = anchorX + CURSOR_OFFSET;
    let y = anchorY + CURSOR_OFFSET;

    if (x + r.width > window.innerWidth - 8) x = anchorX - r.width - CURSOR_OFFSET;
    if (y + r.height > window.innerHeight - 8) y = anchorY - r.height - CURSOR_OFFSET;
    x = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));

    setPos({ x, y });
  }, [content]);

  // 点击别处 / 滚动 ⇒ 关闭
  useEffect(() => {
    if (!content) return;
    const onDown = (e: MouseEvent) => {
      if (tipRef.current && tipRef.current.contains(e.target as Node)) return;
      close();
    };
    const onScroll = () => close();
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [content, close]);

  // Esc 关闭
  useEffect(() => {
    if (!content) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [content, close]);

  const open = useCallback(
    (el: HTMLElement, pointer?: { x: number; y: number }) => {
      setContent({ text, title, rect: el.getBoundingClientRect(), pointer });
    },
    [text, title],
  );

  const onMouseEnter = (e: React.MouseEvent) => {
    if (timer.current !== null) clearTimeout(timer.current);
    const target = e.currentTarget as HTMLElement;
    timer.current = window.setTimeout(() => open(target, { x: e.clientX, y: e.clientY }), SHOW_DELAY_MS);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!content) return;
    const target = e.currentTarget as HTMLElement;
    setContent({ text, title, rect: target.getBoundingClientRect(), pointer: { x: e.clientX, y: e.clientY } });
  };

  const onMouseLeave = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setContent(null);
  };

  const onFocus = (e: React.FocusEvent) => {
    // 键盘聚焦 ⇒ 无鼠标指针 ⇒ 锚点用元素本身
    open(e.currentTarget as HTMLElement);
  };

  const onBlur = () => setContent(null);

  const onTouchStart = (e: React.TouchEvent) => {
    const target = e.currentTarget as HTMLElement;
    const touch = e.touches[0];
    longPressTimer.current = window.setTimeout(() => {
      open(target, touch ? { x: touch.clientX, y: touch.clientY } : undefined);
    }, LONG_PRESS_MS);
  };

  const onTouchEnd = () => {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label={label ?? title ?? '帮助'}
        className={`inline-flex shrink-0 items-center justify-center rounded-full
                    text-muted-foreground transition-colors hover:text-foreground
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                    ${className ?? 'w-4 h-4 ml-1.5 align-middle'}`}
        onMouseEnter={onMouseEnter}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onFocus={onFocus}
        onBlur={onBlur}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <Info className="w-full h-full" aria-hidden="true" />
      </button>
      {content &&
        // ⭐ 必须用 portal 挂到 body：
        // 祖先元素只要有 transform / filter / backdrop-filter，就会成为
        // position:fixed 的**包含块** ⇒ 浮层会被限制在那个祖先里
        // （底部操作条就有 backdrop-blur）⇒ 表现为"提示文字不显示"。
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            className="fixed z-[9999] pointer-events-none rounded-md border border-border
                       bg-popover/95 px-2.5 py-1.5 text-[11px] leading-relaxed text-foreground
                       shadow-lg backdrop-blur-sm whitespace-pre-line"
            style={{
              left: pos?.x ?? -9999,
              top: pos?.y ?? -9999,
              maxWidth: MAX_WIDTH,
              opacity: pos ? 1 : 0,
              transition: 'opacity 80ms',
            }}
          >
            {content.title && <div className="font-semibold mb-0.5">{content.title}</div>}
            {content.text}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * 把多行说明拼成一段 tooltip 文案（用 `\n` 分行，浮层按 `whitespace-pre-line` 显示）。
 *
 * 抽成纯函数是为了能直接测 —— 组装错了（少一行、换行丢失）是纯展示层最容易出的 bug。
 */
export function buildTipText(lines: readonly string[]): string {
  return lines.filter((l) => l.trim().length > 0).join('\n');
}
