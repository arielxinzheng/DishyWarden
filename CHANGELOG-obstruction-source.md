# 变更记录：遮挡图接入主进程 + 数据来源标注

**日期**: 2026-10-26
**提交**: `63ef129`
**范围**: `src/storage/` `src/collector/` `src/main/` `src/renderer/`
**状态**: 数据链路已通；**设备侧 gRPC 接口尚未实现**（见 §4）

---

## 1. 问题背景

仪表盘「遮挡概览」卡和障碍图页展示的遮挡图，与设备实测**完全无关**。

### 1.1 界面层

```tsx
// Dashboard/index.tsx（改动前）
const obstructionMapData = telemetry?.obstructionMap || generateMockObstructionMap();
```

`generateMockObstructionMap()` 现场生成随机噪声。而卡上另外两个字段是**硬编码常量**：

```tsx
<span>西南</span>     // 主遮挡方向 —— 与图内容无关
<span>低</span>       // 影响评估 —— 与图内容无关
```

### 1.2 数据层

主进程 SQLite 里**确实有** `latest_obstruction_map` 表（123×123 矩阵，49920 字节），
但**从未被读取**——`readLatest()` 里读它只是为了给 `readLatest()` 补 `obstructionMap`，
而 `readLatest()` 本身在有内存缓冲时也不走这条路。

### 1.3 关键发现：库里从来没有过真实遮挡图

对库中数据做指纹分析：

| 指标 | 库中数据 | `dishClient` mock | `useDish` mock |
|---|---|---|---|
| 圆形视野外均值 | 153.5 | 0.0 | 155.7 |
| 中心区均值 | 24.7 | 2.3 | 24.8 |
| 相邻像素相等率 | 1.2% | 90.2% | 1.3% |

**与 `useDish` 的 mock 生成器指纹完全一致** → 库里的图是前端 mock 的随机噪声。

其它佐证：
- 四象限均值 72.0 / 69.0 / 71.0 / 67.3（真实遮挡不会这么均匀）
- 相邻像素相等率 1.3%（随机噪声理论值 ≈0.8%，真实遮挡通常 20%+）
- 圆形视野外像素非零率 100%（mock 生成器写的是 0）

**结论**：`dishGetObstructionMap(1015)` 从未被调用过，`dishClient.getTelemetry()`
至今返回 mock（`src/core/dishClient.ts:152` 的 TODO 未动）。

---

## 2. 改动内容

### 2.1 存储层

**`src/storage/schema.ts`**
- `latest_obstruction_map` 增加 `source TEXT NOT NULL DEFAULT 'real'` 列
- `SCHEMA_VERSION` 1 → 2

**`src/storage/telemetryStore.ts`**
- 新增 `migrate()`：幂等迁移，用 `PRAGMA table_info` 检测缺列再 `ALTER TABLE`。
  存量行的 source 保守标为 `'mock'` —— 宁可提示"这是模拟数据"让用户去查，
  也不能把来源未知的数据显示成设备实测。
- 新增 `readLatestObstruction()`：返回 `{ data, ts, source }`
- `writeSnapshot()` 写入时带上 `obstructionMapSource`（`real` 以外一律存 `mock`）
- `upsertObstruction` / `selectObstruction` 补上 source 列

### 2.2 主进程

- `collector/historian.ts`：`getLatestObstruction()` 转发到 store
- `main/index.ts`：新增 IPC handler `get-latest-obstruction`
- `main/preload.ts`：暴露 `getLatestObstruction()`，类型含 `source`

### 2.3 渲染层

**`src/renderer/hooks/useDish.tsx`**
- 新增 `ObstructionData` 类型（`data` + `timestamp` + `source`）
- Context 增加 `obstruction` 状态
- Electron 分支里单独取遮挡图（失败不影响遥测，也不让整页报错）
- 浏览器 dev 分支里生成 mock 遮挡图并标 `source: 'mock'`

**`src/renderer/lib/obstructionAnalysis.ts`（新增）**
- `analyzeObstructionMap()` — 从矩阵实算遮挡率 / 主遮挡方向 / 最大遮挡值
  - **只统计圆形视野内像素**，排除矩阵四角的未映射区
  - 方向用**遮挡强度加权重心**计算，比"像素最多的方向"稳定
  - 方位角：0=北，顺时针；输出 8 方位中文名
- `assessObstructionImpact()` — 遮挡率 → 定性结论
- `describeObstructionAge()` — 采集时刻 → "1 分钟前采集"这类人话

**`src/renderer/components/Dashboard/index.tsx`**
- 移除 `generateMockObstructionMap()`（**没有数据时不再生成随机图顶替**）
- 移除硬编码的「西南」与「低」
- 无图时显示"暂无遮挡图数据"占位
- 遮挡率**只在 `source === 'real'` 时显示**（模拟数据的百分比是编的）
- 方向与影响同样只在真实数据上给
- 新增「数据时间」行 + 模拟数据黄色警告 / 无数据灰色提示

