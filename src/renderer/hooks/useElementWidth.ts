/**
 * 测量某个元素的宽度, 随窗口/布局变化自动更新。
 *
 * 用 ResizeObserver 而不是 window resize 监听 ——
 * 后者只在窗口变化时触发, 侧边栏折叠、grid 换行等**布局**变化
 * 不会触发, 而卡片宽度恰恰会在这些时候变。
 *
 * ## 为什么用回调 ref 而不是 RefObject
 *
 * `useEffect(() => { const el = ref.current; ... }, [ref])` 在**首帧元素还不存在**时
 * 会静默失效:
 *   - effect 跑的时候 ref.current 是 null ⇒ 提前 return, 观察器没挂上
 *   - 之后元素渲染出来了, 但 effect 的依赖没变 ⇒ 不会再跑
 *   - 结果: 宽度永远停在 fallback
 *
 * 这个坑在 Dashboard 里真实发生过 —— 它有 `if (!telemetry) return null`,
 * 首帧没有数据、元素不存在, 等数据到了元素才出现, 测量就永远失效了。
 *
 * 回调 ref 每次元素挂载/卸载都会调用, 所以元素**出现的那一刻**就能挂上观察器。
 *
 * 用途: 状态色块条要按可用宽度决定放多少块(见 fitStatusSlots),
 * 不能压缩 Gap, 只能减块数 —— 所以必须知道真实可用宽度。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * @returns [refCallback, width] —— 把 refCallback 挂到目标元素上, width 是其实测宽度
 */
export function useElementWidth<T extends HTMLElement>(
  fallback = 0
): [(node: T | null) => void, number] {
  const [width, setWidth] = useState(fallback);
  const observer = useRef<ResizeObserver | null>(null);
  const frame = useRef<number | null>(null);
  const node = useRef<T | null>(null);

  const measure = useCallback((el: T | null) => {
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    // 只在真的变了才 setState, 避免 ResizeObserver 循环触发
    setWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
  }, []);

  const refCallback = useCallback(
    (el: T | null) => {
      // 卸载旧元素
      observer.current?.disconnect();
      observer.current = null;
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      node.current = el;
      if (!el) return;

      measure(el);

      // 没有 ResizeObserver 的环境(老 WebKit)退回 window resize
      if (typeof ResizeObserver === 'undefined') {
        const onResize = () => measure(el);
        window.addEventListener('resize', onResize);
        observer.current = { disconnect: () => window.removeEventListener('resize', onResize) } as ResizeObserver;
        return;
      }

      const ro = new ResizeObserver(() => {
        // 用 rAF 合并, 避免同一帧内多次 setState
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          measure(node.current);
        });
      });
      ro.observe(el);
      observer.current = ro;
    },
    [measure]
  );

  useEffect(() => () => {
    observer.current?.disconnect();
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  return [refCallback, width];
}
