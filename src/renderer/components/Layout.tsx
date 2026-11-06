import { Outlet, Link, useLocation } from 'react-router-dom';
import { Activity, Compass, Radio, Satellite, Bell, Settings } from 'lucide-react';
import { cn } from '../lib/utils';

const navItems = [
  { path: '/', icon: Activity, label: '仪表盘' },
  { path: '/obstruction', icon: Radio, label: '障碍图' },
  { path: '/alignment', icon: Compass, label: '校准' },
  { path: '/satellites', icon: Satellite, label: '卫星雷达' },
  { path: '/alerts', icon: Bell, label: '告警' },
  { path: '/settings', icon: Settings, label: '设置' },
];

export default function Layout() {
  const location = useLocation();

  return (
    <div className="flex h-screen bg-ink-950 text-foreground dark">
      {/* 侧边栏导航 */}
      <nav className="w-64 bg-ink-900 border-r border-ink-700 p-4 flex flex-col">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-accent-green">DishyWarden</h1>
          <p className="text-sm text-muted-foreground">星链监控</p>
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
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="pt-4 border-t border-ink-700 text-xs text-muted-foreground">
          <p>版本 0.1.0</p>
          <p className="mt-1">© 2026 DishyWarden</p>
        </div>
      </nav>

      {/* 主内容区 */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}