# 变更记录：告警恢复后不消失（proto3 零值字段缺失被误当成"沿用旧值"）

**日期**: 2026-11-09
**范围**: `src/core/dishClient.ts`（`parseStatus` 的量值读取）、
`src/core/dishClient.desired.test.ts`（回归用例）
**状态**: 实机验证通过

> 相关总览见 [`DEVELOPMENT-STATUS.md`](./DEVELOPMENT-STATUS.md)。

---

## 1. 症状

用户把 DishyMock 的场景全部恢复（设备侧一切正常），但 SLMonitor 里
`high_packet_loss`（严重丢包）和 `severe_weather`（恶劣天气）两条告警**不消失**：

```
alert_key                  status   last_seen                occurrence_count
high_packet_loss:starlink  ongoing  2026-11-09T02:53:04.091Z 68
severe_weather:starlink    ongoing  2026-11-09T02:53:04.091Z 62
```

`last_seen` 还在持续刷新、计数一路涨 —— 说明规则**每轮都判定条件成立**，
不是 UI 没刷新，也不是告警库里残留了死记录。

## 2. 直接查设备：它其实已经干净了

用 `DishGrpcClient` 直连 9200 读原始响应：

```jsonc
{
  "popPingLatencyMs": 34.1,
  "downlinkThroughputBps": 140982272,
  "isSnrAboveNoiseFloor": true,
  "classOfService": "RESIDENTIAL",
  "disablementCode": "OKAY",
  "alerts": {},
  "obstructionStats": {}
}
```

注意：**`popPingDropRate` 和 `snr` 根本不在响应里**。

## 3. 根因：proto3 的零值字段不出现在响应里

`dishGrpc` 用 `defaults: false` 加载 proto（见 `dishGrpc.ts`）。在 proto3 里，
**字段值等于默认值（数值 0）时不会出现在响应中** —— 也就是说：

- 「丢包率恢复为 0」 和
- 「设备没上报这个字段」

在线上**长得一模一样**。

而 `parseStatus` 原来的写法是：

```ts
const rawDropRate = num(status.popPingDropRate, prev?.popPingDropRate ?? 0);
```

于是设备恢复健康、丢包率回到 0 之后，字段消失 ⇒ 沿用上一帧的 0.6
⇒ `high_packet_loss`（`drop > 0.1`）与 `severe_weather`（丢包 10–95% + snr<15）
两边都恒成立 ⇒ **告警永远不消失**。

## 4. 修法

新增一个语义明确的读取器：

```ts
/**
 * 读物理量（丢包率 / SNR / 吞吐 / 温度 …）。
 * 量值缺失即 0 —— 这才是 proto3 的语义，不能沿用上一帧。
 */
const gauge = (v: unknown): number => num(v, 0);
```

把所有**量值型字段**从 `num(x, prev?.x ?? 0)` 改成 `gauge(x)`：

| 字段 | 后果（修前） |
|---|---|
| `popPingDropRate` / `snr` | 告警永不恢复（本次症状） |
| `fractionObstructed` / `secondsObstructed` | 遮挡率卡在旧值 |
| `uptime` | **设备重启被旧值掩盖**，永远判不出 BOOTING |
| `ethSpeedMbps` | **网线拔掉仍显示千兆** |
| `downlinkThroughputBps` / `uplinkThroughputBps` | 断流后显示旧速率 |
| 温度、GPS 卫星数、卫星 ID、角度（boresight/tilt）、姿态不确定度 | 同类冻结 |

**字符串 / 布尔 / 结构体字段保持沿用上一帧**（`classOfService`、`disablementCode`、
`attitudeEstimationState`、`alerts`、`dishIssues`、`validS`）——它们"空"
才是异常，与数值语义相反，沿用旧值是合理的防抖。

`desiredBoresight*` 维持上一轮的约定（缺失 ⇒ `undefined` ⇒ 页面显示"无期望值"），
因为它表达的是"设备有没有给出推荐值"，不是量值。

## 5. 验证

