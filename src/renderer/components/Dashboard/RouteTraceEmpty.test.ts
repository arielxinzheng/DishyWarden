/**
 * 路由跟踪空态：证明主进程带回的失败原因**确实显示在界面上**。
 *
 * 链路：traceroute()（主进程）→ ipcMain.handle('run-traceroute') 直接 return →
 * ipcRenderer.invoke（结构化克隆，字符串字段原样保留）→ RouteTraceCard
 * setData(result) 整体替换 → data.hops.length === 0 ⇒ <RouteTraceEmpty error={data.error} />。
 *
 * 这里用 structuredClone 模拟 IPC 的序列化，用 renderToStaticMarkup 渲染组件。
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RouteTraceEmpty } from './RouteTraceEmpty';

const t = (k: string) =>
  ({
    'dashboard:route.no_info': '无法获取路由信息',
    'dashboard:route.failed_reason': '失败原因',
    'dashboard:route.reason_unknown': '未知（命令无输出）',
  })[k] ?? k;

describe('RouteTraceEmpty', () => {
  it('IPC 返回的 error 原样出现在空态 HTML 里', () => {
    // 与 src/core/traceroute.ts 对 "Unable to resolve" 场景的实际返回同形
    const ipcResult = structuredClone({
      target: 'nosuch.invalid',
      hops: [],
      completed: false,
      duration: 12,
      error: 'Unable to resolve target system name nosuch.invalid.',
    });
    const html = renderToStaticMarkup(createElement(RouteTraceEmpty, { error: ipcResult.error, t }));
    expect(html).toContain('无法获取路由信息');
    expect(html).toContain('失败原因: Unable to resolve target system name nosuch.invalid.');
  });

  it('error 缺失（旧主进程）⇒ 也显示兜底原因，不留白', () => {
    const html = renderToStaticMarkup(createElement(RouteTraceEmpty, { t }));
    expect(html).toContain('失败原因: 未知（命令无输出）');
  });
});
