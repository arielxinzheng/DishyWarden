# 采集器心跳告警功能

## 变更时间
2026-10-30

## 变更类型
feat: 新增采集器心跳失联告警

## 问题描述

用户在 DishyMock 触发本地 API 异常后，SLMonitor 页面没有显示任何告警。

**根本原因**：
1. 现有告警引擎只检查**成功获取的遥测数据**字段（如 `state`, `latency`, `snr` 等）
2. 当数据采集失败时（gRPC 连接超时、网络断开等），`collector.on('error')` 只记录日志，**不触发告警检查**
3. 没有针对「数据采集失败」本身的告警规则

**症状**：
- DishyMock 进程停止 → gRPC 9200 端口拒绝连接
- Collector 持续报错：`Failed to collect data: Starlink 设备连接超时 (10s)`
- 页面没有任何告警提示，用户无法感知设备连接异常

## 解决方案

### 设计原则

**独立规则，不混淆语义**：
- `dish_offline`：天线设备状态为离线（`state !== 'ONLINE'`）—— 设备连上了但没搜到卫星
- `collector_heartbeat_lost`：**采集器连续 N 分钟无法获取数据** —— 根本连不上设备

两者根因完全不同：
- `dish_offline` → 检查天线对准、遮挡、天气、卫星覆盖
- `collector_heartbeat_lost` → 检查电源、网线、gRPC 端口、防火墙、进程状态

### 实现细节

#### 1. 告警引擎新增心跳规则

**文件**: `src/alerting/manager.ts`

**新增字段**：
```typescript
private lastCollectorSuccess: Date | null = null;  // 最后成功采样时间
private heartbeatStartTime: Date = new Date();     // 心跳检查启动时间
private heartbeatInterval?: NodeJS.Timeout;
```

**新规则**: `collector_heartbeat_lost`
- **触发条件**: 采集器连续 3 分钟未成功采样
- **检查逻辑**: 
  - 如果 `lastCollectorSuccess` 存在，检查距今是否超过 3 分钟
  - 如果 `lastCollectorSuccess` 为 null（启动后从未成功），检查距 `heartbeatStartTime` 是否超过 3 分钟
- **检查频率**: 每 30 秒检查一次
- **告警级别**: `critical`
- **推荐操作**:
  - 检查 Starlink 设备是否开机、网线是否连接
  - 确认设备 IP 地址和 gRPC 端口 (默认 9200) 配置正确
  - 检查防火墙是否阻止 gRPC 连接
  - 查看采集器日志确认具体错误信息
  - 如果是 DishyMock 测试环境，确认 mock 进程正在运行

**关键方法**：
```typescript
// checkTelemetry() 中更新心跳
async checkTelemetry(telemetry: TelemetryData): Promise<void> {
  this.lastCollectorSuccess = new Date(); // 每次成功采样更新时间
  // ...
}

// 启动心跳检查
startHeartbeatCheck(timeoutMinutes = 3, checkIntervalMs = 30000): void {
  this.heartbeatInterval = setInterval(async () => {
    await this.checkCollectorHeartbeat(timeoutMinutes);
  }, checkIntervalMs);
}

// 心跳检查逻辑
private async checkCollectorHeartbeat(timeoutMinutes: number): Promise<void> {
  const referenceTime = this.lastCollectorSuccess || this.heartbeatStartTime;
  const minutesSinceSuccess = (now.getTime() - referenceTime.getTime()) / 60000;
  
  if (minutesSinceSuccess >= timeoutMinutes) {
    // 触发告警
  } else {
    // 解除告警（如果存在）
  }
}
```

**调用点**：
```typescript
// src/main/index.ts
alertManager = new AlertManager(config.notifications, config.alertThresholds);
alertManager.startUpdateNotificationCheck(60000);
alertManager.startHeartbeatCheck(3, 30000); // 3 分钟超时，30 秒检查一次
```

#### 2. Prometheus 指标导出

**文件**: `src/collector/exporter.ts`

**新增指标**：
```
# 最后成功采样的 Unix 时间戳（秒）
starlink_collector_last_success_timestamp 1730275200

# 总采样数（成功+失败）
starlink_collector_samples_total 100

# 失败采样数
starlink_collector_samples_failed_total 5
```

**实现**：
```typescript
const stats = this.collector.getStats();
const lastSuccessTs = stats.lastSuccessTime 
  ? Math.floor(stats.lastSuccessTime.getTime() / 1000) 
  : 0;

addMetric('starlink_collector_last_success_timestamp', lastSuccessTs, 
  'Unix timestamp of last successful data collection (0 if never succeeded)', 'gauge');
addMetric('starlink_collector_samples_total', stats.totalSamples, 
  'Total number of samples collected', 'counter');
addMetric('starlink_collector_samples_failed_total', stats.failedSamples, 
  'Total number of failed sample attempts', 'counter');
```

#### 3. Prometheus 告警规则

**文件**: `src/main/prometheus.ts`

