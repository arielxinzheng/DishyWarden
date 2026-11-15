# CHANGELOG · 升级嗅探与匿名反馈（2026-11-12）

阶段 B：SLMonitor 客户端接上 SL Cloud（云端服务本体在独立仓库 `CloudServer/`）。

设计依据：[`CloudServer/DESIGN.md`](./CloudServer/DESIGN.md) §3（升级链路）、§5（数据）、§6（隐私）。

---

## 1. 新增能力

### 1.1 升级检查（自动嗅探）

- **技术选型**：electron-updater **generic provider**（`setFeedURL({provider:'generic'})`），
  feed URL 来自配置 `cloud.updateFeedUrl`
  - 指向 GitHub Releases 的 `latest.yml` 即可自动升级
  - 留空 ⇒ **完全不检查**（GitHub 仓库还没建之前，客户端发布零噪音）
- **轮询节奏**：启动后 30s 首查 → 之后每 12h ± 30min 随机抖动
  - 抖动是刻意的：没有抖动，全网客户端会在同一秒打同一个更新源
- **单次检查超时 10s**，超时降级为 `error` 状态而不是挂住
- **不自动下载**（需求 2.8.2）：发现新版本只提示，用户点「立即下载」才下
- **安装走 `quitAndInstall(false, true)`**（需求 2.8.3）：
  NSIS 让安装器接管，规避 Windows 运行中 exe 的文件占用锁，`runAfterFinish` 自动拉起

### 1.2 误报负样本上报

- 用户标记「误报」后，**首次弹一次明示框**（写清楚上报什么 / 不含什么 / 随时可关），
  确认后匿名上报；之后静默发
- 载荷：`alert_key / severity / title / evidence`（告警触发瞬间的遥测快照）
- **上报失败不影响本地标记** —— 本地库里那条记录才是真值

### 1.3 升级链路打点

`upgrade_check`（result = no_update/available/error）、`upgrade_download`、`upgrade_install`、
`upgrade_heartbeat`（启动心跳，兼作升级成功确认与版本分布统计）

---

## 2. 新增文件

| 文件 | 作用 |
|---|---|
| `src/core/cloudClient.ts` | 云端上报客户端：白名单 / 超时 / 静默失败 |
| `src/core/updater.ts` | electron-updater 封装：轮询 / 超时 / 状态机 / 结构校验 |
| `src/renderer/lib/cloudFeedback.ts` | 渲染层误报上报 + 一次性明示确认 |
| `src/renderer/components/Settings/UpdateFeedbackCard.tsx` | 设置页「升级与匿名反馈」卡片 |
| `src/config/manager.test.ts` | 配置合并回归（老配置无 cloud 段不炸） |
| `src/core/cloudClient.test.ts` | 上报契约（白名单 / 不抛错 / 不重试） |
| `src/core/updater.test.ts` | 降级契约（不可用 ⇒ disabled，不抛异常） |

## 3. 修改文件

| 文件 | 改动 |
|---|---|
| `src/config/manager.ts` | 新增 `cloud` 配置段 + `updateCloudConfig()`；`mergeConfig` 兼容老配置 |
| `src/main/index.ts` | `initCloudServices()`、6 个新 IPC、启动轮询 + 心跳、退出停表 |
| `src/main/preload.ts` | 暴露 8 个新 API（`getUpdateState` / `checkForUpdate` / `downloadUpdate` / `installUpdate` / `onUpdateState` / `updateCloudConfig` / `reportFalsePositive`） |
| `src/renderer/pages/Settings.tsx` | 插入新卡片 + 开发态默认配置补 `cloud` 段 |
| `src/renderer/pages/Alerts.tsx` | 误报标记成功后触发上报 |
| `src/renderer/components/Dashboard/AlertDrawerContent.tsx` | 同上 |
| `locales/*/settings.json` × 5 | 新增 `cloud` 段 28 键 |
| `locales/*/alerts.json` × 5 | 新增 `page.false_positive_upload_confirm` |

---

## 4. 隐私口径

| 项 | 处理 |
|---|---|
| 账号 / 用户名 / 通知配置 token / webhook / 文件路径 / 主机名 | **一律不发**（客户端白名单 + 服务端白名单双层） |
| 坐标（纬度经度） | **发**（用户已明确授权） |
| IP | **发**（服务端从 XFF 取，客户端从不发送） |
| `client_id` | 本地生成的随机 UUID v4，**不派生**自硬件/用户信息 |
| 误报快照 | 只在用户明示同意后上报，可随时关闭 |

