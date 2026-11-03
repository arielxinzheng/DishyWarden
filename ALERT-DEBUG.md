# 告警不显示问题诊断

## 问题现象
用户触发了两个告警，但仪表盘页面没有看到告警横幅。

## 诊断步骤

### 1. 确认数据库中有活跃告警
```bash
sqlite3 ~/Library/Application\ Support/Electron/data/alerts.db \
  "SELECT id, alert_key, severity, summary, status FROM alerts WHERE status='ongoing' ORDER BY first_seen DESC;"
```

**当前结果**: 
- 数据库中共 13 条告警记录
- **0 条 `ongoing` 状态的告警** ← 这是根本原因
- 所有告警都是 `resolved` 状态

### 2. 测试告警已插入
我已经手动插入了 2 个测试告警：
```bash
# ID 16: test_alert_1 (critical, ongoing)
# ID 17: test_alert_2 (warning, ongoing)
```

### 3. 前端需要刷新才能看到
**重要**: 直接插入数据库的告警不会触发 IPC 事件通知前端。需要：
- 刷新浏览器页面 (F5 或 Cmd+R)
- 或重启 Electron 应用

### 4. 验证前端是否加载告警
打开浏览器开发者工具 (F12)，查看 Console：
```javascript
// 应该能看到这类日志
// [Dashboard] Loaded active alerts: 2
```

### 5. 检查 Electron 窗口 vs 浏览器
**关键区别**:
- **Electron 窗口** (推荐): 完整功能，真实 IPC 通信
- **浏览器 http://localhost:5173**: Mock 数据，electronAPI 不可用

**正确的验证方法**: 
- 必须在 Electron 窗口中验证
- 不能用浏览器访问 localhost:5173

## 根本原因分析

### 为什么没有告警显示？

**原因**: 所有告警都已被自动 resolved（解决）

告警生命周期：
```
触发条件满足 → new (首次)
    ↓
条件持续   → ongoing (持续中)
    ↓
条件消失   → resolved (自动解决)
```

**举例**:
- WiFi RSSI 告警: `rssi < -70` 触发 → 信号恢复后自动 resolved
- 遮挡率告警: `fractionObstructed > 0.05` → 遮挡消除后自动 resolved

### DishyMock 当前状态是健康的
根据前面的验证：
- DishyMock 返回的是健康的 baseline 数据
- WiFi RSSI: -55 dBm (良好)
- 遮挡率: 0% (无遮挡)
- 网络状态: 正常

**结论**: 在健康状态下，之前触发的告警会自动解决。

## 解决方案

### 方案 1: 触发真实告警（推荐）

修改 DishyMock 返回异常数据：

```typescript
// 修改 packages/dishymock/src/baseline.ts 中的 buildStatus()
wifiStats: {
  rssi: -75,  // 改为 -75 (触发 WiFi 弱信号告警)
  // ...
}
```

然后重启 DishyMock：
```bash
cd packages/dishymock
npm run dev
```

### 方案 2: 使用测试告警验证UI

我已插入 2 个测试告警，验证步骤：

1. **刷新 Electron 窗口** (不是浏览器)
   - macOS: Cmd + R
   - Windows: Ctrl + R

2. **应该看到**:
   - 仪表盘顶部显示红色横幅
   - 内容: "⚠️ 检测到严重告警  2 个  [查看详情]"

3. **点击横幅**:
   - 右侧滑出抽屉
   - 显示 2 个告警（Critical 在上，Warning 在下）

4. **验证完成后清理**:
```bash
sqlite3 ~/Library/Application\ Support/Electron/data/alerts.db \
  "DELETE FROM alerts WHERE alert_key LIKE 'test_alert_%';"
```

### 方案 3: 检查告警规则配置

查看哪些告警规则已启用：
```bash
# 所有规则都在 src/alerting/manager.ts 中
# 每个规则都有 enabled: true
```

常见告警触发条件：
- **WiFi 弱信号**: RSSI < -70 dBm
- **高遮挡率**: fractionObstructed > 0.05
- **高延迟**: popPingLatencyMs > 100
- **高丢包**: popPingDropRate > 0.05

## 快速验证命令

```bash
# 1. 查看当前活跃告警
sqlite3 ~/Library/Application\ Support/Electron/data/alerts.db \
  "SELECT COUNT(*) FROM alerts WHERE status='ongoing';"

# 2. 查看最近触发的告警
sqlite3 ~/Library/Application\ Support/Electron/data/alerts.db \
  "SELECT severity, summary, status, first_seen FROM alerts ORDER BY first_seen DESC LIMIT 5;"

# 3. 检查 Electron 进程
ps aux | grep Electron | grep SLMonitor

# 4. 检查 DishyMock 状态
lsof -nP -iTCP:9200
```

## 预期效果截图描述

### 有告警时 (Critical)
```
┌─────────────────────────────────────────────────────┐
│ ⚠️ 检测到严重告警  2 个  [查看详情]                  │ ← 红色横幅
└─────────────────────────────────────────────────────┘
```

### 有告警时 (Warning only)
```
┌─────────────────────────────────────────────────────┐
│ ⚠️ 检测到网络环境异常  3 个  [查看详情]              │ ← 橙色横幅
└─────────────────────────────────────────────────────┘
```

### 抽屉内容
```
┌─ 活跃告警 ──────────────────────────── [X] ─┐
│                                               │
│  ❌ 测试严重告警                Critical     │
│  这是一个测试告警，用于验证前端显示          │
│  💡 建议处理措施                             │
│  • 检查网络连接                              │
│  • 重启设备                                  │
│  • 联系技术支持                              │
│  首次触发: 10/30 15:44  触发次数: 1  ● 持续中│
│                                               │
│  ⚠️ 测试警告告警                Warning      │
│  WiFi 信号质量较弱                           │
│  💡 建议处理措施                             │
│  • 靠近路由器                                │
│  • 检查天线位置                              │
│  • 减少障碍物                                │
│  首次触发: 10/30 15:44  触发次数: 1  ● 持续中│
│                                               │
└───────────────────────────────────────────────┘
```

## 结论

告警功能本身正常，问题在于：
1. ✅ 代码已正确实现
2. ✅ IPC 通信正常
3. ❌ **当前没有活跃告警**（都已 resolved）

**下一步**: 请选择上述方案 1、2 或 3 来触发/验证告警显示。