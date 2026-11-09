import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Globe } from 'lucide-react';
import {
  SUPPORTED_LANGUAGES,
  normalizeLanguage,
  type LanguageCode,
} from '../i18n';

export type LanguageSwitcherVariant =
  /** 只显示 🌐 图标 —— 用在页面头部右上角，省出横向空间 */
  | 'icon'
  /** 图标 + 当前语言名 —— 用在侧栏、设置页 */
  | 'label';

interface LanguageSwitcherProps {
  variant?: LanguageSwitcherVariant;
  className?: string;
}

/**
 * 全局语言切换器：🌐 图标按钮 + 悬浮/点击展开的下拉菜单。
 *
 * ## 为什么不用原生 `<select>`
 *
 * 原生下拉在多语言下宽度不可控（`简体中文` / `Tiếng Việt` 长度差很多），
 * 在顶部操作栏里很容易把布局撑破；而且它是**点击才展开**，没法做到 hover 预览。
 * 这里改成图标按钮 + 自绘菜单：宽度固定、hover 即开、点击可固定。
 *
 * ## 持久化
 *
 * 由 `i18next-browser-languagedetector` 负责：用户选择会写进 localStorage 的
 * `i18nextLng`（插件默认键），刷新/重启都保留，且**优先级高于浏览器语言**。
 */
export function LanguageSwitcher({ variant = 'icon', className = '' }: LanguageSwitcherProps) {
  const { i18n, t } = useTranslation();
  const [pinned, setPinned] = useState(false);   // 点击固定展开
  const [hovered, setHovered] = useState(false);  // 悬浮展开
  const wrapperRef = useRef<HTMLDivElement>(null);

  const current = normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);
  const currentLabel =
    SUPPORTED_LANGUAGES.find((l) => l.code === current)?.label ?? current;

  // 点击别处关闭
  useEffect(() => {
    if (!pinned) return;
    const onPointerDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setPinned(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [pinned]);

  // Esc 关闭（hover 打开的也要关 —— 键盘用户不该被鼠标状态困住）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPinned(false);
        setHovered(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const open = pinned || hovered;

  const choose = (code: LanguageCode) => {
    void i18n.changeLanguage(code);
    setPinned(false);
    setHovered(false);
  };

  return (
    <div
      ref={wrapperRef}
      className={`relative ${className}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={() => setPinned((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('common:language_switch')}
        title={t('common:language_switch')}
        className={
          variant === 'label'
            ? 'flex items-center gap-2 rounded-md border border-ink-700 bg-ink-800 px-2.5 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:border-accent-green/60 transition-colors focus:outline-none focus:border-accent-green'
            : 'flex items-center justify-center w-8 h-8 rounded-md border border-ink-700 bg-ink-800/80 text-muted-foreground hover:text-foreground hover:border-accent-green/60 transition-colors focus:outline-none focus:border-accent-green'
        }
      >
        <Globe className="w-4 h-4" aria-hidden="true" />
        {variant === 'label' && <span className="whitespace-nowrap">{currentLabel}</span>}
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t('common:language_switch')}
          className="absolute right-0 top-full z-50 mt-1.5 min-w-[9.5rem] rounded-lg border border-ink-700 bg-ink-900 py-1 shadow-2xl"
        >
          {SUPPORTED_LANGUAGES.map((lang) => {
            const active = lang.code === current;
            return (
              <button
                key={lang.code}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => choose(lang.code)}
                className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm transition-colors hover:bg-ink-800 ${
                  active ? 'text-accent-green' : 'text-foreground'
                }`}
              >
                <span className="whitespace-nowrap">{lang.label}</span>
                {active && <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default LanguageSwitcher;