---

## 5. 验证记录

```bash
npx tsc --noEmit -p tsconfig.json          # 0 错
npx tsc --noEmit -p tsconfig.electron.json  # 0 错
npx vitest run                              # 468 通过（35 个文件，新增 24 个）
npm run electron:build                      # esbuild 通过，electron-updater 未被打进 bundle
```

- **端到端联调**：真实 `CloudClient` → 真实 `CloudServer`，
  误报与心跳均落盘、服务端正确注入 `_schema/_ip/_ts`、
  故意塞入的 `telegram_token` **未落盘**
- **渲染验证**：浏览器打开 `/settings`，新卡片文案全部命中字典（无裸键、无崩溃）
- **打包路径核对**：现有 `app.asar` 内含 `node_modules/electron-updater/out/*`
  且**不含** `node_modules/electron` ⇒ 生产环境 `require('electron')` 命中内置模块

---

## 6. 踩坑记录

**开发态 `require('electron')` 命中 npm shim（一个路径字符串）而不是 Electron 内置模块**
⇒ `require('electron-updater')` 在模块加载期就抛
`Cannot read properties of undefined (reading 'getVersion')`。

铁律：**必须在 `app.isPackaged` 判断之后才加载 electron-updater**；
开发态直接判定 `disabled`（理由 `dev_mode`），不抛异常、不影响监控主职。

---

## 7. 变更：云端地址与更新源改为后台固定（2026-11-13）

### 为什么

设置页原来把 `endpoint`（云端地址）和 `updateFeedUrl`（更新源）交给用户填。问题：

1. **填错一个字符 ⇒ 上报静默全失败** —— `CloudClient.report()` 刻意不抛错、不记日志
   （上报失败绝不能影响监控主职），用户永远发现不了自己填错了
2. **旧值会永久污染** —— 老版本用「留空」表示关闭上传，配置文件里存着 `endpoint: ""`，
   云端上线后这个空串会让上报一直失效
3. **可被诱导指向第三方** —— 这是数据外流口子
4. 这两个地址本来只有「部署事实」一个正确答案

### 改了什么

| 位置 | 改动 |
|---|---|
| `src/config/manager.ts` | 新增导出常量 `CLOUD_ENDPOINT = 'https://cloud.dishywarden.com'`、`UPDATE_FEED_URL = ''`（云端暂无发布通道）；`DEFAULT_CONFIG.cloud` 用它们 |
| `mergeConfig()` | `endpoint` / `updateFeedUrl` 放在 spread **之后**强制覆盖 ⇒ 老配置存着空串或错地址也能自愈 |
| `updateCloudConfig()` | 只接受 `clientId` / `feedbackEnabled` / `checkIntervalHours`；渲染层传 endpoint 一律不采纳（防篡改渲染层） |
| `src/main/index.ts` | IPC `update-cloud-config` 参数类型同步收窄 |
| `UpdateFeedbackCard.tsx` | 删掉两个输入框 + 相关本地状态；保存只送 `{ feedbackEnabled }` |
| `locales/*/settings.json` | 删 6 个键（`endpoint_*` / `feed_*`）；`status_disabled` 措辞从「未配置更新源」改为「更新通道未开放」（现在不是"用户没配"，是后台还没有发布通道） |

隐私口径**不变**：`feedbackEnabled` 默认 `false`，误报上报仍需用户显式开启且首次弹确认框。

### 验证

- 单测：配置 6 例（含「老配置空 endpoint 自愈」「updateCloudConfig 不采纳 endpoint」）
- 全量 35 文件 485 测试全过；tsc 双配置 0 错误
- 真机：重启后 `config.json` 的 `endpoint` 从 `""` 自动变成
  `https://cloud.dishywarden.com`，`clientId` 保留、`feedbackEnabled` 仍为 `false`；
  `https://cloud.dishywarden.com/healthz` 实测 HTTP 200
- 设置页实测：卡片只剩「版本 / 状态 / 检查更新 / 上报开关 / 保存」，不再有云端地址与更新源两个输入框