| 项 | 结果 |
|---|---|
| `tsc` 双配置 | 0 错误 |
| `vitest run` | **20 文件 / 295 测试全过**（新增 4 项回归） |
| 重启后实机 | 两条告警在**第一个采集周期**自动 resolve：`status=resolved`，`last_seen=2026-11-09T02:58:46Z` |

回归用例（`dishClient.desired.test.ts`）核心一条：

```ts
// 第一帧：场景激活，丢包 60%
const sick = parse({ popPingDropRate: 0.6 });
setPrev(sick);
// 第二帧：场景恢复 —— 0 值字段在 proto3 里直接消失
const healthy = parse({ downlinkThroughputBps: 140e6 });
expect(healthy.popPingDropRate).toBe(0);   // 修复前是 0.6
```

同一组用例还覆盖了 `snr`、`fractionObstructed`、`secondsObstructed` 归零，
以及「设备重启（uptime 归零）不被旧值掩盖」。

## 6. 经验

**任何"缺失就沿用上一帧"的兜底，都要先问一句：这个字段的 0 是不是合法值？**
在 `defaults: false` 的 proto3 世界里，缺失恰恰意味着 0。
量值必须归零，只有"空才异常"的分类字段（字符串/布尔/结构体）才适合带旧值。

---

## 7. 追加修复：连接状态语义与 `dish_offline` 判据

跟进同一轮排查发现的第二层问题。

### 现象

激活 DishyMock 的 `weather` 场景（丢包 12% + `isSnrAboveNoiseFloor=false`
+ 全图 SNR 降到 8 dB）后，SLMonitor 冒出三条告警：

```
high_packet_loss   critical   丢包率 12.0%          ← 合理
dish_offline       critical   天线未连接            ← 误报（下行 143 Mbps）
frequent_searching warning    天线持续搜索卫星       ← 误报（同一根因）
```

而真正该报的 `severe_weather` **反而漏报**（它要求 `state === 'ONLINE'`）。

### 根因（两层）

1. **状态判定跑在 SNR 赋值之前**：`parseStatus` 末尾就调 `deriveState`，
   而 `current` 固件没有 `snr` 字段（真实 SNR 在随后拉取的遮挡图里），
   于是 `snrOk || snr > 0` 的兜底永远拿不到真实值 ⇒ 一律落到 SEARCHING。
2. **判据本身也过宽**：`dish_offline` 用 `state !== 'ONLINE'`，把 BOOTING
   （刚开机）、SEARCHING（正在锁星）也算成「天线未连接」并给到 critical；
   而 `frequent_searching` 又对 SEARCHING 单独报一次 ⇒ 同一件事报两遍。

### 修法

- **状态只看「有没有数据」**，不再用 SNR 否决连通性：
  ```
  uptime < 60s                → BOOTING
  有下行吞吐                   → ONLINE        ← 数据在流动就是通的
  无下行、路由器还连着         → SEARCHING     ← 正常锁星过程
  无下行、连路由器都看不到     → OFFLINE       ← 设备在线却不在服务
  ```
  SNR 是**质量**指标，不参与**连通性**判定 —— 恶劣天气下 SNR 掉到噪声底，
  但下行 140 Mbps，链路显然通着。
- **`dish_offline` 判据收窄为 `state === 'OFFLINE'`**，描述改为
  「设备在线但未对外提供服务」，与 `frequent_searching` 不再重叠。
- 去掉 `getTelemetry` 里上一轮加的那次「拿到遮挡图 SNR 后复核」——
  状态已不再依赖 SNR，复核成为死代码。

### 验证

| 项 | 结果 |
|---|---|
| `vitest run` | 20 文件 / **301 测试全过**（新增 6 项状态语义用例） |
| 重启后采集 | `state=ONLINE` |
| weather 场景活跃时 | 活跃告警只剩 `high_packet_loss` + `severe_weather`，两条误报自动 resolve |

新增回归用例：
- `manager.test.ts`：SEARCHING **不应**报 `dish_offline`
- `dishClient.desired.test.ts`：有下行 ⇒ ONLINE ／ 无下行+路由器 ⇒ SEARCHING ／
  无下行+无路由器 ⇒ OFFLINE ／ uptime<60 ⇒ BOOTING ／ 恶劣天气仍判 ONLINE

