# DishyWarden - 星链监控软件

基于 Electron + React + TypeScript 的开源星链终端监控解决方案。

## 功能特性

- 🎯 实时监控星链终端状态
- 📊 专业数据可视化（ECharts + WebGL 障碍图）
- 🔔 多渠道智能告警（Telegram/Email/Webhook）
- 📈 Prometheus + Grafana 集成
- 🌐 多种连接方式（本地网络/自定义gRPC/SSH隧道）
- 🌍 国际化支持（中文/英文）

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建应用
npm run build
```

## 系统要求

- Node.js >= 18
- macOS 11+ / Windows 10+ / Linux

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request！

## 真机对接相关文档

| 文档 | 内容 |
|---|---|
| [`docs/DISH-CONNECTIVITY-ISSUES.md`](docs/DISH-CONNECTIVITY-ISSUES.md) | 真机连不上：症状时间线、根因、设备实测能力清单、复现步骤、待办 |
| [`docs/HANDOFF-PROMPTS.md`](docs/HANDOFF-PROMPTS.md) | 交接提示词包（5 个自包含任务 + 通用约束 + 命令速查） |
| [`docs/DISH-API-GAPS.md`](docs/DISH-API-GAPS.md) | 与 dishylink 的逐项对比（端口、字段名、outages、路由器 API） |
| [`docs/VERIFY-DISH.md`](docs/VERIFY-DISH.md) | 远程 Windows 验证流程（PowerShell/SSH/RDP） |
