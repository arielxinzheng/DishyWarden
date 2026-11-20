import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * i18n 字典完整性校验。
 *
 * ## 为什么需要它
 *
 * i18next 的键是**运行期字符串**，TypeScript 完全管不到 —— 拼错一个键、
 * 或者新增文案忘了补某个语言，`tsc` 一声不吭，要等用户切到日文才看到空白。
 * 这次国际化改造涉及几十个文件、上千条文案，靠人眼逐条核对不现实，
 * 所以把「源码里出现的键」和「字典里存在的键」做一次机械对账。
 *
 * ## 校验内容
 *
 * 1. 5 种语言的键集合**完全一致**（谁都不能漏翻一条）
 * 2. 源码里出现的每个键，在每种语言里都存在（否则会 fallback / 空白）
 * 3. 字典里没有值为空串的条目
 */

const ROOT = path.resolve(__dirname, '../../..');
const LOCALES_DIR = path.join(ROOT, 'locales');
const RENDERER_DIR = path.resolve(__dirname, '..');

const LANGUAGES = ['zh-CN', 'en', 'ja', 'ko', 'vi'];
const NAMESPACES = ['common', 'layout', 'alerts', 'dashboard', 'settings', 'obstruction', 'alignment', 'satellite'];

type Dict = Record<string, unknown>;

function loadDict(lng: string, ns: string): Dict {
  const file = path.join(LOCALES_DIR, lng, `${ns}.json`);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Dict;
}

/** 递归取扁平的 `a.b` 键路径（字典最多两层，但递归更稳） */
function flatten(obj: Dict, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of flatten(v as Dict, key)) out.set(k2, v2);
    } else {
      out.set(key, String(v));
    }
  }
  return out;
}

