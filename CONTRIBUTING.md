# Contributing to DishyWarden

> 贡献指南。讲「怎么在这个仓库里干活不踩坑」。
> 想了解项目现状/技术债，看 [`DEVELOPMENT-STATUS.md`](https://github.com/arielxinzheng/DishyWarden)（内部文档，不随公开仓库发布）。

---

## 0. 这是什么项目

Starlink（星链）终端监控软件。Electron 桌面应用 + React 前端 + SQLite 历史库。

- **技术栈**：Electron 33 / Vite 6 / React 18 / TypeScript / Tailwind 4 / sql.js / satellite.js / ECharts
- **数据源**：真实 Starlink dish 的 gRPC

### 跑起来

```bash
git clone https://github.com/arielxinzheng/DishyWarden.git
cd DishyWarden
npm install
npm run dev        # vite (5173) + electron
```

Electron 窗口和浏览器 `http://localhost:5173` 都能开，但**功能不等价**：

| 功能 | 浏览器 | Electron |
|---|---|---|
| 仪表盘数据 | mock 假数据 | ✅ 真实 gRPC |
| 设置页保存 | ❌ 点了没反应 | ✅ 真落盘 |
| 告警列表 | ❌ 永远空 | ✅ 真实告警 |
| 卫星雷达 | ✅ mock 星历 | ✅ 真实 TLE |

**验证功能必须在 Electron 窗口里做。**

---

## 1. 提交纪律

### 只 add 自己改的文件

```bash
git status                    # 动手前先看
git diff --stat               # 提交前看范围
git add <具体文件>             # 不要 git add -A
git diff --cached --name-only # 逐个核对, 确认没有别人的文件混进来
```

### 绝对禁止

```bash
git restore .          # 抹掉未提交改动，无任何提示
git checkout .         # 同上
git reset --hard       # 移动 HEAD
git stash              # 把改动一起藏起来
git clean -fd          # 删掉未跟踪文件
git add -A             # 会把无关改动一起提交
```

> 实测确认：`git restore <file>` 会**静默丢弃**未提交的修改，git 不给任何警告。

### 提交信息格式

```
<type>: <简述>

<正文: 为什么改, 怎么验证的>
```

type 用：`feat` / `fix` / `refactor` / `docs` / `chore` / `perf`

---

## 2. 改代码前必知的坑

### 2.1 主进程改动不热更新 ⚠️ 最常踩

| 路径 | 改完要做什么 |
|---|---|
| `src/renderer/**` | ✅ HMR 自动生效，秒级 |
| `src/main/**` `src/storage/**` `src/core/**` `src/alerting/**` | ❌ **必须重启 Electron** |

改完看不到效果，**先确认是不是忘了重启**，别急着改代码。

```bash
pkill -f "DishyWarden/node_modules/electron"; npm run dev
```

### 2.2 sql.js 锁死在 Electron ABI

原生模块是针对 **Electron 33（NODE_MODULE_VERSION 130）** 编译的。
用普通 node（ABI 147）`require` 会直接抛错。

写验证脚本用 **`sqlite3` CLI**，不要用 node require：

```bash
sqlite3 ~/Library/Application\ Support/Electron/data/telemetry.db "SELECT COUNT(*) FROM telemetry_samples;"
```

### 2.3 satellite.js v7 的参数类型

```js
satellite.ecfToLookAngles(observerGeodetic, satelliteEcf)  // 第二个参数是 ECF
```

传成 geodetic 会**静默返回 NaN**，下游 `elevation > 0` 过滤后表现为
「一颗卫星都看不到」，**日志里一行错都没有」。已加 NaN 兜底，别绕过它。

### 2.4 CelesTrak 会限流返回 403

403 响应体里**没有 TLE**。看到 0 条记录先看 status code：
那是「刚拉过、2 小时冷却中」，不是「星座为空」。

已有三级回退（新鲜缓存 → 过期缓存 → 网络多源 → 内置种子），**别绕过它**。

### 2.5 `tsconfig.json` 含 JSONC 注释

常规编辑工具的 JSON 校验会拒绝写入它。要改配置用精确编辑，
或另建 `*.d.ts` 引用声明（参考 `src/vite-env.d.ts`）。

### 2.6 `HistorySample.state` 字段早已存在

只是长期没人用。别重复添加，否则出现两个来源不一致的 state。

---

## 3. 代码地图

```
src/
├── main/          主进程 —— 改完必须重启
│   ├── index.ts       IPC handler 注册 + 窗口生命周期
│   ├── preload.ts     contextBridge 暴露 electronAPI
│   ├── dev.ts         开发模式构建+启动（esbuild）
│   ├── tleSeed.ts     内置星历读取（gzip + 内存缓存）
│   └── prometheus.ts  Prometheus 进程管理
│
├── storage/       SQLite 持久化 —— 改完必须重启
│   ├── schema.ts         DDL 唯一来源 + 保留策略常量
│   ├── types.ts          对外纯类型（禁止 import sql.js）
│   ├── telemetryStore.ts TelemetryStore：写入/查询/摘要/清理
│   └── index.ts          只导出类型与常量
│
├── core/          gRPC 客户端 + 遥测格式化
├── alerting/      告警规则引擎 / 持久化 / 通知
├── collector/     采集器（30s 落盘 + 内存降级）
├── config/        配置持久化
├── prometheus/    Prometheus / Grafana 集成
│
└── renderer/      前端 —— HMR 生效
    ├── pages/         6 个页面
    ├── components/    Dashboard 组件 + ErrorBoundary + ui 组件库
    ├── hooks/useDish.tsx   useDish / useDishHistory / useHistorySummary
    ├── lib/alertFormat.ts  告警 JSON 安全解析
    ├── utils/         satelliteCalculator / tleService
    └── assets/        tle-seed.json.gz（内置离线星历）
```

**分层约束**（这层边界很容易被无意破坏）：

- `src/storage/types.ts` **禁止** import `sql.js` —— 渲染层也 import 这些类型
  （`metricSeries.ts` / `LatencyChart.tsx` / `ThroughputChart.tsx` / `useDish.tsx` 都在 import），
  原生模块进 renderer bundle 会炸
- `src/storage/index.ts` **禁止**导出 `TelemetryStore` —— 主进程要从 `./telemetryStore` 直接引
- 想让渲染层用存储层的类型，从 `storage/types` 引，**不要**从 `storage/index` 引

---

## 4. 数据位置

| 内容 | 路径 |
|---|---|
| 遥测库 | `~/Library/Application Support/Electron/data/telemetry.db` |
| 告警库 | `~/Library/Application Support/Electron/data/alerts.db` |
| 配置 | `~/Library/Application Support/Electron/config/config.json` |
| 终端位置 | localStorage `terminal_latitude` / `terminal_longitude` |
| 星历缓存 | localStorage `starlink_tle_cache` |

> 注意 userData 目录名在开发态是 `Electron` —— 打包后 productName 是 `DishyWarden`，
> 路径会变成 `~/Library/Application Support/DishyWarden/`。
> 开发时和打包版的数据是**两套**，别搞混。

---

## 5. 验证方法

### 类型检查（两个 config 都要跑）

```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.electron.json
```

> 只跑一个 config 等于没有类型检查 —— 两份 tsconfig 覆盖的范围不一样。

### 单元测试

```bash
npx vitest run              # 全部
npx vitest run <file>       # 只跑改动的那个文件
```

按影响面选范围：只改独立组件时不必跑全量。

### 构建

```bash
npm run electron:build      # 主进程
npx vite build              # 渲染层
```

### 端到端验证（用独立 Electron 实例）

比手动点窗口可靠：

```js
// probe.cjs
const { app, BrowserWindow, ipcMain } = require('electron');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { preload: '<repo>/dist-electron/main/preload.cjs' } });
  ipcMain.handle('get-latest-telemetry', () => ({ /* mock 数据 */ }));
  await w.loadURL('http://localhost:5173');
  await new Promise(r => setTimeout(r, 4000));
  console.log(await w.webContents.executeJavaScript(`document.querySelector('main').innerText`));
  app.exit(0);
});
```

**注意**：这个实例会自己占 5173/9817 端口，跑之前先 `pkill` 掉正在运行的 dev。

---

## 6. i18n

新增或修改文案**必须同时补五种语言**：`zh-CN` / `en` / `ja` / `ko` / `vi`。

源文件在 `locales/<lang>/*.json`。`locales/i18n/keys.test.ts` 会校验五语言
的键集合一致 —— 漏一种语言 CI 会红。

```bash
npx vitest run locales/i18n/keys.test.ts
```

---

## 7. 多语言文档

`README*.md` 与 `PRIVACY*.md` 是**生成产物**，源文件在 `docs/readme/*.md`、
`docs/privacy/*.md`。

```bash
npm run docs:generate   # 改源文件后重新生成
npm run docs:check      # 校验生成产物与源文件一致（CI 会跑）
```

**不要手改根目录的 `README*.md` / `PRIVACY*.md`** —— CI 的 `docs:check`
会因漂移失败。

---

## 8. 不要做的事

| 别做 | 原因 |
|---|---|
| 删 `src/renderer/assets/tle-seed.json.gz` | 断网兜底全靠它，438KB |
| 改 `src/storage/types.ts` 去 import 原生模块 | renderer bundle 会炸 |
| 在 `metricSeries` / `mapRow` 里去掉 NaN 兜底 | NaN 会静默清空整页数据 |
| 改 `schema.ts` 的 DDL 而不写迁移 | 已有用户库会结构错乱（目前**没有**迁移框架） |
| 用 `git add -A` | 会把无关改动一起提交 |
| 「顺手」重构没坏的部分 | 不要动 working config |
| 提交 `node_modules` / `dist` | 已在 .gitignore，但 `git add -A` 会绕过 |
| 手改 `build.publish` / `UPDATE_FEED_URL` | 两处必须同时改，否则客户端找不到升级清单 |
| 删掉 `build.npmRebuild: false` | 会让打包把本地 arm64 原生模块覆盖成 x64 —— 采集器照跑但历史库静默写不进去 |

---

## 9. 发版

托管方是 **GitHub Releases**。发版流程：改 `package.json` 的 `version` →
打 `v<version>` tag → CI 自动构建并发布 → 自检清单可下载。

**不需要配置任何 PAT** —— workflow 用 GitHub 内置的 `GITHUB_TOKEN`，
权限由 workflow 里的 `permissions: contents: write` 授予，
作用域仅限本仓库、仅该次 job。

详见 [`docs/CLOUD-UPGRADE.md`](./docs/CLOUD-UPGRADE.md)。

---

## 10. 关键参考

| 文档 | 内容 |
|---|---|
| [`docs/CLOUD-UPGRADE.md`](./docs/CLOUD-UPGRADE.md) | 发布与升级托管契约 |
| [`docs/screenshots/README.md`](./docs/screenshots/README.md) | 截图占位说明 |
| [`CHANGELOG.md`](./CHANGELOG.md) | 版本变更记录（1.0.0 起） |

---

## 11. 行为准则

请阅读 [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)。报告安全问题请看
[`SECURITY.md`](./SECURITY.md) —— **不要**开公开 issue。
