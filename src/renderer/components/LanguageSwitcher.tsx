import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import {
  SUPPORTED_LANGUAGES,
  normalizeLanguage,
  type LanguageCode,
} from '../i18n';

export type LanguageSwitcherVariant =
  /** 侧栏 / 设置页：图标 + 完整语言名 */
  | 'full'
  /** 页面头部右上角：紧凑的完整语言名 */
  | 'label'
  /** 只要语言代码（空间极紧时用） */
  | 'code';

interface LanguageSwitcherProps {
  variant?: LanguageSwitcherVariant;
  className?: string;
}

/**
 * 全局语言切换器。
 *
 * 持久化由 `i18next-browser-languagedetector` 负责：它会把这个选择写进 localStorage
 * （键名见 `LANGUAGE_STORAGE_KEY`），刷新、重启应用都会沿用，不需要额外写存储逻辑。
 *
 * 挂在两处：
 * - 左侧栏底部（`variant='full'`）—— 全局常驻
 * - 各页面头部右上角（`variant='label'`）—— 需求指定的「右上角」位置
 */
export function LanguageSwitcher({ variant = 'full', className = '' }: LanguageSwitcherProps) {
  const { i18n, t } = useTranslation();

  const current = normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);

  const handleChange = (code: string) => {
    void i18n.changeLanguage(code as LanguageCode);
  };

  const showGlobe = variant === 'full';
  const showLabel = variant !== 'code';

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      {showGlobe && <Globe className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />}
      <select
        value={current}
        onChange={(e) => handleChange(e.target.value)}
        aria-label={t('common:language_switch')}
        title={t('common:language_switch')}
        className={
          variant === 'full'
            ? 'bg-ink-800 text-sm text-foreground border border-ink-700 rounded-md px-2 py-1.5 focus:outline-none focus:border-accent-green cursor-pointer'
            : variant === 'label'
              ? 'bg-ink-800/80 text-xs text-muted-foreground hover:text-foreground border border-ink-700 rounded-md px-2 py-1 focus:outline-none focus:border-accent-green cursor-pointer'
              : 'bg-transparent text-xs text-muted-foreground border border-ink-700 rounded px-1.5 py-1 focus:outline-none focus:border-accent-green cursor-pointer'
        }
      >
        {SUPPORTED_LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {showLabel ? lang.label : lang.code.split('-')[0].toUpperCase()}
          </option>
        ))}
      </select>
    </div>
  );
}

export default LanguageSwitcher;
