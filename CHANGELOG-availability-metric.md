# 变更记录：连接状态卡走势图改用真实在线率

**日期**: 2026-10-26
**范围**: `src/storage/` + `src/renderer/components/Dashboard/`
**状态**: 已完成并验证（第一步）；hourly 聚合部分留作技术债

> 交接对象：接手本项目的开发 agent
---

## 1. 问题背景

仪表盘「连接状态」指标卡的迷你走势图画的是 **snr（信号质量）**，而卡片语义是「连接状态」——指标错配，用户会误以为那是连通性时序。

根因是历史数据层没有把连接状态带出来：

| 环节 | 改动前状态 |
|---|---|
| `telemetry_samples` 表 | ✅ 有 `state` 列，且 INSERT 会写入 |
| `selectRaw` / `selectBucketed` / `selectHourly` | ❌ 三个查询都没 SELECT `state` |
| `mapRow()` | ❌ 没映射 `state` |
| `HistorySample` 类型 | ⚠️ 已有 `state?: string` 字段（但没人用） |

前一个开发者在 `metricSeries.ts` 里**有意**选择了用 snr 顶替，注释写明：

> `/** 信号质量 snr。连接状态卡用它做走势 —— HistorySample 不带 state, 不编造在线率 */`

即：不是遗漏，是当时没有安全的做法（见 §4 语义问题）。

---

## 2. 已完成的改动

### 2.1 `src/storage/types.ts`

`HistorySample` 新增 `onlineRatio?: number`，并补全两个字段的语义说明：

```ts
export interface HistorySample {
  timestamp: number;
  /**
   * 该采样的连接状态(ONLINE/OFFLINE/SEARCHING/BOOTING)。
   * 只有原始明细(telemetry_samples)有真实状态值;
   * 分桶查询给出的是桶内占比语义(见 onlineRatio), 此时 state 为 undefined。
   */
  state?: string;
  /**
   * 桶内 ONLINE 采样占比 0..1。
   * 语义: 该时间桶里 state='ONLINE' 的采样数 / 桶内总采样数。
   * 仅分桶粒度(selectBucketed)产出; 明细粒度为 1 或 0, 小时聚合无此字段。
   */
  onlineRatio?: number;
  // ... 其余字段未变
}
```

### 2.2 `src/storage/telemetryStore.ts`

**`selectRaw`** — 加 `state` 列：

```sql
SELECT ts, state, latency_ms, drop_rate, down_bps, up_bps, snr,
       fraction_obstructed, satellite_id
FROM telemetry_samples
WHERE ts >= ? AND ts < ? ORDER BY ts
```

**`selectBucketed`** — 加在线率聚合列（`state` 本身不 select，因为桶内可能跨多次状态切换，给单值就是编造）：

```sql
SELECT (ts / ?) * ? AS bucket,
       AVG(latency_ms) AS latency_ms,
       ...
       AVG(CASE WHEN state = 'ONLINE' THEN 1.0 ELSE 0.0 END) AS online_ratio
FROM telemetry_samples
WHERE ts >= ? AND ts < ?
GROUP BY bucket ORDER BY bucket
```

**`selectHourly`** — **未改动**（表里没有 state，见 §4）

**`mapRow()`** — 改为按粒度产出两个字段：

```ts
const state = typeof r.state === 'string' ? r.state : undefined;

let onlineRatio: number | undefined;
if (typeof r.online_ratio === 'number' && Number.isFinite(r.online_ratio)) {
  onlineRatio = r.online_ratio;          // 分桶: 查询直接给的占比
} else if (state !== undefined) {
  onlineRatio = state === 'ONLINE' ? 1 : 0;  // 明细: 由状态推导
}
// 小时聚合: 两者都 undefined
```

### 2.3 `src/renderer/components/Dashboard/metricSeries.ts`

`MetricSeries` 新增 `availability`，并更新了那条过时的注释：

```ts
export interface MetricSeries {
  /**
   * 在线率序列 0..1(桶内 ONLINE 采样占比)。
   * 连接状态卡用它做走势 —— 这才是「连接状态」的时序。
   *   - 明细粒度: 1 或 0
   *   - 分桶粒度: 桶内占比
   *   - 小时聚合粒度: undefined(表里没存 state) -> 序列为空
   * 没有可用数据时返回空数组, 卡片会画空白而不是编造。
   */
  availability: number[];
  snr: number[];
  // ...
}

export function buildMetricSeries(history: HistorySample[]): MetricSeries {
  return {
    availability: pick(history, (s) => s.onlineRatio ?? Number.NaN),
    snr: pick(history, (s) => s.snr),
    // ...
  };
}
```

`?? Number.NaN` 是刻意的——`pick()` 内部用 `Number.isFinite` 过滤，无数据时序列为空，**不编造**。

### 2.4 `src/renderer/components/Dashboard/MetricCard.tsx`

新增可选 `domain` 属性，用于固定值域：

```ts
/**
 * 固定值域 [min, max]。
 *
 * 不给的话按序列自身的 min/max 归一化 —— 适合「波动幅度」有意义的指标
 * (延迟、吞吐)。但对在线率这种有绝对含义的指标(0=离线, 1=在线),
 * 自适应归一化会把「一直在线」画成一条居中的直线, 看起来像坏了。
 * 给定值域后, 1 永远在顶部, 0 永远在底部。
 */
domain?: [number, number];
```

`toPoints(values, domain?)` 在 `domain` 存在时用它替代序列自身的 min/max。其余 5 张卡不传 `domain`，行为不变。

