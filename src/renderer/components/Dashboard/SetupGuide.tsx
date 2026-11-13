/**
 * 设备连接引导页 (Setup/Onboarding) —— 场景 A 的全屏拦截渲染
 *
 * ## 何时出现
 *
 * 首次安装且初始 gRPC 连接失败（判定见 firstInstall.ts）。此时向用户
 * 展示一个全 0 的「残疾仪表盘」只会让人困惑 —— 用户心智是「我在搭环境,
 * 是不是哪里配错了」, 该看到的是排查表单, 不是空图表。
 *
 * ## 结构（自上而下）
 *
 *   1. 雷达扫描动画 + 「正在寻找 Starlink 设备...」
 *      重试进行中转圈, 失败后停住并显示具体错误
 *   2. 排查清单（可交互勾选, 纯 UI 记忆, 不落盘 —— 这是引导不是配置表单）
 *   3. 当前连接目标展示 + [重试连接] 按钮
 *   4. 底部固定提示: 设备地址在设置页可改
 *
 * ## 不可见元素
 *
 * 本页出现期间 Dashboard 在横幅渲染之前 return, 因此
 * 活跃告警横幅 / 数据陈旧横幅 / 刚恢复卡片都**不会渲染** ——
 * 系统还没跑起来, 没有告警概念。
 *
 * ## 注意
 *
 * 排查项勾选状态放在组件内 useState, 故意不持久化:
 * 「检查过了」只在本次引导里作提示用, 重启后应该重新检查。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WifiOff, Radar, RefreshCw, CheckCircle2, Circle, Settings } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface SetupGuideProps {
  /** 具体错误信息(超时/ECONNREFUSED 等), 来自 useDish.error */
  error: string | null;
  /** 重试中(控制按钮禁用与雷达动画文案) */
  isRetrying: boolean;
  /** 当前尝试连接的地址, 形如 192.168.100.1:9200 */
  connectTarget: string;
  /** 点击重试 */
  onRetry: () => void;
  /** 跳转设置页改地址 */
  onOpenSettings: () => void;
}

/**
 * 排查清单条目 —— 文案对齐用户手册常见安装问题。
 *
 * 只存**字典键**, 不存文案: 本模块在中文/英文界面都复用同一份清单,
 * `{{target}}` 由渲染时插值。
 */
const CHECKLIST: { key: string; labelKey: string; hintKey: string }[] = [
  {
    key: 'power',
    labelKey: 'setup.item_power',
    hintKey: 'setup.item_power_hint',
  },
  {
    key: 'network',
    labelKey: 'setup.item_network',
    hintKey: 'setup.item_network_hint',
  },
  {
    key: 'ip',
    labelKey: 'setup.item_ip',
    hintKey: 'setup.item_ip_hint',
  },
  {
    key: 'firewall',
    labelKey: 'setup.item_firewall',
    hintKey: 'setup.item_firewall_hint',
  },
];

