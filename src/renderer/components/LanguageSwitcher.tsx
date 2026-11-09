import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import {
  SUPPORTED_LANGUAGES,
  normalizeLanguage,
  type LanguageCode,
} from '../i18n';

interface LanguageSwitcherProps {
  /** 紧凑模式：只显示图标 + 语言码（放在窄侧栏或工具栏里用） */
  compact?: boolean;
  className?: string;
}

/**
 * 全局语言切换器。
 *
 * 持久化由 `i18next-browser-languagedetector` 负责：它会把这个选择写进 localStorage
 * （键名见 `LANGUAGE_STORAGE_KEY`），刷新、重启应用都会沿用，不需要额外写存储逻辑。
 */
export function LanguageSwitcher({ compact = false, className = '' }: LanguageSwitcherProps) {
  const { i18n, t } = useTranslation();

  const current = normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);

  const handleChange = (code: string) => {
    void i18n.changeLanguage(code as LanguageCode);
  };

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <Globe className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
      <select
        value={current}
        onChange={(e) => handleChange(e.target.value)}
        aria-label={t('common:language_switch')}
        title={t('common:language_switch')}
        className={
          compact
            ? 'bg-transparent text-xs text-muted-foreground border border-ink-700 rounded px-1.5 py-1 focus:outline-none focus:border-accent-green cursor-pointer'
            : 'bg-ink-800 text-sm text-foreground border border-ink-700 rounded-md px-2 py-1.5 focus:outline-none focus:border-accent-green cursor-pointer'
        }
      >
        {SUPPORTED_LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {compact ? lang.code.split('-')[0].toUpperCase() : lang.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default LanguageSwitcher;
