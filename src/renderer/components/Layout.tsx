import { Outlet, Link, useLocation } from 'react-router-dom';
import { Activity, Compass, Radio, Satellite, Bell, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/utils';
import { LanguageSwitcher } from './LanguageSwitcher';

/** 导航项只存「路径 + 图标 + 翻译键」，文案一律由 i18n 提供 */
const navItems = [
  { path: '/', icon: Activity, labelKey: 'layout:nav_dashboard' },
  { path: '/obstruction', icon: Radio, labelKey: 'layout:nav_obstruction' },
  { path: '/alignment', icon: Compass, labelKey: 'layout:nav_alignment' },
  { path: '/satellites', icon: Satellite, labelKey: 'layout:nav_satellites' },
  { path: '/alerts', icon: Bell, labelKey: 'layout:nav_alerts' },
  { path: '/settings', icon: Settings, labelKey: 'layout:nav_settings' },
];

export default function Layout() {
  const location = useLocation();
  const { t } = useTranslation();

  return (
    <div className="flex h-screen bg-ink-950 text-foreground dark">
      {/* 侧边栏导航 */}
      <nav className="w-64 bg-ink-900 border-r border-ink-700 p-4 flex flex-col">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-accent-green">DishyWarden</h1>
          <p className="text-sm text-muted-foreground">{t('layout:subtitle')}</p>
        </div>

        <ul className="space-y-1 flex-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = location.pathname === item.path;

            return (
              <li key={item.path}>
                <Link
                  to={item.path}
                  className={cn(
                    'flex items-center gap-3 px-4 py-2.5 rounded-md transition-colors',
                    isActive
                      ? 'bg-accent-green/10 text-accent-green'
                      : 'text-muted-foreground hover:bg-ink-800 hover:text-foreground'
                  )}
                >
                  <Icon className="w-5 h-5" />
                  <span>{t(item.labelKey)}</span>
                </Link>
              </li>
            );
          })}
        </ul>

        {/* 语言切换器：全局可达，结果持久化到 localStorage */}
        <div className="pt-4 pb-3 border-t border-ink-700">
          <LanguageSwitcher variant="label" className="w-full justify-between" />
        </div>

        <div className="pt-3 border-t border-ink-700 text-xs text-muted-foreground">
          <p>{t('common:version', { version: '0.1.0' })}</p>
          <p className="mt-1">{t('common:copyright')}</p>
        </div>
      </nav>

      {/* 主内容区 */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
