/**
 * Drawer 抽屉组件
 * 从屏幕右侧滑入的侧边栏
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  width?: 'sm' | 'md' | 'lg'; // sm=1/3, md=1/2, lg=2/3
}

const widthClasses = {
  sm: 'w-full md:w-1/3',
  md: 'w-full md:w-1/2',
  lg: 'w-full md:w-2/3',
};

export function Drawer({ open, onClose, children, title, width = 'md' }: DrawerProps) {
  // 关闭按钮的无障碍标签走 common 命名空间，切语言时不会残留中文
  const { t } = useTranslation();
  // ESC 键关闭
  useEffect(() => {
    if (!open) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, onClose]);

  // 禁止背景滚动
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/* 蒙版 */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 transition-opacity duration-300"
        onClick={onClose}
        style={{ animation: 'fadeIn 0.3s ease-out' }}
      />

      {/* 抽屉主体 */}
      <div
        className={`fixed top-0 right-0 h-full ${widthClasses[width]} bg-background border-l border-border shadow-2xl z-50 flex flex-col`}
        style={{ animation: 'slideInRight 0.3s ease-out' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border shrink-0">
          {title && <h2 className="text-xl font-semibold">{title}</h2>}
          {!title && <div />}
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-muted transition-colors"
            aria-label={t('common:close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content - 独立滚动区域 */}
        <div className="flex-1 overflow-y-auto p-6">
          {children}
        </div>
      </div>

      {/* CSS 动画 */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideInRight {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>
    </>
  );
}