# 变更记录：真实 dish gRPC 接入

**日期**: 2026-10-26
**提交**: `02cb87d`
**范围**: `src/core/dishGrpc.ts`（新增）、`src/core/dishClient.ts`、`src/storage/telemetryStore.ts`、`package.json`
**状态**: 端到端已验证

> 相关总览见 [`DEVELOPMENT-STATUS.md`](./DEVELOPMENT-STATUS.md)。
> 前置阅读：[`CHANGELOG-obstruction-source.md`](./CHANGELOG-obstruction-source.md)（遮挡图来源标记）。

---

## 1. 背景

`dishClient.getTelemetry()` 一直返回本地 mock，`dishGetObstructionMap(1015)`
**从未被调用过**。库里那份 123×123 矩阵是前端随机噪声，却以「设备实测」呈现。

本次把真实 gRPC 通道打通。**DishyMock 侧无需任何改动** —— 它的
`obstruction` 场景本来就能产出带遮挡的 snr 图。

---

## 2. 协议三个硬约束（踩坑记录）

这三个都是**静默失败**：不报错，但拿不到数据。

### 2.1 loader 必须 `keepCase: false`

```ts
const PROTO_OPTS = {
  keepCase: false,   // ← 关键
  longs: String, enums: String, bytes: Buffer,
  defaults: false, oneofs: true,
};
```

`keepCase: true` 时字段名保持 snake_case，请求分支名对不上，服务端收到
**空 oneof**，响应里只剩 `apiVersion` —— 且**不报任何错**。

### 2.2 请求分支名用 camelCase

```ts
// ✅ 对
client.Handle({ id: 1, dishGetObstructionMap: {} })
// ❌ 错 —— 服务端收到空 oneof
client.Handle({ id: 1, dish_get_obstruction_map: {} })
```

被测方生产代码（`/Users/lixinzheng/Downloads/sl-monitor-0.1.0/server/dist/grpc/grpc-client.js`）
用 `normalizeRequest()` 做 snake→camel 转换，本实现直接写 camelCase。

### 2.3 响应挂在顶层 camelCase 键

```ts
const map = res.dishGetObstructionMap;   // ✅
```

不是 `res.response.dishGetObstructionMap`（oneof 虚拟字段在
`defaults:false` 下不可靠）。

---

## 3. reflection 取 proto（不依赖本地 .proto 文件）

真实 dish 和 DishyMock 都注册了 gRPC reflection，所以不需要把 proto 文件
打进包里。

```ts
// 客户端侧 reflection 的 .proto 在 @grpc/reflection 包里
const REFLECTION_PROTO_PATH = require.resolve(
  '@grpc/reflection/build/proto/grpc/reflection/v1/reflection.proto'
);
```

### 3.1 `@grpc/reflection` 只有服务端 API

```js
Object.getOwnPropertyNames(ReflectionService.prototype)
// → ['constructor', 'addToServer']
```

**没有客户端 stub**。要用它自带的 `.proto` 自行构造
`grpc.reflection.v1.ServerReflection` 客户端。

### 3.2 响应字段名是 `fileDescriptorResponse`

```ts
// ❌ 请求侧的字段名，用在这里永远拿到 undefined
stream.on('data', (msg) => msg.fileContainingSymbol?.fileDescriptorProto)
// ✅
stream.on('data', (msg) => msg.fileDescriptorResponse?.fileDescriptorProto)
```

### 3.3 打包 + 加载

```ts
protoLoader.loadFileDescriptorSetFromBuffer(packFileDescriptorSet(descriptors), PROTO_OPTS)
```

**注意**：`loadSync()` 只接受**文件路径**，喂字节流会报
`path.replace is not a function`。要用 `loadFileDescriptorSetFromBuffer()`。

---

## 4. 遮挡图解析

按 `docs/field-contract.md`（DishyMock 侧）：

- **`snr` 是首选路径**，值域 0..12，`-1` = 无数据哨兵
- 遮挡度换算：`1 - snr/12`，钳到 [0,1]
- `obstructionMatrix` 是次选路径，值直接 clamp 到 [0,1]

```ts
// snr=-1 是未映射像素，映射成 0
if (!Number.isFinite(snr) || snr < 0) { row.push(0); continue; }
row.push(Math.min(1, Math.max(0, 1 - snr / 12)));
```

---

## 5. 极坐标约定（几何校验的基准）

DishyMock `src/state/baseline.ts` 的 `cellToPolar()`：

