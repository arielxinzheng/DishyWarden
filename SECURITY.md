# Security Policy

## 支持的版本

| 版本 | 支持 |
|---|---|
| 1.0.x | ✅ |
| < 1.0 | ❌ |

## 报告漏洞

**请不要开公开 issue**（包括 GitHub Security Advisory 的公开部分）。

用 GitHub 的 **Private vulnerability reporting**（仓库页 → Security →
Report a vulnerability）。若该功能未启用，请通过下面的私密渠道联系。

报告时请附上：

- 受影响版本（应用版本号在「设置」页右下角）
- 复现步骤
- 你的系统版本（Windows 版本号 / macOS 版本 / 发行版 + 内核）
- 尽可能多的日志（`设置` 页有导出日志的入口；主进程日志在
  `%APPDATA%\DishyWarden\logs\` 或 `~/Library/Application Support/DishyWarden/logs/`）

我们会在 **7 天内**回复确认，评估后给出修复计划。

## 本项目已知的隐私边界

这些是**设计约束**，不是漏洞 —— 但如果你发现它们被绕过，请按上面的方式报告。

### 上报白名单（两端强制）

客户端只上报白名单字段，服务端再过滤一次。两端都强制，任一端改动都不会
让未授权数据流出去。

**会报的：**

| 字段 | 说明 |
|---|---|
| `client_id` | 安装时生成的本地随机 UUID v4，**不是**硬件指纹 |
| `app_version` | 应用版本号 |
| `platform` | 操作系统 |
| `type` | 事件类型（`upgrade_check` / `upgrade_download` / `upgrade_install` / `upgrade_heartbeat` / `alert_false_positive`） |
| `result` / `ok` / `error` / `to_version` / `latest_version` | 升级结果 |
| `alert_key` / `severity` / `title` / `evidence` / `note` | 误报样本（**仅在用户显式开启「上报告警误报样本」后**） |

**永不报的：**

账号、token、密码、文件路径、主机名、MAC 地址、地理位置坐标、真实 IP。

> 坐标与 IP 在**服务端**会被上报（用于限流与位置相关的分析），
> 但它们不会由客户端主动提交 —— 服务端从连接里取。

### 误报上报是 opt-in

「上报告警误报样本」开关**默认关闭**。用户不开启就不会有任何误报数据离开本机。
不要翻转这个默认值。

### 升级通道

升级清单托管在 GitHub Releases。客户端从 `build.publish` 与
`UPDATE_FEED_URL` 两处取地址，两处必须同时指向同一个 Release。

## 安装包未签名

Windows 安装器与 macOS dmg **都没有代码签名**：

- Windows 会弹 SmartScreen 警告（per-machine 安装还需要一次 UAC 提权）
- macOS 首次打开需要右键 → 打开

这是已知限制，不是漏洞。**不要**为绕过它而关闭系统安全检查。

## 依赖

原生模块 `sql.js` 锁在 Electron 33 的 ABI 上（NODE_MODULE_VERSION 130）。
仓库有守卫脚本 `scripts/guard-native-modules.mjs`，在 CI 与打包前检查
原生模块是否被错误覆盖（x64 模块覆盖 arm64 会让历史库**静默**写不进去）。

## 支持的安全相关文档

- [隐私政策](./PRIVACY.md)（含 5 语言版本）
- [贡献指南](./CONTRIBUTING.md)
