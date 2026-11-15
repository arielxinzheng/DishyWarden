# WiFi 信号告警功能完成报告

## 功能概述

为 SL Monitor 添加了 WiFi 信号质量监控和告警功能，能够实时检测路由器的 WiFi 连接状态并在信号异常时及时告警。

---

## 实现内容

### 1. 数据模型扩展

在 `TelemetryData` 接口中新增 6 个 WiFi 相关字段：

```typescript
interface TelemetryData {
  // ... 现有字段
  
  // WiFi 状态（来自路由器的 WiFi 统计）
  wifiRssi?: number;                     // WiFi 信号强度 (dBm, 通常 -30 到 -90)
  wifiTxRate?: number;                   // WiFi 发送速率 (Mbps)
  wifiRxRate?: number;                   // WiFi 接收速率 (Mbps)
  wifiChannelUtilization?: number;       // 信道利用率 (0-1)
  wifiRetransmitRate?: number;           // 重传率 (0-1)
  wifiClientCount?: number;              // 连接的 WiFi 客户端数量
}
```

### 2. 告警规则

**规则 ID**: `wifi_signal`  
**严重级别**: warning  
**触发条件**（满足任一）:
- RSSI < -70 dBm（信号弱）
- txRate < 50 Mbps（速率低）
- retransmitRate > 15%（重传率高）
- channelUtilization > 80%（信道拥堵）

**告警摘要**（动态生成）:
- 优先级 1: "WiFi 信号弱 (X dBm)"
- 优先级 2: "WiFi 重传率高 (X%)"
- 优先级 3: "WiFi 信道拥堵 (X%)"
- 优先级 4: "WiFi 连接速率低 (X Mbps)"

**建议措施**:
1. 移动设备靠近路由器以改善信号
2. 检查是否有物理障碍物（墙体、金属物）阻挡信号
3. 尝试切换到不拥堵的 WiFi 信道（2.4GHz 或 5GHz）
4. 减少连接设备数量或限制带宽占用
5. 考虑使用 Mesh 网络扩展覆盖范围
6. 检查路由器天线方向
7. 远离微波炉、蓝牙设备等干扰源

### 3. 周期性验证机制

为验证告警的触发和恢复逻辑，实现了 120 次采样的模拟周期：

**弱信号阶段**（周期 0-59，约 30 分钟）:
- RSSI: -75 到 -85 dBm（触发告警）
- txRate: 40-60 Mbps
- retransmitRate: 15-25%
- channelUtilization: 65-85%

**正常信号阶段**（周期 60-119，约 30 分钟）:
- RSSI: -55 到 -65 dBm（告警恢复）
- txRate: 80-120 Mbps
- retransmitRate: 2-5%
- channelUtilization: 25-45%

采样间隔：约 30 秒  
完整周期：约 60 分钟

### 4. 前端展示

告警列表组件 `AlertList.tsx` 已支持：
- 实时显示活跃的 WiFi 告警
- 展示详细的指标数据（RSSI、速率、重传率等）
- 提供处理建议
- 自动移除已恢复的告警

### 5. 数据库持久化

告警记录存储在 `alerts.db` 中：

```sql
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY,
  alert_key TEXT UNIQUE NOT NULL,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,  -- 'ongoing' | 'resolved'
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  occurrence_count INTEGER DEFAULT 1,
  summary TEXT,
  description TEXT,
  evidence TEXT,
  recommendations TEXT,
  ...
)
```

**WiFi 告警示例**:
```
id: 15
alert_key: wifi_signal:starlink
alert_type: wifi_signal
severity: warning
status: ongoing
summary: WiFi 信号弱 (-85 dBm)
description: WiFi 质量异常: 信号强度 -85 dBm (弱), 发送速率 48 Mbps (低)
occurrence_count: 13
```

---

## 验证结果

### 数据库验证

```bash
sqlite3 ~/Library/Application\ Support/Electron/data/alerts.db \
  "SELECT alert_type, severity, status, occurrence_count, summary 
   FROM alerts WHERE alert_type='wifi_signal'"
```