### 2.5 `src/renderer/components/Dashboard/index.tsx`

```diff
  <MetricCard
    title="连接状态"
    value={telemetry.state === 'ONLINE' ? '在线' : telemetry.state || '—'}
    subtitle={`信号${getSignalQualityLabel(getSignalQuality(telemetry.snr))}`}
    dotColor={telemetry.state === 'ONLINE' ? '#4ade80' : '#94a3b8'}
-   series={metricSeries.snr}
+   series={metricSeries.availability}
    chartType="line"
+   domain={[0, 1]}
  />
```

---

## 3. 验证结果

### 3.1 SQLite 层（sqlite3 CLI + fixture，120 样本：3 OFFLINE + 1 SEARCHING + 116 ONLINE）

| 粒度 | 期望 | 实测 |
|---|---|---|
| 明细 | ONLINE→1，其余→0 | ✅ ratio 分布 `{1.0: 116, 0.0: 4}` |
| 分桶(2min) | 桶内 ONLINE 占比 | ✅ 含离线窗口的桶 = `0.5`（4 样本里 1 个 ONLINE）、`0.75` |
| 小时聚合 | 两者 undefined | ✅ |

### 3.2 端到端（真实库 `telemetry.db`，125 条全 ONLINE）

```
连接状态  polyline: 0.0,0.0  4.3,0.0  8.7,0.0  ...  100.0,0.0   ← 满线贴顶 ✓
延迟      polyline: 0.0,28.4 4.3,0.0 8.7,26.3 ...                ← 形态各异, 无串线 ✓
丢包率    polyline: 0.0,11.3 4.3,12.2 ...                       ✓
下载/上传 (bars 渲染, 无 polyline)                                ✓
遮挡率    polyline: 0.0,16.0 4.3,16.0 ...                        ✓
```

控制台错误 0 个。`npx tsc --noEmit -p tsconfig.json` 零报错。

---

## 4. 明确留作技术债的部分

### 4.1 `telemetry_hourly` 表没有 state 列

- `schema.ts` 的 DDL 里没有 `state`
- `upsertHourly` 不写它
- `selectHourly` 不取它

**后果**：查询范围 > 7 天（走 hourly 表）时，`state` 和 `onlineRatio` 都是 `undefined` → 序列为空 → 连接状态卡画空白。

**要补需要**：
1. 改 `schema.ts` DDL 加 `state` 列 + `online_n` 计数列
2. **写迁移**——`SCHEMA_VERSION` 已是 1，但目前**没有迁移框架**，已有用户库不能直接改结构
3. 重算历史聚合（旧的 hourly 行没有 state，只能丢弃或从明细重算）

**当前不影响显示**：仪表盘只查 15m/1h/6h（`TIME_RANGE_SECONDS`），全部走明细表。

### 4.2 `availability` 是采样点占比，不是时长加权在线率

`summarize()` 里是 `row.online_n / row.n`。采样间隔不均匀时，采样点占比 ≠ 时间占比。真正的在线率应按采样间隔做时间加权。

### 4.3 在线率序列无 Y 轴标注

卡片画的是 0..1 数值，仅靠位置表达。没有百分比刻度。若要显示刻度需另加。

---

## 5. 踩过的坑（重要）

### 5.1 主进程改动不热更新

| 目录 | 是否热更新 |
|---|---|
| `src/renderer/**` | ✅ HMR 秒级生效 |
| `src/main/**`、`src/storage/**`、`src/core/**`、`src/alerting/**` | ❌ **必须重启 Electron** |

`src/storage/` 属于主进程。改完看不到效果时先确认是不是忘了重启。

### 5.2 better-sqlite3 已编译为 Electron ABI

`node_modules/better-sqlite3` 现在是针对 **Electron 33（NODE_MODULE_VERSION 130）** 编译的。普通 node（ABI 147）下 `require` 会直接抛：

```
NODE_MODULE_VERSION 130. This version of Node.js requires NODE_MODULE_VERSION 147.
```

写验证脚本时**用 `sqlite3` CLI**，不要用 node 直接 `require('better-sqlite3')`。

### 5.3 `HistorySample` 已有 `state` 字段

`types.ts` 里 `state?: string` 早就存在（只是没人用）。别重复添加，否则会出现两个来源不一致的 state。

### 5.4 `mapRow` 是三查询共用

`selectRaw` / `selectBucketed` / `selectHourly` 共用 `mapRow()`。改它要考虑三种粒度都要不炸——列名缺失时 `r.state` 是 `undefined`（`typeof !== 'string'`），`r.online_ratio` 也是 `undefined`，会被自动跳过。

---

## 6. 关键文件行号速查

| 位置 | 内容 |
|---|---|
| `src/storage/types.ts:18-34` | `HistorySample` + `onlineRatio` 定义 |
| `src/storage/telemetryStore.ts:175-200` | `selectRaw` / `selectBucketed` |
| `src/storage/telemetryStore.ts:459-486` | `mapRow` 三粒度映射 |
| `src/renderer/components/Dashboard/metricSeries.ts:52-90` | `MetricSeries` + `buildMetricSeries` |
| `src/renderer/components/Dashboard/MetricCard.tsx:22-30` | `domain` 属性定义 |
| `src/renderer/components/Dashboard/MetricCard.tsx:40-56` | `toPoints` 固定值域支持 |
| `src/renderer/components/Dashboard/index.tsx:439-447` | 连接状态卡绑定 |
