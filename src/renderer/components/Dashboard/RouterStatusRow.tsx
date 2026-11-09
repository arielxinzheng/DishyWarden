/**
 * 路由器状态行
 *
 * 需求文档 2.1.2「路由器状态监控」的数据出口。
 *
 * ## 为什么需要「探测可信度」提示
 *
 * 某些网络环境（VPN / 隧道 / 安全软件）会**应答所有 ICMP 请求** ——
 * 实测连 RFC 5737 保留地址 `192.0.2.1` 都能 ping 通。此时「可达 / 0% 丢包 /
 * RTT 0.3ms」全是环境造出来的假象。
 *
 * 所以主进程做了一次**基线自检**（ping 保留地址），结果通过 `trusted` 字段
 * 传过来。不可信时这里**如实标注**，而不是给用户一颗永远绿的假指示灯 ——
 * 监控软件宁可说「测不准」，也不能把环境造的数据当成设备实测值。
 *
 * 客户环境是星链终端的家庭网络，`192.168.100.1` 是局域网网关，
 * 正常情况下 ICMP 不会被篡改，自检会通过。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Router, Wifi, WifiOff, AlertTriangle } from 'lucide-react';
import type { RouterProbeResult } from '../../../core/routerProbeTypes';
import { isValidProbe } from './routerProbeShape';

export function RouterStatusRow() {
  const { t, i18n } = useTranslation();
  const [probe, setProbe] = useState<RouterProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        // 浏览器环境没有 electronAPI —— 不报错, 只是不显示
        if (typeof window === 'undefined' || !window.electronAPI?.getRouterProbe) return;
        const result = await window.electronAPI.getRouterProbe();
        if (!cancelled) {
          // ⚠️ **IPC 返回值的类型只在编译期存在, 运行时没人校验** ——
          //   `getRouterProbe()` 声明返回 `RouterProbeResult | null`,
          //   但那只是 TypeScript 的承诺。实际拿到的可能是
          //   `undefined`(handler 没返回)、`[]`(探针 stub 返回了别的形状),
          //   或是缺字段的对象。
          //
          //   之前直接 `setProbe(result)` 然后在渲染里
          //   `probe.rttMs !== null ? probe.rttMs.toFixed(2)` ——
          //   `undefined !== null` **为真** ⇒ 对 undefined 调 .toFixed()
          //   ⇒ TypeError ⇒ 整页被 ErrorBoundary 接管。
          //
          //   所以这里做**形状校验**, 不合格就当"没有数据"。
          setProbe(isValidProbe(result) ? result : null);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    };

    load();
    // 与采集周期对齐（30s）
    const timer = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // 没有数据时不占位 —— 显示一行「等待首次探测」, 不留空白
  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-warning-orange/30 bg-warning-orange/5 px-3 py-2 text-xs text-warning-orange">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        <span>{t('dashboard:router.probe_failed', { error })}</span>
      </div>
    );
  }

  if (!probe) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <Router className="w-3.5 h-3.5 shrink-0" />
        <span>{t('dashboard:router.waiting')}</span>
      </div>
    );
  }

  const trusted = probe.trusted !== false;
  const reachable = probe.reachable;

  return (
    <div className="rounded-md border border-border/50 bg-ink-800/40 px-3 py-2">
      {/* 第一行：可达性 + 地址 */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {reachable ? (
            <Wifi className="w-4 h-4 shrink-0 text-accent-green" />
          ) : (
            <WifiOff className="w-4 h-4 shrink-0 text-danger-red" />
          )}
          <span className="text-xs text-slate-300 truncate">
            {t('dashboard:router.title')}
            <span className="text-muted-foreground ml-1.5 font-mono">
              {/* ⚠️ 用 `!= null` 而不是 `!== null` ——
                  后者对 `undefined` 为真, 会对 undefined 调 .toFixed() 崩掉。
                  `isValidProbe` 已经挡住形状不对的值, 这里再兜一层数值。 */}
              {probe.rttMs != null && Number.isFinite(probe.rttMs)
                ? `RTT ${probe.rttMs.toFixed(2)}ms`
                : 'RTT —'}
            </span>
            <span className="text-muted-foreground ml-1.5">
              {t('dashboard:router.loss', {
                value: Number.isFinite(probe.packetLoss)
                  ? (probe.packetLoss * 100).toFixed(0)
                  : '0',
              })}
            </span>
          </span>
        </div>
        <span
          className={`text-xs font-medium shrink-0 ${
            reachable ? 'text-accent-green' : 'text-danger-red'
          }`}
        >
          {reachable ? t('dashboard:router.reachable') : t('dashboard:router.unreachable')}
        </span>
      </div>

      {/* 第二行：不可信警告 —— 必须显眼。
          ⚠️ 不直接展示主进程的 `trustNote`: 那是运行期生成的**中文**说明,
          切到其它语言不会变。这里用字典里的本地化说明。 */}
      {!trusted && (
        <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-warning-orange leading-relaxed">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
          <span>{t('dashboard:router.untrusted_note')}</span>
        </div>
      )}

      {/* 第三行：采集时刻 */}
      {probe.timestamp && (
        <div className="mt-1 text-[10px] text-muted-foreground font-mono">
          {t('dashboard:router.collected_at', {
            time: new Date(probe.timestamp).toLocaleTimeString(i18n.language, { hour12: false }),
          })}
          {/* ⚠️ 同样用 `!= null` —— `httpOk` 未定义时不应显示 HTTP 行 */}
          {probe.httpOk != null && (
            <span className="ml-2">
              HTTP {probe.httpOk ? t('dashboard:router.http_ok') : t('dashboard:router.http_error')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
