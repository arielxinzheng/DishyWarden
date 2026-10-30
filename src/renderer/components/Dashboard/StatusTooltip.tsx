/**
 * 状态色块条的悬浮提示(自定义浮层)
 *
 * ## 为什么不用原生 title 属性
 *
 * 原生 `title` 在 Electron/Chromium 里:
 *   - 出现有延迟(约 1 秒), 且完全由系统控制, **样式不可控**
 *   - 在 Electron 里经常根本不弹(取决于平台的 tooltip 实现)
 *   - 无法做"长按(移动端)"交互
 *
 * 所以自己画一个浮层: 纯 React state 驱动, hover 显示, 移动端长按显示。
 *
 * ## 交互
 *
 * - **PC**: 鼠标悬停即显示(带 80ms 延迟, 避免划过时闪烁)
 * - **移动端**: 长按 500ms 显示
 * - 移出/点击别处/滚动 ⇒ 隐藏
 * - 位置: 跟随鼠标, 但会自动避让视口边缘
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface TooltipContent {
  /** 提示正文(可含换行) */
  text: string;
  /** 触发提示的元素在视口中的位置 */
  rect: DOMRect;
  /** 鼠标位置(可选) —— 有的话浮层跟随鼠标, 指向更精确 */
  pointer?: { x: number; y: number };
}

export interface StatusTooltipProps {
  /** 当前要显示的提示; null = 不显示 */
  content: TooltipContent | null;
  /** 关闭回调(点击别处/滚动时) */
  onClose: () => void;
}

/** 浮层相对鼠标的偏移 */
const CURSOR_OFFSET = 14;
/** 浮层最大宽度 */
const MAX_WIDTH = 320;

export function StatusTooltip({ content, onClose }: StatusTooltipProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // 测量自身尺寸, 然后避让视口边缘
  useEffect(() => {
    if (!content || !ref.current) return;
    const el = ref.current;
    const r = el.getBoundingClientRect();

    // 跟随鼠标时以鼠标为锚点, 否则以元素中心为锚点
    const anchorX = content.pointer?.x ?? content.rect.left + content.rect.width / 2;
    const anchorY = content.pointer?.y ?? content.rect.top;

    let x = anchorX + CURSOR_OFFSET;
    let y = anchorY + CURSOR_OFFSET;

    // 右/下放不下 ⇒ 翻到另一侧
    if (x + r.width > window.innerWidth - 8) {
      x = anchorX - r.width - CURSOR_OFFSET;
    }
    if (y + r.height > window.innerHeight - 8) {
      y = anchorY - r.height - CURSOR_OFFSET;
    }
    // 左右避让
    x = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));

    setPos({ x, y });
  }, [content]);

  // 点击别处 / 滚动 ⇒ 关闭
  useEffect(() => {
    if (!content) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      onClose();
    };
    const onScroll = () => onClose();
    // capture=true: 在滚动容器上先于 React 事件捕获
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [content, onClose]);

  // Esc 关闭
  useEffect(() => {
    if (!content) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [content, onClose]);

  if (!content) return null;

  return (
    <div
      ref={ref}
      role="tooltip"
      className="fixed z-50 pointer-events-none rounded-md border border-border
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
      {content.text}
    </div>
  );
}

/**
 * 悬浮/长按 触发的 hook。
 *
 * 返回 props 绑到每个色块上, 以及当前提示内容。
 */
export function useStatusTooltip() {
  const [content, setContent] = useState<TooltipContent | null>(null);
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

  /** 生成绑到色块上的事件处理 */
  const handlers = useCallback(
    (text: string) => ({
      onMouseEnter: (e: React.MouseEvent) => {
        if (timer.current !== null) clearTimeout(timer.current);
        const target = e.currentTarget as HTMLElement;
        timer.current = window.setTimeout(() => {
          setContent({
            text,
            rect: target.getBoundingClientRect(),
            pointer: { x: e.clientX, y: e.clientY },
          });
        }, 80);
      },
      onMouseMove: (e: React.MouseEvent) => {
        // 浮层已显示 ⇒ 跟随鼠标移动
        if (content) {
          const target = e.currentTarget as HTMLElement;
          setContent({
            text,
            rect: target.getBoundingClientRect(),
            pointer: { x: e.clientX, y: e.clientY },
          });
        }
      },
      onMouseLeave: () => {
        if (timer.current !== null) {
          clearTimeout(timer.current);
          timer.current = null;
        }
        setContent(null);
      },
      // 移动端长按
      onTouchStart: (e: React.TouchEvent) => {
        const target = e.currentTarget as HTMLElement;
        const touch = e.touches[0];
        longPressTimer.current = window.setTimeout(() => {
          setContent({
            text,
            rect: target.getBoundingClientRect(),
            pointer: touch ? { x: touch.clientX, y: touch.clientY } : undefined,
          });
        }, 500);
      },
      onTouchEnd: () => {
        if (longPressTimer.current !== null) {
          clearTimeout(longPressTimer.current);
          longPressTimer.current = null;
        }
      },
      onTouchMove: () => {
        if (longPressTimer.current !== null) {
          clearTimeout(longPressTimer.current);
          longPressTimer.current = null;
        }
      },
    }),
    [content]
  );

  return { content, handlers, close };
}
