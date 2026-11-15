# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的格式，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **1.0.0 是首个公开发行版。** 之前的所有变更记录保留在
> `CHANGELOG-<主题>.md`（19 份），本文件做汇总索引。

---

## [1.0.0] - 2026-11

首个公开版。Electron 桌面应用，监控 Starlink（星链）终端。

### 新增

#### 云端能力

- **升级嗅探与匿名反馈** —— 客户端定期检查新版本；误报样本可匿名上报
  （**opt-in，默认关闭**）。服务端在 `cloud.dishywarden.com`，
  字段白名单两端强制：坐标与 IP 会报，账号/token/文件路径/主机名永不报。
  详见 [`CHANGELOG-cloud-update-feedback.md`](./CHANGELOG-cloud-update-feedback.md)

- **采集器心跳告警** —— 采集器长时间没有心跳即告警，区分「设备正常但采集器挂了」
  和「设备真挂了」。
  详见 [`CHANGELOG-collector-heartbeat.md`](./CHANGELOG-collector-heartbeat.md)

- **告警生命周期与 alerts 数据结构** —— 告警从触发到恢复的状态机，
  `first_seen` / `last_seen` / `occurrence_count` 语义明确。
  详见 [`CHANGELOG-alert-lifecycle.md`](./CHANGELOG-alert-lifecycle.md)

#### 告警引擎

- **本地告警分发引擎** —— 多通道分发（Webhook / Telegram / 邮件 / HomeAssistant），
  降噪操作（忽略 / 标误报）由主进程权威状态驱动。
  详见 [`CHANGELOG-alert-dispatcher.md`](./CHANGELOG-alert-dispatcher.md)

- **通用 Webhook 告警通道** —— 自定义模板与字段占位。
  详见 [`CHANGELOG-universal-webhook.md`](./CHANGELOG-universal-webhook.md)

- **WiFi 信号告警** / **PoE/电源异常告警**
  —— 见 [`CHANGELOG-wifi-alert.md`](./CHANGELOG-wifi-alert.md)、
  [`CHANGELOG-poe-alert.md`](./CHANGELOG-poe-alert.md)

- **两个客户端侧场景的告警覆盖** —— 补齐告警盲区。
  详见 [`CHANGELOG-client-scenario-coverage.md`](./CHANGELOG-client-scenario-coverage.md)

#### 界面

- **告警抽屉** —— 活跃告警集中查看与操作。
  详见 [`CHANGELOG-alert-drawer.md`](./CHANGELOG-alert-drawer.md)

- **校准页图形化引导** / **路由跟踪卡片折叠** / **仪表盘全链路拓扑状态链**
  —— 见 [`CHANGELOG-calibration-ui.md`](./CHANGELOG-calibration-ui.md)、
  [`CHANGELOG-route-trace-collapse.md`](./CHANGELOG-route-trace-collapse.md)、
  [`CHANGELOG-topology-chain.md`](./CHANGELOG-topology-chain.md)

- **i18n 国际化（5 语言）** —— zh-CN / en / ja / ko / vi。
  详见 [`CHANGELOG-i18n.md`](./CHANGELOG-i18n.md)

#### 数据

- **真实 dish gRPC 接入** —— 走真实协议字段，不再依赖模拟。
  详见 [`CHANGELOG-dish-grpc.md`](./CHANGELOG-dish-grpc.md)

- **从设备波束指向估算服务卫星**
  —— 见 [`CHANGELOG-serving-satellite.md`](./CHANGELOG-serving-satellite.md)

### 修复

- **告警恢复后不消失** —— proto3 零值字段缺失被误当成「沿用旧值」。
  详见 [`CHANGELOG-stale-telemetry-alerts.md`](./CHANGELOG-stale-telemetry-alerts.md)

- **遮挡图接入主进程 + 数据来源标注** —— 用户能分辨看到的是设备实测还是演示数据。
  详见 [`CHANGELOG-obstruction-source.md`](./CHANGELOG-obstruction-source.md)

- **障碍图页面的数据与图形一致性**
  —— 见 [`CHANGELOG-obstruction-consistency.md`](./CHANGELOG-obstruction-consistency.md)

- **连接状态卡走势图改用真实在线率** —— 不再使用硬编码值。
  详见 [`CHANGELOG-availability-metric.md`](./CHANGELOG-availability-metric.md)