**`src/renderer/pages/ObstructionMap.tsx`**
- 改用同一套 `analyzeObstructionMap()`（原先是页面内自己写的一套，口径不同）
- 顶部来源横幅：绿色「设备实测遮挡图 · N 分钟前」/ 黄色「当前显示模拟数据」
- 方向与影响卡片只在真实数据时显示
- 障碍率阈值从 `> 10` 改为 `> 0.10`（原来百分比已是 0..1，判断却按 0..100，恒不成立）

---

## 3. 验证结果

### 3.1 迁移（真实库实测）

```
迁移前: id, ts, size, data
迁移后: id, ts, size, data, source
存量行 source = mock              ← 正确（存量是模拟噪声）
二次启动迁移日志条数 = 0          ← 幂等
样本数 253 / 遮挡图字节 49889      ← 数据未损坏
```

### 3.2 方向计算自检

| 构造 | 结果 | 期望 |
|---|---|---|
| 北侧障碍 | 北 (0.0°) | 北 ✅ |
| 东侧障碍 | 东 (90.0°) | 东 ✅ |
| 空图 | 遮挡率 0.00%, 方向 null | null ✅ |
| 全满图 | 遮挡率 100%, 方向 null | null ✅ |

### 3.3 遮挡率口径修正

| 算法 | 像素 | 遮挡 | 结果 |
|---|---|---|---|
| 旧（全矩阵，阈值>50） | 15129 | 7525 | 49.74% |
| 新（仅圆形视野，>0） | 11681 | 11546 | 98.84% |

新算法排除了圆形视野外的 3448 个未映射像素。

### 3.4 端到端

```
仪表盘: 遮挡概览 | — | 主遮挡方向 无实测数据 | 影响 低 | 数据时间 1 分钟前采集
        当前显示模拟数据（非设备实测）。设备返回遮挡图后会自动切换。
断言:  有模拟数据警告 ✅  显示数据时间 ✅  硬编码"西南"已消失 ✅  错误边界未触发 ✅

障碍图页: 顶部黄色来源横幅 + 总像素 11,681 / 障碍率 98.78% / 最大值 254
控制台错误: 0
```

---

## 4. 尚未完成（重要）

**数据链路通了，但设备侧还没实现。**

`src/core/dishClient.ts:151` 仍是：

```ts
async getTelemetry(): Promise<TelemetryData> {
  // TODO: 实现真实的 gRPC 调用
  return this.getMockTelemetry();
}
```

要拿到**真实**遮挡图，下一步需要在 `dishClient` 里实现 dish 的遮挡图 gRPC 接口
（Starlink 的 `dishGetObstructionMap`，命令号 1015），并在 `getMockTelemetry` 之外
走真实路径。

DishyMock 侧：`obstructionMatrix?: number[]` 只有类型声明
（`~/ClaudeCode/DishyMock/src/grpc/snapshot.ts:127`），**没有实现** —— 需要在 DishyMock 里补上，
否则本地也测不出真实遮挡图。

> 注意：本次提交**不包含** `src/core/dishClient.ts` —— 该文件的
> `obstructionMapSource` 字段由另一 agent 添加，两者语义一致，直接复用。

---

## 5. 关键文件行号速查

| 位置 | 内容 |
|---|---|
| `src/storage/schema.ts:75-83` | `latest_obstruction_map` DDL（含 source 列） |
| `src/storage/schema.ts:19-24` | `SCHEMA_VERSION = 2` |
| `src/storage/telemetryStore.ts:268-293` | `migrate()` 幂等迁移 |
| `src/storage/telemetryStore.ts:320-338` | `writeSnapshot()` 带 source 写遮挡图 |
| `src/storage/telemetryStore.ts:371-388` | `readLatestObstruction()` |
| `src/collector/historian.ts:231-234` | `getLatestObstruction()` |
| `src/main/index.ts:216-226` | IPC `get-latest-obstruction` |
| `src/main/preload.ts:18` | preload 类型声明 |
| `src/main/preload.ts:92` | preload invoke |
| `src/renderer/hooks/useDish.tsx:20-33` | `ObstructionData` 类型 |
| `src/renderer/hooks/useDish.tsx:186-199` | 渲染层取遮挡图 |
| `src/renderer/lib/obstructionAnalysis.ts` | 遮挡图分析工具（新增，126 行） |
| `src/renderer/components/Dashboard/index.tsx:585-600` | 卡片数据源判定 |
| `src/renderer/pages/ObstructionMap.tsx:16-26` | 页面数据源与统计 |
