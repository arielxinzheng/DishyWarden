/**
 * 告警本地化层测试。
 *
 * 重点覆盖【摘要的插值】：主进程把中文摘要写进数据库，渲染层要用字典里的
 * 模板重新组句，并把证据里的数值插进模板。
 *
 * ⚠️ 曾经的 bug：localizeAlert 先 `t('alerts:types.X.summary')` 得到**已翻译的字符串**，
 * 再把它当作**键**传给第二次 `t()` —— 键不存在，而 parseMissingKeyHandler 返回空串，
 * 结果摘要整个是空的（所有告警类型都中招）。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import i18next from 'i18next';
import fs from 'node:fs';
import path from 'node:path';
import { localizeAlert, buildAlertParams } from './alertMessage';
import type { TFunction } from 'i18next';

/**
 * 用**独立的 i18next 实例** + 真实字典文件来测。
 *
 * 不复用应用里的 i18n 实例：它的初始化依赖浏览器环境（detector 要读
 * window.localStorage），在 node 测试环境里会一直等 —— 而本用例要测的
 * 只是「给一组字典 + 一个 t()，能不能正确组句」，与初始化机制无关。
 */
const dict = (lng: string, ns: string) =>
  JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', '..', 'locales', lng, `${ns}.json`), 'utf-8'),
  );

let t: TFunction;

const alert = (over: Partial<Record<string, any>> = {}) => ({
  alert_type: 'high_packet_loss',
  severity: 'warning',
  status: 'ongoing',
  summary: '丢包率 12%',
  description: '数据库里的中文原文',
  evidence: JSON.stringify({ pop_drop_rate: 0.12 }),
  recommendations: JSON.stringify(['数据库里的建议']),
  ...over,
}) as any;

describe('告警本地化', () => {
  beforeAll(async () => {
    const inst = i18next.createInstance();
    await inst.init({
      lng: 'zh-CN',
      fallbackLng: 'en',
      resources: {
        'zh-CN': { alerts: dict('zh-CN', 'alerts'), common: dict('zh-CN', 'common') },
        en: { alerts: dict('en', 'alerts'), common: dict('en', 'common') },
      },
      interpolation: { escapeValue: false },
      // ⚠️ 必须和应用里的配置一致：应用用 parseMissingKeyHandler 返回空串，
      // 保证「缺词不暴露键名」。不配这一项，测试就测不到真实的兜底行为。
      parseMissingKeyHandler: () => '',
    });
    t = inst.t.bind(inst) as unknown as TFunction;
  });

  it('摘要按字典模板插值，不残留 {{占位符}}', () => {
    const out = localizeAlert(alert(), t);
    expect(out.summary).toContain('12');
    expect(out.summary).not.toContain('{{');
    expect(out.summary).not.toContain('rate');
  });

  it('标题走字典，不回退到 alert_type', () => {
    const out = localizeAlert(alert(), t);
    expect(out.title).toBe('严重丢包');
    expect(out.title).not.toBe('high_packet_loss');
  });

  it('探针类告警：摘要里带节点 id 与底层错误码', () => {
    const out = localizeAlert(
      alert({
        alert_type: 'probe_source_unavailable',
        summary: '数据源不可用（探针目标不可达）',
        evidence: JSON.stringify({
          node_id: 'dns-dual-check',
          failure_mode: 'unreachable',
          error: 'ECONNREFUSED',
        }),
      }),
      t,
    );
    expect(out.title).toBe('数据源不可用');
    expect(out.summary).toContain('dns-dual-check');
    expect(out.summary).toContain('ECONNREFUSED');
    expect(out.summary).not.toContain('{{');
  });

  it('dns_failure 按归因分支取文案（不是数据库原文）', () => {
    const out = localizeAlert(
      alert({
        alert_type: 'dns_failure',
        summary: '⚠️ 网页无法加载 (域名解析失败)',
        evidence: JSON.stringify({
          user_dns: { ok: false, rtt_ms: null },
          baseline_dns: { ok: true, rtt_ms: 3 },
        }),
      }),
      t,
    );
    // 用户态坏 / 基准态好 ⇒ "本地 DNS 配置问题"那一支
    expect(out.summary).not.toContain('⚠️ 网页无法加载');
    expect(out.summary).not.toContain('{{');
    expect(out.summary.length).toBeGreaterThan(0);
  });

  it('建议处理走字典（数组形式）', () => {
    const out = localizeAlert(alert(), t);
    expect(Array.isArray(out.recommendations)).toBe(true);
    expect(out.recommendations.length).toBeGreaterThan(0);
    expect(out.recommendations[0]).not.toContain('数据库里的建议');
  });

  it('字典里没有的新类型：退回数据库原文，页面不空白', () => {
    const out = localizeAlert(
      alert({ alert_type: 'brand_new_type', summary: '数据库里的原文摘要' }),
      t,
    );
    expect(out.summary).toBe('数据库里的原文摘要');
    expect(out.title).toBe('brand_new_type');
  });

  it('buildAlertParams 把探针证据归一化成模板变量', () => {
    const p = buildAlertParams({ node_id: 'dns-dual-check', error: 'ECONNREFUSED' });
    expect(p.node).toBe('dns-dual-check');
    expect(p.errcode).toBe('ECONNREFUSED');
  });
});