/** 收集所有 .ts/.tsx 源文件（跳过测试文件自身与 node_modules） */
function collectSources(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collectSources(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * 从源码里抓出 i18n 键。
 *
 * 两类写法都要覆盖：
 * - 直接调用：`t('common:version', {...})` / `t("alerts:messages.foo")`
 * - 键存在常量里：`labelKey: 'layout:nav_dashboard'`（Layout 就是这种）
 * 所以除了 `t()` 调用，再把「命名空间前缀 + 冒号」形态的字符串一并纳入。
 */
function extractKeys(source: string): Set<string> {
  const keys = new Set<string>();

  // 1) t('ns:key') / t("ns:key") / t(`ns:key`)  —— 含无命名空间的 t('key')
  const callRe = /\bt\s*\(\s*(?:['"`])((?:(?:common|layout|alerts|dashboard|settings|obstruction|alignment|satellite):)?[A-Za-z0-9_.-]+)(?:['"`])/g;
  for (const m of source.matchAll(callRe)) {
    const raw = m[1];
    // 纯数字/单字符之类不是文案键，跳过
    if (!/[A-Za-z]/.test(raw)) continue;
    keys.add(raw);
  }

  // 2) 任意位置的 'ns:key' 字符串常量
  const literalRe = /['"`]((?:common|layout|alerts|dashboard|settings|obstruction|alignment|satellite):[A-Za-z0-9_.-]+)['"`]/g;
  for (const m of source.matchAll(literalRe)) keys.add(m[1]);

  return keys;
}

/** 'ns:key' → { ns, key }；无前缀的按默认命名空间 common 解释 */
function splitKey(raw: string): { ns: string; key: string } {
  const idx = raw.indexOf(':');
  if (idx === -1) return { ns: 'common', key: raw };
  return { ns: raw.slice(0, idx), key: raw.slice(idx + 1) };
}

describe('i18n 字典完整性', () => {
  const dicts = new Map<string, Map<string, Map<string, string>>>();
  for (const lng of LANGUAGES) {
    const perNs = new Map<string, Map<string, string>>();
    for (const ns of NAMESPACES) perNs.set(ns, flatten(loadDict(lng, ns)));
    dicts.set(lng, perNs);
  }

  it('5 种语言的键集合完全一致（缺语言会在这里暴露）', () => {
    const reference = LANGUAGES[0]!;
    for (const ns of NAMESPACES) {
      const refKeys = [...dicts.get(reference)!.get(ns)!.keys()].sort();
      for (const lng of LANGUAGES.slice(1)) {
        const keys = [...dicts.get(lng)!.get(ns)!.keys()].sort();
        const missing = refKeys.filter((k) => !keys.includes(k));
        const extra = keys.filter((k) => !refKeys.includes(k));
        expect(
          { lng, ns, missing, extra },
          `${ns}.json: ${lng} 与 ${reference} 的键不一致\n  缺少: ${missing.join(', ')}\n  多余: ${extra.join(', ')}`
        ).toEqual({ lng, ns, missing: [], extra: [] });
      }
    }
  });

  it('字典里没有空值', () => {
    for (const lng of LANGUAGES) {
      for (const ns of NAMESPACES) {
        for (const [key, value] of dicts.get(lng)!.get(ns)!) {
          expect(String(value).trim(), `${lng}/${ns}.json: "${key}" 是空串`).not.toBe('');
        }
      }
    }
  });

  it('源码里出现的每个 i18n 键在 5 种语言里都存在', () => {
    const sources = collectSources(RENDERER_DIR);
    const used = new Map<string, string[]>(); // key → 用到它的文件

    for (const file of sources) {
      const src = fs.readFileSync(file, 'utf-8');
      for (const key of extractKeys(src)) {
        const rel = path.relative(RENDERER_DIR, file);
        used.set(key, [...(used.get(key) ?? []), rel]);
      }
    }

    expect(used.size, '没有在源码里发现任何 i18n 键，提取逻辑可能失效').toBeGreaterThan(0);

    const problems: string[] = [];
    for (const [raw, files] of used) {
      const { ns, key } = splitKey(raw);
      if (!NAMESPACES.includes(ns)) {
        problems.push(`未知命名空间 "${ns}"（键 ${raw}，用于 ${files[0]}）`);
        continue;
      }
      const missingIn = LANGUAGES.filter((lng) => !dicts.get(lng)!.get(ns)!.has(key));
      if (missingIn.length > 0) {
        problems.push(`${raw} 在 ${missingIn.join('/')} 缺失（用于 ${files.slice(0, 2).join(', ')}）`);
      }
    }

    expect(problems, `i18n 键缺失:\n${problems.join('\n')}`).toEqual([]);
  });

  /**
   * 告警规则类型与字典的对账。
   *
   * 告警标题是通过 `alerts:types.<alert_type>.title` 动态拼出来的，
   * 上面的静态键扫描看不见这类键 —— 规则 id 改了名或新增了规则而忘了补字典，
   * 界面上就会出现"空标题 / 退回中文原文"，只能靠这条用例兜住。
   */
  it('manager 里的每条告警规则在字典里都有对应条目', () => {
    const managerSrc = fs.readFileSync(
      path.resolve(ROOT, 'src/alerting/manager.ts'),
      'utf-8'
    );
    const ruleIds = new Set<string>();
    for (const m of managerSrc.matchAll(/\n {8}id: '([a-z_]+)',/g)) ruleIds.add(m[1]);
    // 探针驱动的告警不走规则表，单独补上
    ruleIds.add('dns_failure');
    // 探针依赖抑制产生的告警类型（不在 RULES 里，是 triggerProbeSourceAlert 直接落库的）
    ruleIds.add('probe_source_unavailable');

    expect(ruleIds.size, '没有从 manager.ts 提取到任何规则 id').toBeGreaterThan(10);

    const problems: string[] = [];
    for (const id of ruleIds) {
      for (const lng of LANGUAGES) {
        const dict = dicts.get(lng)!.get('alerts')!;
        if (!dict.has(`types.${id}.title`)) problems.push(`${lng}: 缺少 types.${id}.title`);
        if (!dict.has(`types.${id}.summary`) && id !== 'dns_failure') {
          problems.push(`${lng}: 缺少 types.${id}.summary`);
        }
      }
    }
    expect(problems, `告警字典缺条目:\n${problems.join('\n')}`).toEqual([]);
  });
});