> **天顶在圆心、地平线在外圈**，方位角 0° 为正北（**行号减小的方向**），
> 顺时针增大（90° 为东）。仰角是**径向**的：`90 * (1 - r/radius)`。

```ts
const el = 90 * (1 - r / radius);
let az = (Math.atan2(dx, -dy) * 180) / Math.PI;  // dy = row - cy
if (az < 0) az += 360;
```

**仰角不是垂直方向的** —— 早期按「y 越小仰角越高」算，得到的 -40° 与
场景声明的 20–45° 差了一整个象限。

---

## 6. `state` 字段：协议里没有，只能推导

DishyMock proto 明确注明：

```proto
// state 枚举被测方全程不读，故不实现（DESIGN.md §8 落差 1 的根因）。
message DeviceState {
  uint64 uptime_s = 1;
}
```

所以连接状态必须从链路指标推导（`dishClient.deriveState()`）：

| 判据 | 状态 |
|---|---|
| uptime < 60s | `BOOTING` |
| 无下行带宽且无已连路由器 | `SEARCHING` |
| 有下行带宽且 SNR 高于噪声底 | `ONLINE` |

**遮挡本身不算断线** —— dish 被遮挡时仍然有带宽，只是吞吐下降。
把「遮挡」判成 `OFFLINE` 会让在线率指标失真。

### int64 字段是字符串

loader 用 `longs: String`，所以 `deviceState.uptimeS` 是 `"87530"` 而非数字。
`parseStatus()` 里的 `num()` 统一做字符串→数字转换。

---

## 7. 失败处理原则

```ts
// 设备不可达 —— 默认抛错，不回落 mock
if (!this.config.fallbackToMock) throw error;
```

监控软件宁可报「采不到数」，也不能把随机数当设备实测值。
新增 `fallbackToMock` 开关供演示用，回落时 `obstructionMapSource` 标 `'mock'`。

**遮挡图失败只丢遮挡图**，不影响同一帧的其它遥测 —— 遮挡图是 1015 分支，
状态是 1000 分支，两者独立。

---

## 8. `telemetryStore` 的 electron 延迟加载

顶层 `import { app } from 'electron'` 会让存储层在 Node 环境（测试脚本、
CLI）直接炸：

```
SyntaxError: The requested module 'electron' does not provide an export named 'app'
```

而 electron 只是**默认路径**的可选项。改成按需加载：

```ts
const nodeRequire = createRequire(import.meta.url);
const { app } = nodeRequire('electron') as typeof import('electron');
```

只在没给显式 `dbPath` 时才走到这条路径。

---

## 9. 验证结果

### 9.1 几何（与 DishyMock 场景声明逐项比对）

| 项 | 实测 | 场景声明 |
|---|---|---|
| 方位角范围 | [110.1°, 159.9°] | 135°±25° → [110, 160] |
| 仰角范围 | [20.6°, 45.3°] | [20, 45] |
| 强度加权重心 | az=135.0°, el=32.0° | 中心 135° |
| 遮挡像素 | 576 (4.85%) | — |
| 值域 | 0 / 0.75 两级 | sector 内 snr=3 → 0.75 |

### 9.2 落库

```sql
sqlite3 "$DB" "SELECT ts, size, source FROM latest_obstruction_map WHERE id=1;"
-- 1792999424473|123|real
```

### 9.3 UI

障碍图页渲染出：
- 「设备实测遮挡图 · 刚刚采集」
- 总像素数 11,681 / 障碍像素 576 / 障碍率 4.93% / 最大障碍值 0.75
- **主遮挡方向 东南**（= 135°，与几何校验一致）

### 9.4 Prometheus

```
starlink_dish_up 1
starlink_dish_uptime_seconds 88598
starlink_snr 11.556202379933225
starlink_fraction_obstructed 0.15000000596046448
```

---

## 10. 遗留

- **`fractionObstructed`（0.15）与遮挡图算出的 4.93% 不一致** —— 这不是 bug：
  前者是 DishyMock 场景直接给的标量（ramp 到 0.15），后者是按扇区几何
  （az 135°±25°, el 20–45°）在圆形视野内实算的占比。两者口径不同。
- `dishGetStatus` 不带 `snr` 数值（只给 `isSnrAboveNoiseFloor` 布尔量），
  真实 SNR 取自遮挡图的 snr 数组均值。
- `satelliteId` 协议里没有，仍回退到「仰角最高」。
- `routerClient` 还是 mock（`src/core/routerClient.ts:99`），未接真实 gRPC。
