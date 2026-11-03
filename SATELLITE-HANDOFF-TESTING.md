# 卫星切换检测测试计划

## 当前状态

### SLMonitor 实现（已完成）

- ✅ outageTypes.ts: Outage 类型定义和识别规则
- ✅ outageAnalyzer.ts: 分析器和统计方法
- ✅ dishGrpc.ts: getHistory() 方法
- ✅ historian.ts: 集成 outage 分析，自动检测并存储
- ✅ schema.ts: satellite_handoffs 表（保留 30 天）
- ✅ telemetryStore.ts: 写入/查询/统计方法
- ✅ 字段兼容: 支持 DishyMock 的 `triggered` 和真实设备的 `cause`

### DishyMock 状态（需要增强）

- ✅ DishHistory 接口已有 `outages?: Outage[]` 字段
- ✅ Outage 接口定义（startTimestamp / durationMs / triggered）
- ⚠️ baseline.ts 中 `outages: []`（空数组，无测试数据）

## 测试方案

### 方案 1：手动添加 outage 数据到 DishyMock

在 DishyMock 的 `buildHistory()` 方法中生成模拟的卫星切换事件：

```typescript
private buildHistory(): DishHistory {
  const r = this.ring;
  const now = Date.now();
  
  // 模拟卫星切换事件（每 2 分钟一次）
  const outages: Outage[] = [];
  for (let i = 0; i < 5; i++) {
    const ts = now - i * 120_000;  // 每 2 分钟一次
    outages.push({
      startTimestamp: ts,
      durationMs: 3000 + Math.random() * 2000,  // 3-5 秒
      triggered: i % 3 === 0 ? 'HANDOFF' : 'NO_DOWNLINK',  // 混合明确和隐式
    });
  }
  
  return {
    current: this.current,
    downlinkThroughputBps: [...r.downlinkThroughputBps],
    uplinkThroughputBps: [...r.uplinkThroughputBps],
    popPingLatencyMs: [...r.popPingLatencyMs],
    popPingDropRate: [...r.popPingDropRate],
    powerIn: [...r.powerIn],
    seconds: [...r.seconds],
    outages,  // 添加模拟数据
    eventLog: [],
  };
}
```

### 方案 2：通过 DishyMock 控制台添加

如果 DishyMock 有运行时修改 baseline 的接口，可以通过控制台动态注入。

### 方案 3：先用空数据测试代码路径

验证当 `outages: []` 时：
- ✅ getHistory() 不抛错
- ✅ analyzeOutages([]) 返回空结果
- ✅ historian 不写入数据库
- ✅ 采集器继续正常工作

## 验证清单

### 后端验证

1. **类型检查**: `npx tsc --noEmit -p tsconfig.json` ✅
2. **启动 SLMonitor**: 
   ```bash
   npm run dev
   ```
3. **检查日志**: 
   - `[Collector] getHistory 失败` → 预期（DishyMock 返回空 outages）
   - 或 `[Collector] Outage 分析: 总中断: 0`
4. **查询数据库**:
   ```sql
   sqlite3 ~/Library/Application\ Support/Electron/data/telemetry.db \
     "SELECT COUNT(*) FROM satellite_handoffs;"
   ```
   → 预期 0（因为 DishyMock 返回空数据）

### 前端验证（待实现）

- [ ] LatencyChart 显示卫星切换标记点（markLine）
- [ ] Dashboard 显示切换频率统计
- [ ] 告警：异常长的切换（> 10s）

## 下一步

1. **给 DishyMock 添加 outage 数据**（方案 1）
2. **重启 DishyMock 和 SLMonitor**
3. **验证检测和存储**：
   - 检查日志：`[Collector] 检测到 N 次卫星切换`
   - 查询数据库：`SELECT * FROM satellite_handoffs ORDER BY ts DESC LIMIT 5;`
4. **前端图表标记**（LatencyChart 集成）
5. **性能测试**：确认 getHistory 不影响 30s 采集周期