**新增规则**：
```yaml
# 采集器心跳失联（3 分钟未更新）
- alert: StarlinkCollectorHeartbeatLost
  expr: (time() - starlink_collector_last_success_timestamp) > 180
  for: 1m
  labels:
    severity: critical
  annotations:
    summary: "Collector heartbeat lost"
    description: "No successful data collection for {{ $value | humanizeDuration }} (threshold: 3 minutes)"

# 采集器指标缺失（备用规则，检测 exporter 完全下线）
- alert: StarlinkCollectorAbsent
  expr: absent(starlink_collector_last_success_timestamp)
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "Collector metrics absent"
    description: "Starlink collector metrics are not being scraped"
```

**规则说明**：
- `StarlinkCollectorHeartbeatLost`: 检测 exporter 在线但数据采集失败（指标存在但过期）
- `StarlinkCollectorAbsent`: 检测 exporter 完全离线（指标不存在，可能是主进程崩溃）

## 变更文件清单

- `src/alerting/manager.ts`: 新增心跳检查逻辑和 `collector_heartbeat_lost` 规则
- `src/collector/exporter.ts`: 新增采集器健康指标导出
- `src/main/prometheus.ts`: 新增 Prometheus 告警规则
- `src/main/index.ts`: 启动心跳检查

## 验证方法

### 1. 手动触发场景

**停止 DishyMock**:
```bash
pkill -f DishyMock
```

**预期结果**（3 分钟后）:
- Electron 日志: `[AlertManager] Collector heartbeat lost: 3.0 minutes since last success`
- 告警数据库: 
  ```sql
  SELECT * FROM alerts WHERE alert_key='collector_heartbeat_lost:starlink';
  ```
  显示 `status='ongoing'`
- 前端页面: 告警抽屉显示「数据采集器失联」告警

**恢复 DishyMock**:
```bash
npm run dev  # 在 DishyMock 目录
```

**预期结果**（下一个采样周期）:
- 日志: `[AlertManager] Collector heartbeat restored`
- 告警状态: `status='resolved'`

### 2. Prometheus 指标验证

```bash
curl http://localhost:9817/metrics | grep collector
```

**正常运行时**:
```
starlink_collector_last_success_timestamp 1730275200
starlink_collector_samples_total 100
starlink_collector_samples_failed_total 5
```

**采集失败时**（3 分钟后 Prometheus 应触发告警）:
```bash
curl http://localhost:9090/api/v1/alerts | jq '.data.alerts[] | select(.labels.alertname=="StarlinkCollectorHeartbeatLost")'
```

### 3. 端到端集成测试

1. 启动 SLMonitor 和 DishyMock
2. 确认正常采样：`tail -f /tmp/slmonitor.log | grep "Sample"`
3. 停止 DishyMock: `pkill -f DishyMock`
4. 等待 3.5 分钟
5. 检查告警:
   - 数据库: `sqlite3 ... "SELECT * FROM alerts WHERE alert_key LIKE '%collector%';"`
   - 日志: `grep -i heartbeat /tmp/slmonitor.log`
   - 前端: 打开告警抽屉查看

## 与现有告警的对比

| 告警 ID | 触发条件 | 根因 | 处置动作 |
|--------|---------|-----|---------|
| `dish_offline` | `state !== 'ONLINE'` | 天线搜不到卫星 | 检查天线对准、遮挡、天气 |
| `collector_heartbeat_lost` | 连续 3 分钟无法采样 | gRPC 连接失败 | 检查电源、网线、端口、进程 |
| `router_offline` | `connectedRouterCount < 1` | 路由器离线 | 检查路由器电源和连接 |
| `high_latency` | `popPingLatencyMs > 100` | 网络拥塞或弱信号 | 优化天线位置或等待 |

## 配置参数

**心跳超时时间**（默认 3 分钟）:
```typescript
// src/main/index.ts
alertManager.startHeartbeatCheck(3, 30000);
//                                ^
//                                修改这里调整超时分钟数
```

**检查频率**（默认 30 秒）:
```typescript
alertManager.startHeartbeatCheck(3, 30000);
//                                   ^^^^^
//                                   修改这里调整检查间隔（毫秒）
```

**Prometheus 告警阈值**:
```yaml
# src/main/prometheus.ts
expr: (time() - starlink_collector_last_success_timestamp) > 180
#                                                             ^^^
#                                                             修改这里（秒）
```

## 已知限制

1. **首次启动延迟**: 应用启动后 3 分钟内，如果从未成功采样，也会触发告警
   - **设计意图**: 确保部署错误配置（如错误的 IP/端口）能被快速发现
   - **特例**: 正常启动时天线需要 5-10 分钟搜星，但 gRPC 端口应立即可达，不会误报

2. **时间精度**: 心跳检查每 30 秒执行一次，实际触发时间可能在 3:00 ~ 3:30 之间

3. **无自动恢复**: 告警需要等待下一次成功采样才会自动解除，不支持「尝试重连 N 次后解除」

## 后续优化方向

1. **可配置化**: 将超时时间和检查频率移到 `config.json`
2. **分级告警**: 
   - 1 分钟无数据 → `warning`
   - 3 分钟无数据 → `critical`
3. **通知去重**: 持续失联时，避免重复发送相同通知
4. **Grafana 仪表盘**: 添加采集器健康状态面板

## 参考

- 告警引擎设计: `DEVELOPMENT-STATUS.md`
- Prometheus 集成: `README.md` - Prometheus 章节
- 告警抽屉 UI: `CHANGELOG-alert-drawer.md`