## 8. 追加修复：`frequent_searching` 改为跨帧判据

### 问题

规则名是「频繁断线重连」，但实现是：

```ts
condition: (data) => data.state === 'SEARCHING' && (data.uptime || 0) > 600
```

两个毛病：

1. **判据根本不是"卡住多久"而是"设备开机多久"**。刚开机、正常锁星的设备
   只要 `uptime > 600`，就会报「无法建立稳定连接」。
2. **只看单帧，抓不到真正的频繁重连**。断线重连的本质是帧与帧之间
   ONLINE ↔ 非 ONLINE 反复横跳，单帧数据里没有任何信息。

### 修法

在 `AlertManager` 里维护状态历史（规则只查询、不自己攒状态）：

- `recordLinkState(state)` —— 在 `checkTelemetry` 入口调用，统计
  **ONLINE ↔ 非 ONLINE** 的跃迁时刻（BOOTING→SEARCHING 这种开机演进不算）
- `linkFlips` + `searchingSince` 两个小字段，只在 10 分钟窗口内保留

新判据（满足任一即触发）：

| 条件 | 含义 |
|---|---|
| 10 分钟内 ONLINE ↔ 非 ONLINE 翻转 ≥ 3 次 | 真的在反复断线重连 |
| 连续停留在 SEARCHING ≥ 10 分钟 | 这个方向一直连不上 |

`summary` / `description` 会区分是哪一种，不再一律说"持续搜索卫星"。

### 静默期（否则告警会"挂满 10 分钟"）

第一版判据只查"10 分钟窗口内翻转 ≥3 次"。实测发现：链路稳定之后，历史翻转
仍留在窗口里，于是告警还要**干挂满 10 分钟**才消失 —— 用户看到的是
「顶部状态已经是 ONLINE、图表也平稳，但告警还在」，和之前那个"设备恢复了
告警不消失"是同一类观感。

改为 **计数窗口 + 静默期** 双条件：

```
触发: 10 分钟内翻转 ≥3 次  且  最近一次翻转在 5 分钟内
恢复: 连续 5 分钟没有再翻转（或已离开 SEARCHING）
```

### 端到端验证（为此给 DishyMock 加了新场景）

告警规则是跨帧判据，单帧场景永远触发不了，所以给模拟器加了
**`link_flap`（连接抖动）** 场景（`~/ClaudeCode/DishyMock/src/scenarios/link.ts`，
该目录不是 git 仓库，改动直接落盘）：

- 周期 45 秒（25 秒有下行 / 20 秒清零），与被测方 30 秒采样周期互质，避免混叠
- **只清下行吞吐、保留 `connectedRouters`** —— 这样被测方判成 SEARCHING
  （正常搜星）而不是 OFFLINE，否则验证的就变成 `dish_offline` 了

实机时间线：

| 时刻 | 事件 |
|---|---|
| 13:36:13 | 激活 link_flap |
| ~13:37 | 告警触发：`近 10 分钟断线重连 4 次` |
| 13:38:53 | 停止场景 |
| 13:43:50 | 告警自动 resolve（≈ 最后一次翻转后 5 分钟，即静默期） |

采集侧同步可见状态横跳：`12:00:25 SEARCHING → 12:00:55 ONLINE →
12:01:55 SEARCHING → 12:03:25 SEARCHING → 12:03:55 ONLINE`。

### 验证

| 项 | 结果 |
|---|---|
| `vitest run` | 20 文件 / **305 测试全过**（新增 4 项：翻转触发、稳定在线不触发、卡住 10 分钟触发、静默期恢复） |
| 实机 | 抖动期间只出 `frequent_searching` 一条，无 `dish_offline` / `low_throughput` 误报；停止后 5 分钟自愈 |

---

## 9. DNS 探针「依赖抑制」：目标不可达 ≠ 域名解析失败

