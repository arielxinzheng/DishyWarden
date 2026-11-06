# 变更记录：告警生命周期与 alerts 数据结构

**日期**: 2026-11-06
**范围**: `src/alerting/manager.ts`、`src/collector/historian.ts`、`src/collector/exporter.ts`、
`src/core/dishClient.ts`、`src/core/serviceState.ts`、`src/storage/schema.ts`、
`src/storage/telemetryStore.ts`、`src/renderer/hooks/useDish.tsx`
**状态**: 单测 + 实机验收通过（见 §5）

> 相关总览见 [`DEVELOPMENT-STATUS.md`](./DEVELOPMENT-STATUS.md)。
> 校准页部分见 [`CHANGELOG-calibration-ui.md`](./CHANGELOG-calibration-ui.md)。

---

## 1. 症状

页面上 `NO_SCHEDULE`（卫星调度缺失）告警**闪一下就消失**，历史里却查得到，
而且每条记录 `first_seen → last_seen` 只差 **2 秒**。实测 `alerts.db`：

```
08:58:59.818  ongoing
08:59:01.856  resolved    ← 只活了 2 秒
08:59:29.816  ongoing     ← 30 秒后又出现
08:59:31.851  resolved
```

同时另一种误报：3 分钟前就结束的一次调度失败，仍然会让页面冒出「容量不足」。

## 2. 根因（三个独立问题叠加）

1. **非遥测规则混在 `this.rules` 里**
   `no_satellite_schedule` 的数据源是 `dishGetHistory` 的 outages，
   但它和遥测规则放在同一个数组里，于是 `checkTelemetry()` 每轮也会遍历它：
   `condition()` 恒 false ⇒ 走 else ⇒ **resolve**；2 秒后 `checkOutages()` 又置回 ongoing。

2. **采集侧「有事件才广播」**
   `historian` 原本在 `outages.length === 0` 时直接 `return []`，
   等于把「本轮没有任何中断」这个事实吞掉。规则的生命周期需要「条件不成立」的信号，
   所以 NO_SCHEDULE 消失后告警**永远停在 ongoing**，没有任何恢复路径
   （它已被 `managedBy: 'outages'` 从遥测侧摘走）。

3. **滑动窗口没筛新鲜度**
   `dishGetHistory` 返回的是过去 15 分钟的中断列表，窗口里有 ≠ 此刻还在发生。

## 3. 修法

| 问题 | 修法 |
|---|---|
| 规则被两边抢着管 | 规则加 `managedBy: 'outages'`，`checkTelemetry()` 显式跳过 |
| 无事件不广播 | 采集侧**每轮都 emit** `outages`（空数组也发），`checkOutages([])` 自然走 resolve |
| 翻旧账 | `OUTAGE_FRESH_WINDOW_MS = 2 分钟`（4 个采集周期），按 `start + duration` 判是否仍在进行 |
| first_seen 被重置 | 重新激活时延续首次出现时间 |

## 4. 顺带的数据模型变更

- **`alerts` 从 `string[]` 改成布尔标志对象**
  （`{ thermalThrottle?: boolean, ... }`，带 `[key: string]: boolean | undefined` 索引签名）。
  规则统一用 `hasAlert(data, 'xxx')`（`src/core/serviceState.ts`）读，该函数**同时兼容**两种历史形态，
  避免「改成对象后 `.includes` 抛 TypeError 被 catch 吞掉 ⇒ 规则静默失效」。
- **新增 v7 迁移**：`telemetry_samples` 增加 `class_of_service` / `disablement_code` / `alerts_json`，
  存量库用 `PRAGMA table_info` 判列是否存在后再 `ALTER TABLE`（无迁移框架，只能这样）。
- **新增「服务受限」规则族**：`classOfService` / `disablementCode` 任一命中即触发，
  并在服务受限时抑制「下行速率低」的重复报警。

## 5. 验收记录（本次实测）

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 错误 |
| `npx tsc --noEmit -p tsconfig.electron.json` | 0 错误 |
| `npx vitest run` | **19 文件 / 263 测试全过**（含新增 8 项生命周期用例） |
| v7 迁移（实机库） | `class_of_service` / `disablement_code` / `alerts_json` 三列已存在 |
| 新列落值 | 最近采样：`RESIDENTIAL` / `OKAY` / `{}` |
| Prometheus `starlink_alerts_total` | `0`（修复前对象形态下是 NaN/undefined） |
| 四页 UI（校准/告警/仪表盘/设置） | 均正常渲染，控制台 0 报错 |
| 告警闪断 | 重启后跑满多个采集周期，`alerts.db` 无新增 5 秒内 resolve 的记录 |

## 6. 验收时顺手修掉的编译错误

这批改动引入/遗留了 4 处类型错误，已一并修掉：

1. `manager.ts` 恶劣天气规则里 `data.state === 'STOWED'` —— `TelemetryData['state']`
   只有 `ONLINE/OFFLINE/SEARCHING/BOOTING`，该比较恒假（TS2367）。删掉；
   天线收起后没有下行链路，状态会先落到 SEARCHING/离线，末尾的 `=== 'ONLINE'` 已挡住。
2. `exporter.ts` 里 `telemetry.alerts.length` —— 对象形态下是 undefined。
   新增 `countActiveAlerts()`（`src/core/serviceState.ts`），与 `hasAlert()` 同源。
3. `useDish.tsx` 的 mock 仍是 `alerts: []` → 改成 `{}`。
4. 另外两处是 HEAD 存量问题（与本批无关）：
   `DnsAlertDetail.tsx` 未使用的 `isBaseline` 参数、`ProbeNodesCard.tsx` 缺 `dns_dual` 标签。

## 7. 已知遗留

1. **DishyMock 当前不产生 NO_SCHEDULE 中断**（实测 57 条中断全是卫星切换），
   所以「告警闪断」的端到端复现只能靠单测（`manager.outage-lifecycle.test.ts` 8 例）。
   要真机复现，需要造一个 NO_SCHEDULE 的 outage 数据源。
2. `RouterProbe` 会提示「当前网络环境应答了保留地址 192.0.2.1 的 ICMP（VPN/隧道）」——
   实测环境限制，与本次改动无关。
