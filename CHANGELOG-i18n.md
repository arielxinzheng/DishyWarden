# 变更记录：i18n 国际化改造（5 语言）

**日期**: 2026-11-09
**范围**: 全前端（41 个源码文件 + 8 个命名空间 × 5 语言 = 813 键）
**状态**: 单测 340 全过 / tsc 双配置 0 错误 / 5 语言浏览器实测通过 / 打包分块验证通过

> 相关总览见 [`DEVELOPMENT-STATUS.md`](./DEVELOPMENT-STATUS.md)。

---

## 1. 目标与落点

| 需求 | 落点 |
|---|---|
| 引入 i18next + 视图层绑定 | `i18next` + `react-i18next` + `i18next-browser-languagedetector`（新增依赖） |
| HTTP Backend 或按路由分割 | **Vite 动态 import 分块**（见 §2，附工程理由） |
| `locales/` 五语言目录 | `locales/{zh-CN,en,ja,ko,vi}/`，8 个命名空间 |
| 扁平化命名空间、便于机翻 | 每个命名空间按业务模块分组，最���两层 |
| 严禁硬编码中文 | 全部用户可见文案走 `t()`；纯逻辑模块改为**返回语义码** |
| 动态文案插值 | `t('alerts:xxx', { rate })`，插值变量逐条核对 |
| 全局语言切换器 + 持久化 | `components/LanguageSwitcher.tsx`（Layout 侧栏 + 设置页） |
| 缺词静默回落英文、不暴露键名 | `fallbackLng: 'en'` + `parseMissingKeyHandler` 返回空串 |

## 2. 为什么没用 `i18next-http-backend`

需求原文倾向 HTTP Backend，但本项目是 **Electron 应用**：打包后渲染进程走 `file://`，
`fetch('locales/en/common.json')` 会直接失败；开发态又是 Vite dev server，
两套协议要额外写适配层。

改用 **Vite 的 `import.meta.glob`**：

- 每个 `locales/<lng>/<ns>.json` 被切成**独立 chunk**，首屏只下载当前语言；
- 不依赖任何 HTTP 服务或协议，dev / 打包后（`file://`）都成立；
- 仍是**异步按需加载**，接口语义与 http-backend 一致（`read(lng, ns, cb)`）。

**实测**（`vite build`）：主 chunk 不含任何语言文案（`丢包率` / `パケットロス率` /
`패킷 손실률` / `Tỷ lệ mất gói` 全部不在 `index-*.js`），
5 语言 × 8 命名空间各自成 chunk（12~16 KB），按需加载。

## 3. 字典结构

```
locales/
├── zh-CN/  en/  ja/  ko/  vi/
│   ├── common.json        22 键   通用词（语言、时长单位、加载/重试…）
│   ├── layout.json         7 键   导航、页脚
│   ├── alerts.json       163 键   29 条告警规则的标题/摘要/建议 + 严重度/状态 + 页面文案
│   ├── dashboard.json    285 键   指标卡、图表、拓扑链、告警抽屉、Setup 引导
│   ├── settings.json     136 键   采集、探针、通知、Grafana、阈值
│   ├── obstruction.json   56 键   遮挡页、图例、事件历史
│   ├── alignment.json     58 键   校准页、圆盘引导、姿态
│   └── satellite.json     86 键   卫星雷达、TLE、服务卫星
```

合计 **813 键 × 5 语言**。命名空间内按业务前缀分组（`metric.` `chart.` `topology.` …），
键名 snake_case、最多两层。

## 4. 架构决策：逻辑层不再返回文案

这是本次改造最关键的一条。

**改造前**：`topologyModel.ts`、`attitudeState.ts`、`obstructionAnalysis.ts`、
`servingSatellite.ts` 等纯逻辑模块**直接返回中文**（`'北'`、`'无明显遮挡'`、
`'正在搜索卫星'`…），渲染层只是把字符串贴出去。

**改造后**：逻辑层只返回**语义码**，翻译集中在视图层：

