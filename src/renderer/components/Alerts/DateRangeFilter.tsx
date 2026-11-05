/**
 * 日期范围筛选器
 *
 * 它是一个「覆盖层」而不是补充条件：选定了具体区间就不再受默认 7 天窗口
 * 约束，清空后自动回到 7 天。这个语义由父组件的查询构造决定，本组件只负责
 * 收集区间 —— 不猜测默认值，也不自己调接口。
 *
 * open 受控：列表底部的「查看更早以前的记录」需要能把面板唤起来，
 * 状态若藏在组件内部就没有这个入口。
 */

import { useEffect, useRef, useState } from 'react';
import { Calendar, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { monthDayOf, type YmdRange } from './historyWindow';

interface DateRangeFilterProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: YmdRange | null;
  onChange: (value: YmdRange | null) => void;
}

/** `2026-10-01 ~ 2026-10-03` → `10月1日 - 10月3日` */
const describeRange = (range: YmdRange): string => {
  const fmt = (ymd: string) => (ymd ? monthDayOf(ymd) : '');
  return `${fmt(range.from)} - ${fmt(range.to)}`;
};

export function DateRangeFilter({ open, onOpenChange, value, onChange }: DateRangeFilterProps) {
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // 回调用 ref 转一层：父组件传内联函数也不会让下面的 document 监听反复重绑
  const closeRef = useRef(onOpenChange);
  closeRef.current = onOpenChange;

  // 打开时从当前值重建草稿：用户点开面板看到的是已生效的区间，而不是上次的半成品
  useEffect(() => {
    if (!open) return;
    setDraftFrom(value?.from ?? '');
    setDraftTo(value?.to ?? '');
  }, [open, value?.from, value?.to]);

  // 点外部收起。用 mousedown + contains 判断，而不是给触发按钮 stopPropagation ——
  // 后者在面板内部点日期时仍会冒泡到 document，把面板关掉。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closeRef.current(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const draftValid =
    draftFrom !== '' && draftTo !== '' && draftFrom <= draftTo; // YYYY-MM-DD 字典序即日期序

  const apply = () => {
    if (!draftValid) return;
    onChange({ from: draftFrom, to: draftTo });
    onOpenChange(false);
  };

  const clear = () => {
    setDraftFrom('');
    setDraftTo('');
    onChange(null);
    onOpenChange(false);
  };

  const active = value !== null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
          active || open
            ? 'border-accent-green bg-accent-green/10 text-accent-green'
            : 'border-border text-muted-foreground hover:bg-ink-800'
        )}
      >
        <Calendar className="h-3 w-3 shrink-0" />
        {value ? describeRange(value) : '日期范围'}
        {value && <X className="h-3 w-3 shrink-0 opacity-60" />}
      </button>

      {open && (
        // bg-background 是死类（@theme 里没有 --color-background），
        // 必须用实际的 ink 色，否则浮层透明、下面卡片的文字会透上来
        <div className="absolute left-0 top-full z-30 mt-2 w-72 rounded-lg border border-slate-700 bg-ink-900 p-3 shadow-xl">
          <div className="space-y-2">
            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">起始日期</span>
              <input
                type="date"
                value={draftFrom}
                max={draftTo || undefined}
                onChange={(e) => setDraftFrom(e.target.value)}
                className="w-full rounded-md border border-slate-700 bg-ink-800 px-2 py-1.5 text-sm [color-scheme:dark]"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">结束日期</span>
              <input
                type="date"
                value={draftTo}
                min={draftFrom || undefined}
                onChange={(e) => setDraftTo(e.target.value)}
                className="w-full rounded-md border border-slate-700 bg-ink-800 px-2 py-1.5 text-sm [color-scheme:dark]"
              />
            </label>
          </div>

          <p className="mt-2 text-xs text-slate-500">
            {draftFrom && draftTo && draftFrom > draftTo
              ? '起始日期不能晚于结束日期'
              : '选定后覆盖默认的最近 7 天'}
          </p>

          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={clear}
              disabled={!active && !draftFrom && !draftTo}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            >
              清除范围
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={!draftValid}
              className="rounded-md border border-accent-green/50 bg-accent-green/10 px-3 py-1 text-xs text-accent-green transition-colors hover:bg-accent-green/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              应用
            </button>
          </div>
        </div>
      )}
    </div>
  );
}