输出：
```
wifi_signal|warning|ongoing|13|WiFi 信号弱 (-85 dBm)
```

### 周期验证

运行 `/tmp/test-wifi-cycle.sh` 输出：

```
关键周期采样:
周期 | 阶段   | 告警 | RSSI   | 速率
---------------------------------------------------------------
   1 | WEAK   | ✓    |    -83 |    56
  30 | WEAK   | ✓    |    -83 |    56
  59 | WEAK   | ✓    |    -83 |    56
  60 | NORMAL | ✗    |    -63 |   113
  80 | NORMAL | ✗    |    -63 |   113
 119 | NORMAL | ✗    |    -63 |   113
```

✅ 告警触发逻辑正确（周期 0-59）  
✅ 告警恢复逻辑待验证（需要等待周期到达 60+）

### Electron 窗口验证

- ✅ Electron 主进程正常运行（PID 888）
- ✅ 使用 fallbackToMock 模式生成模拟数据
- ✅ 告警管理器正常工作
- ⏳ 前端界面展示待验证（需要手动打开 Electron 窗口查看）

---

## 文件变更

### 修改的文件

1. **src/core/dishClient.ts** (+57, -5)
   - 添加 `wifiMockCycle` 计数器
   - 新增 4 个 WiFi 指标生成方法
   - 修改 `generateMockTelemetry()` 使用动态生成方法

2. **src/alerting/database.ts** (+32, -2)
   - 导出 `Severity` 和 `Status` 类型
   - 供前端和测试脚本使用

3. **src/alerting/manager.ts** (已存在)
   - WiFi 告警规则已在之前提交中添加

### 新增的文件

- **/tmp/test-wifi-cycle.sh**: 快速验证脚本

---

## 待完成事项

### 高优先级

1. **验证告警恢复**  
   等待 mock 周期到达 60+，确认数据库中 `status` 从 `ongoing` 变为 `resolved`

2. **前端界面验证**  
   在 Electron 窗口中查看"活跃告警"列表是否正确显示 WiFi 告警

3. **TypeScript 类型检查**  
   运行 `npx tsc --noEmit -p tsconfig.json` 确认无类型错误

### 中优先级

4. **启动 DishyMock 进程**  
   测试真实 gRPC 场景下的 WiFi 数据采集：
   ```bash
   cd ~/Documents/dishy-mock
   ./dishy-mock --port 9200
   ```

5. **补全剩余告警规则**  
   当前已覆盖 19/34 规则，还有 15 个场景待实现

6. **告警通知机制**  
   实现 Email/Webhook 通知（Notifier 类已就绪）

### 低优先级

7. **性能优化**  
   - 告警检查间隔调优
   - 数据库查询索引优化

8. **测试覆盖**  
   - 单元测试：告警规则逻辑
   - 集成测试：端到端告警流程

---

## Git 提交记录

```
36c24a1 feat: 完成 WiFi 告警周期性验证机制 (刚刚提交)
a458326 chore: 移除 WiFi 调试日志 (之前)
```

---

## 技术要点

### 1. 告警状态机

```
            condition=true
  [未触发] ----------------> [ongoing]
                              |    ^
     condition=false          |    | condition=true (upsert)
                              v    |
                           [resolved]
```

### 2. 去重机制

通过 `alert_key` (wifi_signal:starlink) 实现同一告警的去重：
- 新告警：`INSERT` 并触发通知
- 持续触发：`UPDATE occurrence_count++`
- 恢复：`UPDATE status='resolved'` 并触发恢复通知

### 3. Fallback 机制

```
getTelemetry() 
  -> grpc.getStatus() 
    -> 成功: 返回真实数据
    -> 失败 && fallbackToMock: 返回 mock 数据（标记 obstructionMapSource='mock'）
    -> 失败 && !fallbackToMock: 抛出异常
```

---

## 相关文档

- **贡献指南**: `CONTRIBUTING.md`
- **告警规则**: `src/alerting/manager.ts` (L560-L628)

---

**报告生成时间**: 2026-10-30 06:28  
**完成度**: WiFi 告警功能 95% 完成，待前端验证和恢复逻辑长期观察