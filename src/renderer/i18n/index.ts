import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

/**
 * i18n 初始化。
 *
 * ## 为什么不用 `i18next-http-backend`
 *
 * 需求原文倾向 HTTP Backend（`/locales/{{lng}}/{{ns}}.json`），但本项目是 **Electron 应用**：
 * 打包后渲染进程走 `file://` 协议，`fetch('locales/en/common.json')` 会直接失败；
 * 而开发态又是 Vite dev server，两种环境路径完全不同，要额外写一套协议适配。
 *
 * 这里改用 **Vite 的动态 import 分块**（`import.meta.glob`）：
 *   - 每个 `locales/<lng>/<ns>.json` 会被 Vite 切成**独立的 chunk**，
 *     首屏只下载「当前语言 × 各命名空间」，5 种语言不会全量进主 bundle ——
 *     这正是需求想达到的效果；
 *   - 不依赖任何 HTTP 服务或协议，dev / 打包后（file://）都成立；
 *   - 仍然是**异步按需加载**，接口语义与 http-backend 一致（`read(lng, ns, cb)`）。
 *
 * ## 关键行为约定
 *
 * 1. **fallback 到英文**：某语言缺词时静默降级到 `en`（`fallbackLng`）。
 * 2. **绝不暴露原始键名**：连 `en` 都没有的键，用 `parseMissingKeyHandler` 返回空串，
 *    并在开发态打一条 warn —— 页面上永远不会出现 `alerts.title` 这种字样。
 * 3. **语言持久化**：`i18next-browser-languagedetector` 把用户选择写进 localStorage，
 *    刷新不重置（探测顺序 localStorage → 浏览器语言）。
 */

export const SUPPORTED_LANGUAGES = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'vi', label: 'Tiếng Việt' },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];

/** 业务命名空间：按模块拆分，便于后续机翻 / 外包 */
export const NAMESPACES = [
  'common',
  'layout',
  'alerts',
  'dashboard',
  'settings',
  'obstruction',
  'alignment',
  'satellite',
] as const;

export type Namespace = (typeof NAMESPACES)[number];

/** 默认语言（需求指定简体中文），缺失时统一降级到 en */
export const FALLBACK_LANGUAGE: LanguageCode = 'en';

/**
 * localStorage 键名。
 *
 * 用的是 `i18next-browser-languagedetector` 的**默认键** `i18nextLng`
 * （插件自己的读写约定），这样任何按标准约定存语言的工具/插件都能互通。
 */
export const LANGUAGE_STORAGE_KEY = 'i18nextLng';

/** 早期版本用过自定义键，迁移一次以免老用户的选择丢失 */
const LEGACY_LANGUAGE_KEY = 'dishywarden-language';

function migrateLegacyLanguageKey(): void {
  try {
    const legacy = localStorage.getItem(LEGACY_LANGUAGE_KEY);
    if (legacy && !localStorage.getItem(LANGUAGE_STORAGE_KEY)) {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, legacy);
    }
  } catch {
    // localStorage 不可用（隐私模式等）—— 忽略，走浏览器语言探测
  }
}

const localeModules = import.meta.glob('../../../locales/*/*.json');

/** 把 glob 的键整理成 `lng/ns` → loader，避免依赖路径前缀细节 */
const loaderMap = new Map<string, () => Promise<unknown>>();
for (const [path, loader] of Object.entries(localeModules)) {
  const m = path.match(/locales\/([^/]+)\/([^/]+)\.json$/);
  if (m) loaderMap.set(`${m[1]}/${m[2]}`, loader as () => Promise<unknown>);
  else if (import.meta.env.DEV) {
    console.warn('[i18n] 无法识别的语言包路径:', path);
  }
}

/**
 * 精简 backend：实现 i18next 的 `BackendModule` 接口。
 *
 * `defaults: false` 那类"缺词"情况由 i18next 的 fallback 处理，这里只管加载。
 */
const asyncChunkBackend = {
  type: 'backend' as const,
  init() {
    /* 无需初始化 */
  },
  read(
    language: string,
    namespace: string,
    callback: (error: Error | null, data: Record<string, unknown> | null) => void
  ) {
    const loader = loaderMap.get(`${language}/${namespace}`);
    if (!loader) {
      // 该语言没有这个命名空间（例如还没翻译完）—— 交给 fallbackLng 处理
      callback(null, null);
      return;
    }
    loader()
      .then((mod) => {
        const json = (mod as { default?: Record<string, unknown> }).default ?? (mod as Record<string, unknown>);
        callback(null, json);
      })
      .catch((error: Error) => callback(error, null));
  },
};

