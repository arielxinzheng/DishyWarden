#!/usr/bin/env node
/**
 * 多语言文档生成器 —— README 与 PRIVACY 的「单一真源」机制
 *
 * 为什么要有它：手写 5 份 README / 5 份 PRIVACY 必然漂移（改了一份忘了另外四份）。
 * 这里把「语言集合、切换条、徽章」三件事收敛到一个文件里：
 *
 *   docs/readme/<lang>.md     ← 源（唯一需要手改的地方）
 *   docs/privacy/<lang>.md    ← 源
 *        │
 *        │  node scripts/gen-readme.mjs          （生成）
 *        │  node scripts/gen-readme.mjs --check  （只校验，CI 用）
 *        ▼
 *   README.md  README.zh-CN.md  README.ja.md  README.ko.md  README.vi.md
 *   PRIVACY.md PRIVACY.zh-CN.md PRIVACY.ja.md  PRIVACY.ko.md  PRIVACY.vi.md
 *
 * 源文件里可以用这几个占位符（生成时替换）：
 *   %REPO_URL%    仓库 URL（取自 package.json 的 repository 字段）
 *   %OWNER%       仓库 owner
 *   %REPO%        仓库名
 *   %FEED_URL%    升级源 latest.yml 地址
 *   %YEAR%        当前年份
 *
 * 加一门语言：往 LANGUAGES 里加一项 + 建 docs/readme/<lang>.md 即可，
 * 切换条和 CI 漂移检测会自动跟上。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 语言集合 —— 唯一真源。与 app 的 i18n（locales/*）保持一致。 */
const LANGUAGES = [
  { code: 'en', label: 'English', file: 'README.md', default: true },
  { code: 'zh-CN', label: '简体中文', file: 'README.zh-CN.md' },
  { code: 'ja', label: '日本語', file: 'README.ja.md' },
  { code: 'ko', label: '한국어', file: 'README.ko.md' },
  { code: 'vi', label: 'Tiếng Việt', file: 'README.vi.md' },
];

/** 文档家族：source dir → 输出文件名前缀 */
const FAMILIES = [
  { name: 'readme', srcDir: 'docs/readme', outBase: 'README', outExt: '.md' },
  { name: 'privacy', srcDir: 'docs/privacy', outBase: 'PRIVACY', outExt: '.md' },
];

const CHECK_ONLY = process.argv.includes('--check');

function readPackageMeta() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
    const m = repoUrl.match(/github\.com[:/]+([^/]+)\/([^/.]+)/);
    const owner = m ? m[1] : '';
    const repo = m ? m[2] : (pkg.name || 'DishyWarden');
    return { owner, repo, feedUrl: `https://github.com/${owner}/${repo}/releases/latest/download/latest.yml` };
  } catch {
    return { owner: '', repo: 'DishyWarden', feedUrl: '' };
  }
}

function substitute(text, meta) {
  return text
    .replaceAll('%REPO_URL%', meta.owner ? `https://github.com/${meta.owner}/${meta.repo}` : 'https://github.com/OWNER/DishyWarden')
    .replaceAll('%OWNER%', meta.owner || 'OWNER')
    .replaceAll('%REPO%', meta.repo)
    .replaceAll('%FEED_URL%', meta.feedUrl || 'https://github.com/OWNER/DishyWarden/releases/latest/download/latest.yml')
    .replaceAll('%YEAR%', String(new Date().getFullYear()));
}

/** 语言切换条 —— GitHub 会渲染这段内联 HTML */
function switchBar(currentCode, outBase) {
  const items = LANGUAGES.map((l) =>
    l.code === currentCode
      ? `<strong>${l.label}</strong>`
      : `<a href="./${l.file}">${l.label}</a>`
  ).join(' · ');
  return `<div align="center">\n  ${items}\n</div>`;
}

function buildHeader(family, lang, meta) {
  const badgeRow = [
    `![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)`,
    `![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)`,
    `![Electron](https://img.shields.io/badge/electron-33-blue.svg)`,
    `![i18n](https://img.shields.io/badge/i18n-5%20languages-blueviolet.svg)`,
  ].join(' ');

  const lines = [
    '<!--',
    `  本文件由 scripts/gen-readme.mjs 自动生成 —— 请勿直接编辑。`,
    `  源文件：${family.srcDir}/${lang.code}.md`,
    '  改完源文件后执行：node scripts/gen-readme.mjs',
    '-->',
    '',
    `<div align="center">`,
    '',
    `  ${badgeRow}`,
    '',
    '</div>',
    '',
    switchBar(lang.code, family.outBase),
    '',
  ];
  return lines.join('\n');
}

function render(family, lang, meta) {
  const srcPath = join(ROOT, family.srcDir, `${lang.code}.md`);
  if (!existsSync(srcPath)) {
    throw new Error(`缺少源文件: ${family.srcDir}/${lang.code}.md`);
  }
  const src = substitute(readFileSync(srcPath, 'utf8'), meta);
  const header = buildHeader(family, lang, meta);
  return `${header}\n${src.trim()}\n`;
}

function main() {
  const meta = readPackageMeta();
  if (!meta.owner) {
    console.warn('⚠️  package.json 里没有 repository 字段 —— 占位符会填成 OWNER。');
    console.warn('    加一行 "repository": {"type":"git","url":"https://github.com/<owner>/DishyWarden.git"} 即可。');
  }

  const outputs = [];
  for (const family of FAMILIES) {
    for (const lang of LANGUAGES) {
      const outPath = join(ROOT, `${family.outBase}${lang.default ? '' : `.${lang.code}`}${family.outExt}`);
      outputs.push({ outPath, content: render(family, lang, meta) });
    }
  }

  let drift = 0;
  for (const { outPath, content } of outputs) {
    const rel = outPath.replace(`${ROOT}/`, '');
    if (CHECK_ONLY) {
      const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null;
      if (current !== content) {
        drift++;
        console.error(`✗ ${rel} 与源文件不一致（内容漂移或未生成）`);
      }
    } else {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, content, 'utf8');
      console.log(`✓ 生成 ${rel}`);
    }
  }

  if (CHECK_ONLY) {
    if (drift > 0) {
      console.error(`\n${drift} 个文件与源文件不一致。执行 node scripts/gen-readme.mjs 重新生成。`);
      process.exit(1);
    }
    console.log(`✓ ${outputs.length} 个多语言文档与源文件一致`);
  }
}

main();
