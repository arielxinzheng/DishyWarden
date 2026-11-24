# DishyWarden

**面向星链终端的开源监控工具** —— 一款桌面应用，通过终端的本地 gRPC 接口取数，
把原始数字变成能直接用的结论，并在出问题的第一时间告诉你。

> 数据默认只留在你的机器上。可选的云端通道只传匿名版本号和**需你手动同意**的误报反馈
> —— 详见[隐私说明](#-隐私说明)。

---

## 🌟 为什么选 DishyWarden？

星链监控如今通常是两种形态：绑定账号的官方应用，或者把遥测数据放在别人服务器上的
网页仪表盘。DishyWarden 是第三条路：

- **本地优先，不绑定账号。** 每个采样都落在你机器上的 SQLite 里。不登录 Starlink
  账号、不依赖云端 —— 仅有的两条出站通道在 [PRIVACY.md](PRIVACY.md) 里逐字段列明。
- **告警是主角，不是附属品。** 28 条内置规则覆盖连通性、信号、硬件与天气，经
  Telegram 或 Webhook 投递；断网期间产生的告警由离线队列在恢复后补发。
- **告诉你坏在哪一层。** 三种探针（ICMP / DNS / TLS）+ 逐跳解析的路由链路图，
  区分终端、路由器、解析器和链路的故障 —— DNS 双轨探测还能分清
  「本地解析器坏了」和「上游 DNS 坏了」。
- **开源可审计。** MIT 许可 —— 跑在你终端上的每一行代码都可以自己读。
- **匿名反馈反哺规则。** 标记一次误报（需同意），所有人都能受益于调优后的规则。
- **融入你的技术栈。** Prometheus 导出 + 现成 Grafana 看板、五种界面语言、
  Windows 自动更新。

---

## 📸 截图

| 仪表盘 | 遮挡图 |
|---|---|
| ![仪表盘](docs/screenshots/dashboard.png) | ![遮挡图](docs/screenshots/obstruction.png) |

> 截图取自真实运行会话，非示意图。

---

## ✨ 能做什么

**实时监控**

- 信号强度、延迟、丢包、吞吐、在线率 —— 每 30 秒采样一次，本地存进 SQLite
- 卫星雷达：真实 TLE + SGP4 推算、极坐标雷达图，并估算波束指向的服务卫星
- 天空遮挡图：WebGL 半球投影，给出遮挡百分比、遮挡等级、主要遮挡方向与变化趋势
- 对准页面：方位角 / 俯仰角，辅助手动调星

**有意义的告警**

- **28 条内置规则** —— 天线离线、PoP 延迟、严重丢包、视野遮挡、过热降频、
  对准异常、电机故障、GNSS 异常、结冰加热、PoE/电源、路由器离线、频繁断线重连、
  WiFi 信号、恶劣天气、账号异常、设备漫游…… 以及更多
- 两种投递通道：**Telegram**、**Webhook**（支持模板变量与可复用载荷模板）
- 离线队列：断网期间产生的告警会在恢复后补发
- 探针抑制：由探针失败引发的告警不会重复触发

**网络洞察**

- 路由跟踪 + 逐跳链路图（Windows 的 `tracert` 输出按列解析）
- 探针节点支持三种探针类型 —— **ICMP**、**DNS**、**TLS** —— 用来区分是终端、
  路由器还是链路的问题
- Prometheus 指标导出 + 现成的 Grafana 看板

**定位**

- 终端位置采用三级回落链：终端 GPS → 浏览器定位 → IP 粗略定位

**为长期维护而设计**

- 界面支持 5 种语言：English、简体中文、日本語、한국어、Tiếng Việt
- 配置存于普通 JSON；遥测与告警存于本地 SQLite

---

## 🚀 快速开始

需要 **Node.js 20+**，以及一台你能连上的终端。

```bash
git clone %REPO_URL%.git
cd %REPO%
npm install
npm run dev
```

`npm run dev` 会同时启动 Vite 开发服务器和 Electron。窗口加载的是
`http://localhost:5173` 上的渲染层；**请在 Electron 窗口里验证功能** ——
浏览器版本只有 mock 数据。

### 连接你的终端

DishyWarden 走终端的**本地 gRPC 接口**：

| 端口 | 传输 | 作用 |
|---|---|---|
| `9200` | 原生 gRPC | 主用 |
| `9201` | grpc-web | 兜底 —— 部分固件在 9200 上会回 `UNIMPLEMENTED` |

终端不会把这个接口暴露到局域网，所以通常需要在本机跑一个**本地桥接**
（例如 `dishylink` 这类工具）转发到终端，再在 **设置 → 终端连接** 里填地址和端口。

---

## 🏗️ 从源码构建

```bash
npm ci
npm run build          # 渲染层 + 主进程 + electron-builder
npm run build:win      # 只出 Windows NSIS 安装包
```

| 产物 | 说明 |
|---|---|
| `release/` | 打包输出目录（electron-builder target） |
| `release/DishyWarden-Setup-<version>.exe` | Windows 安装包，per-machine（需管理员权限），引导式安装 |

提交前建议跑一遍：

```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.electron.json
npm test               # vitest
npm run lint
```

---

## 📥 安装正式版

从[发布页](%REPO_URL%/releases)下载最新产物：

| 平台 | 文件 |
|---|---|
| Windows x64 / arm64 | `DishyWarden-Setup-<version>.exe`（NSIS，per-machine） |
| macOS arm64 / x64 | `DishyWarden-<version>-<os>-<arch>.dmg` |

**Homebrew（macOS）：**

```bash
brew tap arielxinzheng/cask
brew trust arielxinzheng/cask
brew install --cask dishywarden
```

cask 里带的是已发布镜像的校验和，Homebrew 会自动核对下载。

> **产物未做代码签名。** Windows 会弹出 SmartScreen 警告
> （"Windows 已保护你的电脑"）—— 点"更多信息 → 仍要运行"；macOS 会隔离该应用
> —— 右键点 `.dmg` 选"打开"，或执行
> `xattr -dr com.apple.quarantine /Applications/DishyWarden.app`。
> 每个产物旁边都发布了 `sha512`，请自行核对。

升级由 [electron-updater](https://github.com/electron-userland/electron-builder)
经清单 `%FEED_URL%` 投递；应用启动时检查一次，之后约每 12 小时一次，
网络不可用时静默降级。

自动升级目前**仅支持 Windows**。macOS 请从发布页下载新的 `.dmg` 手动替换。

---

## 📋 系统要求

| | |
|---|---|
| 操作系统 | Windows 10+、macOS 11+、Linux（X11） |
| Node.js | 20+（仅开发需要） |
| 运行时 | Electron 33 · React 18 · TypeScript · Vite · Tailwind CSS 4 |
| 存储 | 遥测约每天 1 MB（30 秒采样） |

---

## 🔐 隐私说明

**除非你明确允许，你的遥测数据不会离开这台机器。**

| 数据 | 去向 | 何时 |
|---|---|---|
| 遥测、告警、设置 | 本地 SQLite / 本地 JSON | 始终，只在你机器上 |
| 升级检查（`upgrade_check` / `upgrade_heartbeat`） | `cloud.dishywarden.com` | 自动 —— 只含匿名 `client_id`、应用版本、平台和你的 IP |
| 误报反馈 | `cloud.dishywarden.com` | **仅在你同意后** —— 含告警类型、级别、标题、你的备注，以及（如果你保留）坐标 |

- `client_id` 是本机生成的随机 UUID，不来自硬件、账号或网络标识。
- 误报上传**默认关闭**，可在 *设置 → 升级与反馈* 里随时关掉。首次上传会弹窗明示
  即将发送的内容，并需要你确认。
- 云端**永远不会**收到你的账号、通知凭据（Telegram token、webhook 地址、邮箱密码）、
  文件路径或主机名。
- 服务端保留期：升级事件与反馈 90 天，访问日志 14 天。

完整条款见 **[PRIVACY.md](PRIVACY.md)**。

---

## 🧩 架构

```
src/
├── main/        Electron 主进程 —— 窗口、IPC、gRPC 客户端、升级器
├── core/        终端 gRPC 客户端、探针、路由跟踪、升级器、云端客户端
├── storage/     SQLite 持久化（遥测 + 告警）与配置
├── alerting/    规则引擎、通知分发、离线队列
├── collector/   30 秒采样循环
├── prometheus/  指标导出 + Grafana 看板
└── renderer/    React 界面（仪表盘、告警、遮挡、卫星雷达、对准、设置）
```

参与开发前值得知道的几条分层约束：

- `src/storage/types.ts` **禁止** import 原生模块 —— 渲染层会 import 它
- 改 `src/main/**`、`src/core/**`、`src/storage/**` 需要重启 Electron；
  改渲染层则热更新
- 新增界面文案必须补齐 5 种语言，i18n 键集合测试会强制校验

---

## 📚 更多文档

| 文档 | 内容 |
|---|---|
| [`docs/CLOUD-UPGRADE.md`](docs/CLOUD-UPGRADE.md) | 升级清单契约与发版流程 |

## 🛠️ 参与贡献

欢迎提 Issue 和 Pull Request —— 开发环境、提交规范与发布流程见
[CONTRIBUTING.md](CONTRIBUTING.md)。

## 📄 许可证

[MIT](LICENSE) © %YEAR% DishyWarden contributors