- **路由跟踪解析器多地址跳修正**
  —— 见 [`CHANGELOG-route-trace-collapse.md`](./CHANGELOG-route-trace-collapse.md)

### 工程

- GitHub Actions CI（类型检查 + 单测 + 构建 + 文档漂移检查 + 仓库卫生门禁）
- 通用 Webhook / Telegram / 邮件 / HomeAssistant 四种通知通道
- Prometheus 指标导出 + Grafana 看板
- SQLite 本地历史库（保留策略 + 定期清理）
- 多语言 README / PRIVACY（5 语言，由 `npm run docs:generate` 生成）

### 已知限制

| 限制 | 说明 |
|---|---|
| **自动升级仅支持 Windows** | macOS 需要 `latest-mac.yml` + zip target，本次未产出 |
| 安装器未签名 | Windows SmartScreen 会警告；macOS 未公证 |
| 免安装 zip 无自动升级 | Windows 侧 electron-updater 只有 `NsisUpdater` |
| 需要真实 Starlink 终端 | 无设备时界面显示首次安装引导页 |

---

## 更早的变更记录

以下 19 份文档按主题记录了 1.0.0 之前的详细变更（含根因分析、验证过程、
踩坑记录），是本项目的完整开发史：

| 文档 | 主题 |
|---|---|
| [`CHANGELOG-alert-dispatcher.md`](./CHANGELOG-alert-dispatcher.md) | 本地告警分发引擎 |
| [`CHANGELOG-alert-drawer.md`](./CHANGELOG-alert-drawer.md) | 告警抽屉 |
| [`CHANGELOG-alert-lifecycle.md`](./CHANGELOG-alert-lifecycle.md) | 告警生命周期 |
| [`CHANGELOG-availability-metric.md`](./CHANGELOG-availability-metric.md) | 真实在线率 |
| [`CHANGELOG-calibration-ui.md`](./CHANGELOG-calibration-ui.md) | 校准页引导 |
| [`CHANGELOG-client-scenario-coverage.md`](./CHANGELOG-client-scenario-coverage.md) | 告警覆盖补齐 |
| [`CHANGELOG-cloud-update-feedback.md`](./CHANGELOG-cloud-update-feedback.md) | 升级嗅探与匿名反馈 |
| [`CHANGELOG-collector-heartbeat.md`](./CHANGELOG-collector-heartbeat.md) | 采集器心跳 |
| [`CHANGELOG-dish-grpc.md`](./CHANGELOG-dish-grpc.md) | 真实 gRPC 接入 |
| [`CHANGELOG-i18n.md`](./CHANGELOG-i18n.md) | i18n 5 语言 |
| [`CHANGELOG-obstruction-consistency.md`](./CHANGELOG-obstruction-consistency.md) | 障碍图一致性 |
| [`CHANGELOG-obstruction-source.md`](./CHANGELOG-obstruction-source.md) | 遮挡图来源标注 |
| [`CHANGELOG-poe-alert.md`](./CHANGELOG-poe-alert.md) | PoE/电源告警 |
| [`CHANGELOG-route-trace-collapse.md`](./CHANGELOG-route-trace-collapse.md) | 路由跟踪折叠与解析 |
| [`CHANGELOG-serving-satellite.md`](./CHANGELOG-serving-satellite.md) | 服务卫星估算 |
| [`CHANGELOG-stale-telemetry-alerts.md`](./CHANGELOG-stale-telemetry-alerts.md) | 告警恢复 |
| [`CHANGELOG-topology-chain.md`](./CHANGELOG-topology-chain.md) | 全链路拓扑状态链 |
| [`CHANGELOG-universal-webhook.md`](./CHANGELOG-universal-webhook.md) | 通用 Webhook |
| [`CHANGELOG-wifi-alert.md`](./CHANGELOG-wifi-alert.md) | WiFi 信号告警 |

---

## 链接

- [README](./README.md) · [贡献指南](./CONTRIBUTING.md) ·
  [行为准则](./CODE_OF_CONDUCT.md) · [安全策略](./SECURITY.md) ·
  [隐私政策](./PRIVACY.md) · [许可证 (MIT)](./LICENSE)
