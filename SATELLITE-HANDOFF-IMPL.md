# 卫星切换检测实现方案

## 当前问题

- DishyMock 的 gRPC 响应中没有返回 `satelliteId` 字段
- 数据库中所有 `satellite_id` 都是 0（回退值）
- 图表组件的卫星切换标记逻辑无法触发

## 参考资源

### 1. sparky8512/starlink-grpc-tools (Python)
- **仓库**: https://github.com/sparky8512/starlink-grpc-tools
- **关键文件**: `starlink-grpc-core.py`
- **特性**: 完整定义了所有 outage cause 类型
- **用途**: 理解 Starlink gRPC 协议的 outage 分类和卫星切换事件

### 2. danopstech/starlink_exporter (Go)
- **仓库**: https://github.com/danopstech/starlink_exporter
- **特性**: Prometheus/Grafana 标准组件
- **用途**: 参考如何解析 history 数组和 outages 的流式处理

## 实现方案

### 方案 1: 通过 Outage 日志反推（推荐）

卫星切换通常伴随短暂的服务中断（通常几秒），可以通过分析 `dishGetHistory` 中的 `outages` 数组来检测：

```typescript
interface Outage {
  startTimestamp: number;  // 毫秒级 epoch
  durationMs: number;
  triggered: string;       // outage cause
}
```

**关键 outage cause（需从 sparky8512 参考）：**
- `"HANDOFF"` / `"SWITCHING"` - 明确的卫星切换标记
- 短时中断（< 10s）且无其他明显原因 - 隐式切换

**实现步骤：**
1. 在 `dishGetHistory` 响应中解析 `outages` 数组
2. 按 `triggered` 字段分类中断原因
3. 识别卫星切换相关的中断类型
4. 在时间轴上标记切换点

### 方案 2: 直接从 gRPC 获取 satelliteId

如果真实设备的 `dishGetStatus` 响应中有 `satelliteId` 字段：
1. 在 `dishClient.ts` 的 `parseStatus` 中已有解析逻辑
2. 在 `historian.ts` 采集时记录
3. 数据库 `telemetry_samples.satellite_id` 已有字段
4. 图表组件已有检测逻辑

**当前阻塞**: DishyMock 未实现此字段

### 方案 3: DishyMock 模拟实现

为开发/演示环境，在 DishyMock 中模拟卫星切换：

**策略 A: 周期性切换**
- 每 15-20 秒切换一次（接近真实场景）
- satelliteId 在预定义的卫星池中轮换（如 1001-1010）

**策略 B: 配合 Outage 模拟**
- 在状态引擎中模拟切换事件
- 生成对应的 outage 记录（cause="HANDOFF", duration=2-5s）
- 同步更新 satelliteId

## 下一步行动

1. **短期（演示需求）**: 在 DishyMock 中实现 satelliteId 模拟
   - 修改 `src/state/types.ts` 的 `DishStatus` 添加 `satelliteId?: number`
   - 在状态引擎中周期性更新（15-20s 间隔）
   - 范围：1001-1050（模拟 Starlink Shell 1 的卫星编号）

2. **中期（真实数据）**: 实现 outage 解析
   - 参考 sparky8512 的 outage cause 枚举
   - 在 `dishClient.ts` 中解析 `dishGetHistory.outages`
   - 在 `historian.ts` 中检测卫星切换相关中断
   - 存储到 `telemetry_samples` 或单独的 `satellite_handoffs` 表

3. **长期（完善）**: 多数据源融合
   - 优先使用 satelliteId 变化检测（精确）
   - 回退到 outage 分析（兼容性）
   - 结合信号质量变化（SNR/延迟突变）辅助判断

## 代码改动点

### DishyMock 改动
```typescript
// src/state/types.ts
export interface DishStatus {
  // ... 现有字段
  satelliteId?: number;  // 添加
}

// src/state/engine.ts
private satellitePool = [1001, 1003, 1007, 1015, 1023, 1031, 1042];
private currentSatelliteIndex = 0;
private lastHandoffTime = 0;

private maybeHandoff(now: number): void {
  const HANDOFF_INTERVAL = 15000 + Math.random() * 10000; // 15-25s
  if (now - this.lastHandoffTime > HANDOFF_INTERVAL) {
    this.currentSatelliteIndex = (this.currentSatelliteIndex + 1) % this.satellitePool.length;
    this.snapshot.deviceState.satelliteId = this.satellitePool[this.currentSatelliteIndex];
    this.lastHandoffTime = now;
  }
}
```

### SLMonitor 改动（已就绪）
- ✅ `dishClient.parseStatus` 已解析 `satelliteId`
- ✅ `historian.ts` 已采集并存储
- ✅ `telemetryStore` 已支持字段
- ✅ `LatencyChart` 已有检测和标记逻辑

## 参考链接

- Starlink gRPC 协议逆向文档: https://github.com/sparky8512/starlink-grpc-tools/blob/main/README.md
- Prometheus exporter 实现: https://github.com/danopstech/starlink_exporter/blob/main/collector/history.go