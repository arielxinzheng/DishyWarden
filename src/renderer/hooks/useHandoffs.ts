/**
 * 卫星切换事件的渲染层 hook
 *
 * 数据源是 `dishGetHistory` 的 outages[]（采集器分析后落库到
 * `satellite_handoffs` 表），供「延迟与丢包走势」图标注 ★ 卫星切换 点。
 *
 * ## 为什么单独一个文件
 *
 * `useDish.tsx` 里有 React 组件，ESLint 的 `react-refresh/only-export-components`
 * 规则要求「组件文件只导出组件」。hook 放这里，避免给 useDish.tsx 增加告警。
 */

import { useEffect, useState } from 'react';
import type { HandoffEvent } from '@/core/outageAnalyzer';

/**
 * 拉取区间内的卫星切换事件。
 *
 * 刷新频率比历史数据更密（30s vs 60s）—— 切换本身是秒级事件，
 * 采集器每 30s 一轮就会把新切换写进库。
 */
export function useHandoffs(seconds: number): HandoffEvent[] {
  const [handoffs, setHandoffs] = useState<HandoffEvent[]>([]);
  const isElectron = !!window.electronAPI;

  useEffect(() => {
    if (!isElectron) return;

    const fetchHandoffs = async () => {
      try {
        const data = await window.electronAPI.getHandoffs(seconds);
        setHandoffs(data);
      } catch (error) {
        console.error('Failed to fetch handoffs:', error);
      }
    };

    fetchHandoffs();

    const interval = setInterval(fetchHandoffs, 30000);
    return () => clearInterval(interval);
  }, [isElectron, seconds]);

  return handoffs;
}
