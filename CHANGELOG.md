# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的格式，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **1.0.0 是首个公开发行版。** 本文件只记录公开发行后的变更；
> 公开发行之前的迭代过程不进入本仓库。

---

## [1.0.0] — 2026-11-15

首个公开发行版。

### 新增

- **实时监控仪表盘** —— 连接状态条、六张指标卡（延迟 / 吞吐 / 丢包 / SNR / 遮挡 / 在线时长），
  状态用条码状竖条呈现（24h → 48 块切片，最差状态优先聚合）
- **遮挡分布图** —— 终端视野遮挡地图与方位角展示
- **告警体系** —— 断线 / 高延迟 / 高丢包 / 低 SNR / 数据陈旧等多类告警，
  支持 Webhook（通用模板）、Telegram、邮件三种通知渠道
- **网络探针** —— ICMP Ping（本地网关 + 公网）、DNS 解析、DNS 双轨归因、
  TLS 探测；探针节点可增删改、独立配置目标与间隔
- **DNS 双轨归因** —— 同时用基准 DNS 与用户态 DNS 解析同一域名，
  区分「本地解析器故障」与「上游 DNS 故障」
- **首次安装引导页** —— 采集失败且本地无历史数据时，展示设备连接排查向导
  而非白屏；含重试连接、目标地址显示、四项排查清单
- **历史数据** —— SQLite 持久化遥测与告警，重启不丢
- **多语言** —— 简体中文 / English / 日本語 / 한국어 / Tiếng Việt 五种界面与文档
- **应用内自动升级**（Windows）—— 基于 `electron-updater`，
  升级清单与产物托管在 GitHub Releases
- **Prometheus 导出** —— `/metrics` 端点供外部抓取

### 已知限制

- **macOS 不支持自动升级** —— 应用未签名（无 Apple Developer 证书），
  Squirrel.Mac 校验签名不可靠。macOS 用户通过下载 dmg 手动安装更新。
- **macOS 包未签名 / 未公证** —— 首次打开需在「系统设置 → 隐私与安全性」中放行。
- **自动升级仅 Windows** —— Linux 与 macOS 只提供手动下载安装包。

### 分发

- Windows：`DishyWarden-Setup-1.0.0.exe`（NSIS，per-machine，需管理员权限）
- macOS：`DishyWarden-1.0.0-mac-arm64.dmg` / `DishyWarden-1.0.0-mac-x64.dmg`
- 每个产物旁附 `sha512` 校验值
