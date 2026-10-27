# SLMonitor 测试文档

## 测试框架

- **框架**: Vitest 5.0.5
- **环境**: Node.js
- **覆盖率**: V8 provider

## 运行测试

```bash
# 运行所有测试
npm test

# 交互式 UI 模式
npm run test:ui

# 生成覆盖率报告
npm run test:coverage
```

## 测试结构

```
src/
├── core/
│   ├── telemetry.ts
│   ├── telemetry.test.ts          # 格式化、异常检测、信号质量 (69 测试)
│   ├── traceroute.ts
│   └── traceroute.test.ts         # Unix/Windows 输出解析 (14 测试)
└── renderer/
    └── lib/
        ├── alertFormat.ts
        ├── alertFormat.test.ts     # JSON 容错、持续时长 (20 测试)
        ├── obstructionAnalysis.ts
        └── obstructionAnalysis.test.ts  # 遮挡图分析、方位角 (28 测试)
```

**总计**: 4 个测试文件，103 个测试用例，全部通过。

## 测试覆盖范围

### 1. `telemetry.ts` (69 测试)

**格式化函数**:
- `formatLatency`: 延迟格式化（<1ms / 1-100ms / >100ms）
- `formatBandwidth`: 带宽格式化（Kbps / Mbps）
- `formatPercentage`: 百分比格式化
- `formatDuration`: 时长格式化（秒 / 分钟 / 小时 / 天）
- `formatTimeLabel`: 时间戳转本地时间（Date / epoch / ISO / 无效值）

**信号质量判断**:
- `getSignalQuality`: SNR → 5 档质量等级
- `getSignalQualityLabel`: 中文标签映射

**遮挡严重程度**:
- `getObstructionSeverity`: 遮挡率 → 4 档严重程度
- `getObstructionSeverityLabel`: 中文标签映射

**异常检测**:
- `detectAnomalies`: 离线、高延迟、丢包、低吞吐量、遮挡检测
- 单异常、多重异常、严重程度分级（warning / critical）

### 2. `alertFormat.ts` (20 测试)

**JSON 容错解析**:
- `parseRecommendations`: 正常 JSON、空值、损坏 JSON、非数组对象
- `parseEvidence`: 正常对象、损坏 JSON、非对象类型、嵌套对象

**持续时长计算**:
- `formatAlertDuration`: 小于 1 分钟、分钟、小时、天
- 边界情况：无效时间戳、时间倒序

### 3. `obstructionAnalysis.ts` (28 测试)

**方位角转换**:
- `azimuthToDirection`: 8 方位中文名（北、东北、东、东南、南、西南、西、西北）
- 负角度归一化、超 360° 处理、边界情况四舍五入

**遮挡图分析**:
- `analyzeObstructionMap`: 空数组、全零、全遮挡
- 方向识别（东、南、西、北）
- 圆形视野过滤（四角区域不统计）
- 权重计算（高强度遮挡影响方向判断）
- NaN / Infinity 容错

**影响评估**:
- `assessObstructionImpact`: 4 档影响等级（无影响 / 低 / 中 / 高）
- 边界值测试（2% / 5% / 10%）

### 4. `traceroute.ts` (14 测试)

**Unix 输出解析**:
- 正常跳、超时跳、主机名与 IP
- 只有 IP 的情况
- 忽略标题行和空行
- 跳号不连续、空输出

**Windows 输出解析**:
- 正常跳、超时跳（中英文消息）
- IP 在方括号中
- `<1 ms` 延迟解析
- 忽略标题和尾部统计

## 测试策略

### 单元测试优先
- 覆盖纯函数逻辑层
- 不依赖 Electron / SQLite / gRPC
- 快速反馈（105ms 完成 103 个测试）

### 边界情况
- 空值 / null / undefined
- 无效输入（NaN、Infinity、损坏的 JSON）
- 边界值（恰好 1% / 5% / 15%）
- 时间倒序、负角度、超范围角度

### 容错性
- `formatTimeLabel`: 无效时间戳返回 null
- `parseRecommendations`: 损坏 JSON 当纯文本展示
- `analyzeObstructionMap`: 忽略 NaN / Infinity
- `parseTraceroute`: 超时跳标记为 null

## 测试数据

### Mock 遥测数据
```typescript
const createMockData = (overrides: Partial<TelemetryData> = {}): TelemetryData => ({
  state: 'ONLINE',
  popPingLatencyMs: 45,
  popPingDropRate: 0.01,
  downlinkThroughputBps: 50_000_000,
  fractionObstructed: 0.02,
  // ... 完整字段
});
```

### Traceroute 样本
- Unix: `1  192.168.100.1 (192.168.100.1)  1.234 ms  1.456 ms  1.789 ms`
- Windows: `1    <1 ms    <1 ms    <1 ms  192.168.100.1`
- 超时: `2  * * *` (Unix) / `2     *        *        *     请求超时。` (Windows)

## 未覆盖的模块

以下模块需要集成测试或 E2E 测试：

1. **Electron 主进程**:
   - IPC handler
   - 数据采集器（historian）
   - 告警引擎（alerting）
   - 配置管理

2. **数据存储**:
   - SQLite 写入 / 查询
   - 数据迁移（migrate）
   - 保留策略（prune）

3. **外部依赖**:
   - gRPC 连接（DishClient / DishGrpc）
   - Router 探活（ICMP / HTTP）
   - Traceroute 命令执行
   - TLE 下载

4. **React 组件**:
   - Dashboard / 指标卡
   - 图表渲染（ECharts）
   - 3D 遮挡半球

## 下一步

### 阶段 2: 集成测试（建议）
- 告警引擎 + SQLite（内存数据库）
- 数据采集器 + DishyMock
- 外发渠道测试（webhook.site）

### 阶段 3: E2E 测试（可选）
- Playwright for Electron
- 设置保存流程
- 告警触发 → 列表展示

## 持续集成

测试配置已就绪，可直接集成到 CI/CD：

```yaml
# .github/workflows/test.yml
- run: npm install
- run: npm test
- run: npm run test:coverage
```

覆盖率报告输出到 `coverage/` 目录（HTML / JSON / Text）。