| 模块 | 改造前 | 改造后 |
|---|---|---|
| `topologyModel` | `linkLabel: '局域网'` | `linkId: 'lan'` + `TopologyMessage{key, params}` |
| `obstructionAnalysis` | `dominantDirection: '北'` | `'N'`（8 方位码） |
| `attitudeState` | `label: '姿态传感器已就绪'` | `tone: 'ok'` + `state: 'converged'` |
| `alignmentGuidance` | `hintMain: '向东旋转 20°'` | `action: 'rotate'` + `direction: 'cw'` + `adjustDeg` |
| `servingSatellite` | `reason: '间隔过窄'` | `reason: 'tight_fit_unique_margin'` |
| `tleService` | `describeFreshness` 返回中文句子 | 判别联合 `{kind:'network'|'cache_under_hour'|…}` |

**为什么必须这么做**：单测不该被语言绑架（换语言就红），翻译也必须集中，
否则同一句话在三个地方拼就会漏翻一处。相关单测已同步改为断言语义码
（`topologyModel.test` / `attitudeState.test` / `alignmentGuidance.test` /
`obstructionAnalysis.test`）。

新增 `components/Alignment/guidanceText.ts` 作为「语义码 → 文案」的唯一边界：
「向东旋转 20°」同时出现在圆心引导牌、综合结论、aria 三处，集中一层才不会漏翻。

## 5. 告警文案：数据在库里是中文，怎么办

主进程 `alerting/manager.ts` 生成的 `summary`/`description`/`recommendations`
是**中文**，随告警写进 SQLite。渲染层若直接展示，界面切到英文时告警仍是中文 ——
等于国际化只做了一半。

新增 `src/renderer/lib/alertMessage.ts`：

- 按 `alert_type` 从 `alerts:types.<id>.*` 取标题/摘要/建议；
- 动态数值由 `evidence` 归一化后插值（`rate` / `latency` / `snr` / `frac` /
  `temp` / `count` / `minutes`…），比率转百分比、uptime 秒转分钟；
- `dns_failure` 按探针的 user/baseline 结果分四种归因文案
  （用户态坏 / 两边都坏 / 本地延迟高 / 通用）；
- 字典里没有的**旧规则类型**回退数据库原文（历史数据兼容）；
- 配套给 `router_flapping` / `frequent_searching` 的 evidence 补了计数字段，
  否则前端插不出「变化 N 次」。

## 6. 兜底行为（需求第 4 条）

| 场景 | 结果 |
|---|---|
| ja/ko/vi 有该词 | 显示对应语言 |
| 该语言缺这个词 | **静默回落英文**（实测 ja 缺 `alerts` 词条 → 显示 `Dish offline`） |
| 5 种语言都没有 | 显示空串，**绝不出现 `alerts.title` 这种键名**（开发态打 warn） |
| 模板变量没传 | 页面不会出现 `{{rate}}` 字样（逐条核对过插值变量） |

## 7. 键校验测试

i18next 的键是运行期字符串，TypeScript 完全管不到 —— 拼错一个键、或新增文案忘了补某个语言，
`tsc` 一声不吭，要等用户切到日文才发现。`src/renderer/i18n/keys.test.ts` 做四件事：

1. 5 种语言的键集合**完全一致**；
2. 字典里不能有空值；
3. 源码里出现的每个键（含常量表里的 `'ns:key'` 字面量）在 5 种语言里都存在；
4. `manager.ts` 的每条告警规则都要有对应字典条目。

