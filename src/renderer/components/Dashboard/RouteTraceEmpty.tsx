/**
 * 路由跟踪卡的空态（0 跳）。
 *
 * 单独抽出来是为了**可测**：用户两次反馈"无法获取路由信息、没有原因"，
 * 要能用测试证明 —— 主进程带回的 error 确实会出现在界面上。
 *
 * 主进程约定（src/core/traceroute.ts）：hops 为空时**必带** error。
 * 万一 error 缺失（旧版主进程 / 异常路径），也给一句明确的兜底，
 * 不能让用户只看到「无法获取路由信息」。
 *
 * 失败原因只是"挑出来的一行"，挑错了用户就无从判断（第 3 轮：只显示了
 * 「到 example.com [...] 的路由:」）⇒ 原始输出 raw 一并折叠展示。
 */
export function RouteTraceEmpty({
  error,
  raw,
  t,
}: {
  error?: string;
  raw?: string;
  t: (key: string) => string;
}) {
  const reason = error?.trim() || t('dashboard:route.reason_unknown');
  const rawText = raw?.trim();
  return (
    <div className="text-xs text-slate-400 py-8 text-center space-y-1">
      <div>{t('dashboard:route.no_info')}</div>
      <div
        className="text-[11px] text-warning-orange/80 break-words"
        data-testid="route-failed-reason"
      >
        {t('dashboard:route.failed_reason')}: {reason}
      </div>
      <details className="text-left mx-auto max-w-full" data-testid="route-raw-output">
        <summary className="cursor-pointer text-[11px] text-slate-500 text-center select-none">
          {t('dashboard:route.raw_output')}
        </summary>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-900/60 p-2 text-[10px] leading-snug text-slate-300 font-mono select-text">
          {rawText || t('dashboard:route.raw_empty')}
        </pre>
      </details>
    </div>
  );
}