migrateLegacyLanguageKey();

export const i18nReady = i18n
  .use(LanguageDetector)
  .use(asyncChunkBackend)
  .use(initReactI18next)
  .init({
    fallbackLng: FALLBACK_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES.map((l) => l.code),
    defaultNS: 'common',
    ns: [...NAMESPACES],
    // 只在"当前语言"上加载，不做 zh → zh-CN 的隐式展开（我们只维护显式语言包）
    load: 'currentOnly',
    detection: {
      // ① 用户显式选择（localStorage `i18nextLng`）→ ② 浏览器/系统语言（navigator）
      // 只要用户切过一次，localStorage 永远优先（detector 的 order 就是优先级）
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ['localStorage'],
      // 探测器拿到 `zh-Hans` / `ja-JP` / `ar` 这类标记时，先收敛到受支持的语言码；
      // 不支持的语言（如阿拉伯语）直接落到 `en`，不会去加载不存在的语言包。
      // ⚠️ 这个钩子是 **detector 插件**的选项（i18next v24 运行时本身没有同名顶层选项）。
      convertDetectedLanguage: (lng: string) => resolveLanguage(lng),
    },
    interpolation: {
      // React 自己会转义，i18next 再转一次会把 < 变成 &lt;
      escapeValue: false,
    },
    returnNull: false,
    saveMissing: false,
    // 连 en 都没有的键：返回空串，绝不把键名渲染到界面上
    parseMissingKeyHandler: (key) => {
      if (import.meta.env.DEV) {
        console.warn('[i18n] missing translation key:', key);
      }
      return '';
    },
    react: {
      // 初始化在渲染前完成（见 main.tsx），运行时切语言不会再阻塞渲染
      useSuspense: false,
    },
  });

/** 同步窗口标题：`index.html` 里只留中性品牌名，多语言标题由这里写入 */
export function syncDocumentTitle(): void {
  document.title = `DishyWarden · ${i18n.t('common:app_name')}`;
}

/** 语言变化时同步 `<html lang>` 与窗口标题，让字体、断词、朗读、任务栏都跟着走 */
i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
  syncDocumentTitle();
});

// 初始化时（首次探测出语言后）也要写一次标题
void i18nReady.then(() => syncDocumentTitle());

/**
 * 把任意语言标记（`zh-Hans`、`ja-JP`、`ar`…）解析成**受支持的**语言码。
 *
 * 判定顺序与需求一致：
 *   1. 用户显式选择（localStorage `i18nextLng`）—— detector 负责，优先级最高；
 *   2. 浏览器 / 系统语言（`navigator.language`）—— 由本函数收敛到受支持的码；
 *   3. 不支持的语言（如阿拉伯语）⇒ **静默降级到 `en`**，不报错、不露键名。
 *
 * 纯函数、无副作用，方便单测。
 */
export function resolveLanguage(detected: string | undefined | null): LanguageCode {
  if (!detected) return FALLBACK_LANGUAGE;
  const lower = detected.toLowerCase().trim();

  // 精确命中（含 zh-cn 这类带地区码的写法）
  const exact = SUPPORTED_LANGUAGES.find((l) => l.code.toLowerCase() === lower);
  if (exact) return exact.code;

  if (lower === 'zh' || lower.startsWith('zh-')) {
    // 繁体目前没有语言包 ⇒ 按"不支持"处理，静默降级英文
    const traditional = ['tw', 'hk', 'mo', 'hant'].some((t) => lower.includes(t));
    return traditional ? FALLBACK_LANGUAGE : 'zh-CN';
  }

  // 只剩语种部分：ja-JP → ja、ko-KR → ko、vi-VN → vi
  const base = lower.split('-')[0];
  const byBase = SUPPORTED_LANGUAGES.find((l) => l.code.split('-')[0] === base);
  return (byBase?.code ?? FALLBACK_LANGUAGE) as LanguageCode;
}

/** 兼容旧调用点：显示当前语言时用的收敛函数 */
export function normalizeLanguage(lng: string | undefined): LanguageCode {
  return resolveLanguage(lng);
}

export default i18n;