### 问题
`dns-dual-check` 探针连不上目标 DNS 服务器时（`ECONNREFUSED`），报的是
**「域名解析失败 / 双轨探测均失败 → 网络层故障或域名不存在」**。

这是**误诊**：挂掉的不是用户的 DNS，而是**被测数据源本身**（本地 mock 进程退出、
探针目标下线）。用户看到这条会被引导去改自己的 DNS 设置，而真正该做的事是
把数据源拉起来。2026-11-09 就撞上过一次：mock 进程被杀 ⇒ SLMonitor 里挂着
`dns_failure:dns-dual-check`，而 mock 的场景状态其实早就恢复了。

### 判定：两种失败模式必须分开
Node 的 DNS 错误码可以直接区分：

| 错误码 | 含义 | 归类 |
|---|---|---|
| `ECONNREFUSED` / `EHOSTUNREACH` / `ENETUNREACH` / `EADDRNOTAVAIL` / `ENETDOWN` / `EPIPE` | 根本没联系上服务器 | **`unreachable`** ⇒ 数据源不可用 |
| `ENOTFOUND` / `NXDOMAIN` / `ESERVFAIL` / `ETIMEOUT` / `EAI_AGAIN` | 连上了但解析不出 | **`resolution`** ⇒ 真的是 DNS 问题 |
| 错误码缺失/未知 | 拿不准 | 按 `resolution` 处理（宁可多报，不静默真故障） |

实现：`src/core/probeRunner.ts` 的 `classifyDnsError()`，
`ProbeResult.failureMode` + `dualDns.user/baseline.failureMode` 逐轨透传。

### 告警层分流（`src/alerting/manager.ts`）
- `resolution` ⇒ 原样报 `dns_failure`（标题/摘要/建议不变）。
- `unreachable` ⇒ **不报** `dns_failure`，改报新类型
  **`probe_source_unavailable`**（摘要「数据源不可用（探针目标不可达）」），
  并且**主动撤掉**此前挂着的 `dns_failure`（那个条件已经不成立了）。
- 数据源恢复 ⇒ 探针成功 ⇒ 自动 `resolved`。

> 为什么不是"直接不告警"：静默吞掉会变成盲区（本项目已经吃过一次
> `alerts.dns` 没人消费的亏）。换成准确命名的独立告警，既不误诊、也不丢信号。

### 顺带修掉一个更严重的 bug：本地化摘要是空的
`localizeAlert()` 先 `t('alerts:types.X.summary')` 得到**已翻译的字符串**，
再把这串字符当**键**传给第二次 `t()` —— 第二次必然查不到，而
`parseMissingKeyHandler` 返回空串 ⇒ **所有告警类型的本地化摘要全是空的**
（界面上根本不显示摘要行，只有标题）。

修法：一次 `t()` 调用同时完成"取模板 + 插值"：
```ts
const summary = t(`${typeKey}.summary`, { ...params, defaultValue: '' });
```
新增 `src/renderer/lib/alertMessage.test.ts`（7 例）锁住这个行为，
其中测试实例**必须配 `parseMissingKeyHandler: () => ''`**，
否则测不到真实兜底行为（这正是它第一次跑绿的原因）。

### 新增文案键
`alerts:types.probe_source_unavailable.{title,summary,recommendations}`
（5 语言各一份），摘要模板用 `{{node}}`（探针节点 id）与 `{{errcode}}`（底层错误码）。

> ⚠️ `{{err}}` 已被"姿态不确定度"占用，新模板必须用 `{{errcode}}`。

### 验证
- 单测：新增 `manager.probe-suppression.test.ts`（5 例）+ `probeRunner` 分类（4 例）
  + `alertMessage.test.ts`（7 例）；全量 **25 文件 / 364 测试全过**，tsc 双配置 0 错误。
- 真机端到端：杀掉 mock ⇒ 探针 ECONNREFUSED ⇒ 库里只有
  `probe_source_unavailable:dns-dual-check`（**没有** `dns_failure`），
  界面中英文摘要均正确插值；重启 mock ⇒ 探针恢复 ⇒ 告警自动 resolved。
