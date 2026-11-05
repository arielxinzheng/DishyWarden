/**
 * 告警降噪菜单组件
 * 提供忽略选项: 1小时/24小时/本次/误报
 */

import { useState } from 'react';
import { BellOff, AlertOctagon, Clock } from 'lucide-react';

interface AlertSnoozeMenuProps {
  onSnooze: (type: 'temporary' | 'until_resolved', durationMs?: number) => Promise<void>;
  onMarkFalsePositive: () => Promise<void>;
  onClose: () => void;
}

export function AlertSnoozeMenu({ onSnooze, onMarkFalsePositive, onClose }: AlertSnoozeMenuProps) {
  const [loading, setLoading] = useState(false);

  const handleSnooze = async (type: 'temporary' | 'until_resolved', durationMs?: number) => {
    setLoading(true);
    try {
      await onSnooze(type, durationMs);
      onClose();
    } finally {
      setLoading(false);
    }
  };

  const handleFalsePositive = async () => {
    setLoading(true);
    try {
      await onMarkFalsePositive();
      onClose();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div 
      className="absolute right-0 top-full mt-2 w-64 rounded-lg border border-border bg-background shadow-xl z-50 overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="p-2 space-y-1">
        {/* 忽略 1 小时 */}
        <button
          onClick={() => handleSnooze('temporary', 60 * 60 * 1000)}
          disabled={loading}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm text-left hover:bg-muted transition-colors disabled:opacity-50"
        >
          <Clock className="w-4 h-4 text-sky-blue shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-foreground">忽略 1 小时</div>
            <div className="text-xs text-muted-foreground">临时屏蔽此告警</div>
          </div>
        </button>

        {/* 忽略 24 小时 */}
        <button
          onClick={() => handleSnooze('temporary', 24 * 60 * 60 * 1000)}
          disabled={loading}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm text-left hover:bg-muted transition-colors disabled:opacity-50"
        >
          <Clock className="w-4 h-4 text-warning-orange shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-foreground">忽略 24 小时</div>
            <div className="text-xs text-muted-foreground">延后处理</div>
          </div>
        </button>

        {/* 分隔线 */}
        <div className="h-px bg-border my-1" />

        {/* 忽略本次 */}
        <button
          onClick={() => handleSnooze('until_resolved')}
          disabled={loading}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm text-left hover:bg-muted transition-colors disabled:opacity-50"
        >
          <BellOff className="w-4 h-4 text-slate-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-foreground">忽略本次异常</div>
            <div className="text-xs text-muted-foreground">直到网络恢复</div>
          </div>
        </button>

        {/* 分隔线 */}
        <div className="h-px bg-border my-1" />

        {/* 标记误报 */}
        <button
          onClick={handleFalsePositive}
          disabled={loading}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm text-left hover:bg-danger-red/10 hover:text-danger-red transition-colors disabled:opacity-50"
        >
          <AlertOctagon className="w-4 h-4 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium">这是一个误报</div>
            <div className="text-xs opacity-70">反馈给我们</div>
          </div>
        </button>
      </div>
    </div>
  );
}