/**
 * 历史视图的条件栏（状态 / 日期范围 / 关键词）
 *
 * 严重度 chips 留在页面上：活跃视图也在用同一组按钮，搬进来反而要在两个
 * 视图之间传条件。这里只放"只有历史视图才有"的维度。
 *
 * 只上报用户意图，不自己发查询：`onChange` 收到的是 patch，
 * "条件变了就回到第一页"这条规则由页面统一处理，避免漏掉某一维。
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { DateRangeFilter } from './DateRangeFilter';
import type { HistoryFilters, StatusFilter } from './historyFilters';

interface HistoryFilterBarProps {
  filters: HistoryFilters;
  /** 只传变化的字段，页面负责合并 + 重置分页 */
  onChange: (patch: Partial<HistoryFilters>) => void;
  rangeOpen: boolean;
  onRangeOpenChange: (open: boolean) => void;
}

/**
 * 历史视图的状态选项。
 *
 * 只有终态：`new` / `ongoing` 属活跃视图 —— 历史页的查询恒带 `terminalOnly`，
 * 后端会把这两类排除，因此这里列出「持续中」不仅多余，还会让用户选了之后
 * 永远得到空列表，误以为筛选坏了。
 */
const STATUS_OPTIONS: Array<{ key: StatusFilter; labelKey: string }> = [
  { key: 'all', labelKey: 'alerts:filter.status_all' },
  { key: 'resolved', labelKey: 'alerts:filter.status_resolved' },
  { key: 'false_positive', labelKey: 'alerts:filter.status_false_positive' },
];

/** 输入停顿多久才发起查询。太短会每敲一个字打一次 IPC + 全表 LIKE */
const KEYWORD_DEBOUNCE_MS = 300;

export function HistoryFilterBar({
  filters,
  onChange,
  rangeOpen,
  onRangeOpenChange,
}: HistoryFilterBarProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(filters.keyword);

  // 回调和 ref 转一层：父组件传内联函数也不会让下面的定时器反复重建
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  // 外部改动（切换视图重置等）时回填输入框
  useEffect(() => {
    setDraft(filters.keyword);
  }, [filters.keyword]);

  // 防抖提交。draft 与已生效值相等说明这次是外部回填，不要再提交一次
  useEffect(() => {
    if (draft === filters.keyword) return;
    const timer = setTimeout(() => changeRef.current({ keyword: draft }), KEYWORD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, filters.keyword]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {STATUS_OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange({ status: o.key })}
          className={cn(
            'rounded-full border px-3 py-1 text-xs transition-colors',
            filters.status === o.key
              ? 'border-accent-green bg-accent-green/10 text-accent-green'
              : 'border-border text-muted-foreground hover:bg-ink-800'
          )}
        >
          {t(o.labelKey)}
        </button>
      ))}

      <DateRangeFilter
        open={rangeOpen}
        onOpenChange={onRangeOpenChange}
        value={filters.range}
        onChange={(range) => onChange({ range })}
      />

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('alerts:filter.search_placeholder')}
          className="w-56 rounded-full border border-slate-700 bg-ink-900 py-1 pl-8 pr-8 text-xs outline-none transition-colors placeholder:text-slate-500 focus:border-accent-green/60"
        />
        {draft !== '' && (
          <button
            type="button"
            onClick={() => setDraft('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            title={t('alerts:filter.clear_keyword')}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}