/**
 * 「✅ 已对齐」浮层。
 *
 * 只在**刚进入**对齐状态的那一刻弹一次，3.2 秒后自动收起。
 * 一直挂着会变成页面装饰，用户第二次看就不再读它了 —— 正反馈的价值
 * 全在「变化的那一瞬间」。
 *
 * 副作用全部锁在这里，页面本身保持无状态渲染。
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface AlignmentFlashProps {
  aligned: boolean;
}

/** 浮层停留时长（ms） */
const FLASH_DURATION_MS = 3200;

export function AlignmentFlash({ aligned }: AlignmentFlashProps) {
  const { t } = useTranslation('alignment');
  const [visible, setVisible] = useState(false);
  // 用 ref 而不是 state 记录「上一次是否已对齐」：它只用于比较，不参与渲染
  const wasAligned = useRef(false);

  useEffect(() => {
    if (!aligned) {
      wasAligned.current = false;
      setVisible(false);
      return;
    }

    // 首次进入（含页面加载时就已对齐）也要弹一次
    if (wasAligned.current) return;

    wasAligned.current = true;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), FLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [aligned]);

  return (
    <div
      aria-live="polite"
      // 位置：由页面摆在标题行右侧（flex 兄弟节点），**永远不覆盖任何内容**。
      // 之前用 fixed 顶部/底部居中都试过：要么压住 h1，要么盖住下方说明卡。
      // 隐藏时仍占位（opacity 0），标题不会因为它的出现/消失而跳动。
      className={`shrink-0 transition-all duration-300 ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2 pointer-events-none'
      }`}
    >
      <div className="flex items-center gap-2 px-5 py-3 rounded-xl border border-green-500/60 bg-green-500/15 backdrop-blur-sm shadow-lg shadow-green-900/30">
        <span className="text-lg">✅</span>
        <span className="text-sm font-semibold text-green-400">{t('alignment:flash.aligned')}</span>
        <span className="text-xs text-green-300/70">{t('alignment:flash.detail')}</span>
      </div>
    </div>
  );
}