## 8. 验收

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit`（两个 config） | 0 错误 |
| `npx vitest run` | **22 文件 / 340 测试全过** |
| 键校验 | 5 语言键集合一致、无空值、源码键全存在、告警规则全有条目 |
| 硬编码中文扫描（去注释后） | **0 处用户可见中文**（仅语言自称 `简体中文`/`日本語` 保留，见下） |
| 浏览器全路由实测（zh-CN / en × 6 个路由） | 无 `{{...}}` 漏出、无原始键名、英文界面无中文残留 |
| 打包产物 | 主 chunk 无语言内容；语言包独立 chunk，按需加载 |

**关于语言自称**：切换器里 `简体中文` / `日本語` / `한국어` / `Tiếng Việt` 保持母语书写，
这是语言选择器的国际惯例（各系统语言列表都如此），刻意不参与翻译。

## 9. 已知限制与后续

1. **主进程的告警 `description` 字段仍是中文**（存在库里），界面已不再展示它
   （改用本地化 summary + 证据面板）；如需保留原描述的中文展示需另行设计。
2. `RouterStatusRow` 不再透传主进程的 `trustNote` 原文，改用本地化通用说明；
   若要展示基线 IP 等细节，需要主进程返回结构化字段。
3. 探针「新增」时写入的默认名称按当时语言落库（用户可编辑的数据字段），
   之后切语言不会重命名已有节点。
4. 瞬时提示（保存成功/失败、错误横幅）在**触发时**按当时语言生成，切语言不会重译已显示的旧提示。
5. 尚未提供繁体中文（`zh-TW`）：探测到会降级到英文而不是显示空白。

---

## 10. 追加：语言自动嗅探 + 切换器 UI 收敛

### 检测优先级（严格按需求）

| 优先级 | 来源 | 实现 |
|---|---|---|
| ① 用户显式选择 | localStorage `i18nextLng` | `detection.order: ['localStorage', 'navigator']` + `lookupLocalStorage` |
| ② 浏览器/系统语言 | `navigator.language` | 同上，第二顺位 |
| ③ 未支持的语言 | —— | `resolveLanguage()` 静默降级 **en**，不报错、不露键名 |

- 存储键改用 `i18next-browser-languagedetector` 的**默认键 `i18nextLng`**（原先是自定义键），
  任何按标准约定存语言的工具都能互通；旧键 `dishywarden-language` 会**自动迁移**一次，老用户的选择不丢。
- 语言标记收敛由 detector 的 `detection.convertDetectedLanguage` 完成（注意这是**插件**的选项，
  i18next v24 运行时本身没有同名顶层选项）：
  `zh`/`zh-Hans` → `zh-CN`、`ja-JP` → `ja`、`ko-KR` → `ko`、`vi-VN` → `vi`、
  `zh-TW`/`zh-Hant`（无语言包）与 `ar`/`fr` 等一律 → **`en`**。

实测（Playwright 改浏览器 locale）：

| 场景 | 结果 |
|---|---|
| 系统 zh-CN / ja-JP / ko-KR / vi-VN | 分别进入中文 / 日文 / 韩文 / 越南文 ✓ |
| 系统 ar-SA、fr-FR（无语言包） | **静默降级英文**，无报错、无键名 ✓ |
| 系统 ar-SA + 用户此前选了 ja | **ja**（用户选择优先）✓ |
| 系统 zh-CN + 用户此前选了 ko | **ko** ✓ |
| 旧键 `dishywarden-language=vi` | 自动迁移到 `i18nextLng=vi` ✓ |

### 切换器 UI 收敛

原来的长条 `<select>`（宽度随语言名变化，`简体中文` 与 `Tiếng Việt` 长度差很多）换成
**🌐 图标按钮 + 悬浮/点击展开的下拉菜单**：

- 页面右上角：**32×32 纯图标按钮**（原来 96px 宽的下拉），省出横向空间；
- 侧栏 / 设置页：图标 + 当前语言名（保留可读性）；
- 交互：hover 即开、点击可固定、Esc 关闭、点击别处关闭、当前语言带 ✓；
- 无障碍：`aria-haspopup` / `aria-expanded` / `role=menu` / `role=menuitemradio` + `aria-checked`。

### 新增测试

`src/renderer/i18n/language.test.ts`（8 例）：纯函数 `resolveLanguage()` 的收敛规则 ——
精确命中、大小写、中文各种写法、繁体降级、带地区码收敛、未支持语言降级、空值降级、
结果必为受支持语言码。