export default function SetupGuide({
  error,
  isRetrying,
  connectTarget,
  onRetry,
  onOpenSettings,
}: SetupGuideProps) {
  const { t } = useTranslation();
  // 排查清单勾选状态 —— 纯 UI 记忆, 引导结束即失效
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  const checklist = CHECKLIST.map((item) => ({
    ...item,
    label: t(`dashboard:${item.labelKey}`),
    hint: t(`dashboard:${item.hintKey}`, { target: connectTarget }),
  }));
  const doneCount = checklist.filter((i) => checked[i.key]).length;

  return (
    <div className="min-h-full flex flex-col items-center justify-center px-6 py-10 bg-ink-950">
      {/* 1. 雷达扫描 + 主文案 */}
      <div className="flex flex-col items-center mb-10">
        {/* 同心圆雷达, 失败后停止扫描并把外圈变红 */}
        <div className="relative w-40 h-40 mb-6" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className={cn(
                'absolute inset-0 m-auto rounded-full border',
                isRetrying ? 'animate-pulse border-accent-green/40' : 'border-danger-red/50'
              )}
              style={{
                width: `${100 - i * 30}%`,
                height: `${100 - i * 30}%`,
                animationDelay: `${i * 250}ms`,
              }}
            />
          ))}
          {/* 扫描臂: 重试中才旋转; 失败后隐藏, 换成中心感叹图标 */}
          {isRetrying ? (
            <div
              className="absolute inset-0 m-auto w-1/2 h-1/2"
              style={{ animation: 'radar-sweep 2.4s linear infinite', transformOrigin: 'bottom left' }}
            >
              <div
                className="w-full h-full"
                style={{
                  background:
                    'conic-gradient(from 0deg, rgba(74,222,128,0.35), transparent 60deg)',
                  borderRadius: '100% 0 0 0',
                }}
              />
            </div>
          ) : (
            <WifiOff className="absolute inset-0 m-auto h-10 w-10 text-danger-red" />
          )}
        </div>

        <h2 className="text-xl font-semibold text-foreground">
          {isRetrying ? t('dashboard:setup.finding') : t('dashboard:setup.not_found')}
        </h2>
        {error && !isRetrying && (
          <p className="mt-2 text-sm text-danger-red max-w-md text-center">{error}</p>
        )}
      </div>

      {/* 2. 排查表单 */}
      <div className="w-full max-w-lg bg-ink-900 border border-ink-700 rounded-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-semibold text-foreground">
            {t('dashboard:setup.checklist_title')}
          </p>
          <span className="text-xs text-muted-foreground">
            {t('dashboard:setup.checklist_progress', {
              done: doneCount,
              total: checklist.length,
            })}
          </span>
        </div>
        <ul className="space-y-3">
          {checklist.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                onClick={() => setChecked((prev) => ({ ...prev, [item.key]: !prev[item.key] }))}
                className={cn(
                  'w-full flex items-start gap-3 text-left px-3 py-2 rounded-md transition-colors',
                  checked[item.key] ? 'bg-accent-green/5' : 'hover:bg-ink-800'
                )}
                aria-pressed={!!checked[item.key]}
              >
                {checked[item.key] ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5 text-accent-green" />
                ) : (
                  <Circle className="h-5 w-5 shrink-0 mt-0.5 text-muted-foreground" />
                )}
                <div>
                  <p
                    className={cn(
                      'text-sm',
                      checked[item.key] ? 'text-muted-foreground line-through' : 'text-foreground'
                    )}
                  >
                    {item.label}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">{item.hint}</p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* 3. 重试 + 当前目标 */}
      <div className="mt-8 flex flex-col items-center gap-3">
        <button
          onClick={onRetry}
          disabled={isRetrying}
          className={cn(
            'px-6 py-2.5 rounded-md font-medium transition-colors',
            'flex items-center gap-2',
            isRetrying
              ? 'bg-ink-800 text-muted-foreground cursor-not-allowed'
              : 'bg-accent-green/20 text-accent-green hover:bg-accent-green/30'
          )}
        >
          <RefreshCw className={cn('h-4 w-4', isRetrying && 'animate-spin')} />
          {isRetrying ? t('dashboard:setup.retrying') : t('dashboard:setup.retry')}
        </button>
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Radar className="h-3.5 w-3.5" />
          {t('dashboard:setup.target', { target: connectTarget })}
        </p>
      </div>

      {/* 4. 设置入口 */}
      <button
        onClick={onOpenSettings}
        className="mt-6 text-sm text-accent-green/80 hover:text-accent-green underline underline-offset-4 flex items-center gap-1.5"
      >
        <Settings className="h-4 w-4" />
        {t('dashboard:setup.open_settings')}
      </button>

      {/* 雷达扫描臂的 keyframes —— Tailwind 没有内置 conic 扫描, 手写注入 */}
      <style>{`
        @keyframes radar-sweep {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
