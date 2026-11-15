# 变更记录：客户端侧两个场景的告警覆盖（补齐告警盲区）

**日期**: 2026-11-09
**范围**: `src/alerting/manager.ts`（两条新规则 + 跨帧计数）、
`src/core/serviceState.ts`（`DishAlertFlag` 补 `dns`）、
`src/alerting/manager.test.ts`（5 项新用例）
**状态**: 单测 + 真机端到端验收通过

---

## 1. 结论：这两个场景**都该告警**，而且一个是真缺口，一个是接线缺失

| 场景 | 该不该告警 | 原来为什么不告 |
|---|---|---|
| `client_device` 客户端设备问题 | **该** | SLMonitor 只统计"已连接路由器数量"，`router_offline` 只抓"数量为 0"的彻底断开，**抓不到"掉一下又回来"的抖动** |
| `client_network_config` 客户端网络配置异常 | **该** | 场景的故障全在 DishyMock 的假探测目标上，而 **SLMonitor 的探针指向的是公网 DNS(8.8.8.8) 与系统 DNS**，压根没打假 DNS ⇒ 零感知 |

顺带发现一个独立的真缺口：设备上报的 `alerts.dns` 标志位
（proto `bool dns = 15`）**没有任何规则消费** —— 设备报了等于白报。

---

## 2. `client_device`：新增 `router_flapping` 规则

### 数据通路

DishyMock 的 `client_device` 场景让 `connectedRouters` 在
`[router-aabbccdd, router-eeff0011]` 与 `[router-eeff0011]` 之间来回切换
（模拟单个下游设备/路由器反复断开重连）。
SLMonitor 的 `parseStatus` 已经在解析 `connectedRouterCount`
（`src/core/dishClient.ts:444`），但**没有任何规则消费它的变化**。

### 修法

新增规则 `router_flapping`（warning）：**已连接路由器数量**在 10 分钟窗口内
变化 ≥3 次，且最近一次变化在 5 分钟内（静默期，同 `frequent_searching` 的思路）。

- `router_offline` 负责"一台路由器都没了"（彻底断开，critical）
- `router_flapping` 负责"掉一下又回来"（抖动，warning）

判据是跨帧的，所以在 `AlertManager` 里维护计数
（`recordRouterCount` / `recentRouterCountChanges`），
规则只做查询 —— 与 `frequent_searching` 同一套做法。

### 顺带修掉 DishyMock 的采样混叠

原场景用 5 秒周期（完整周期 10 秒）切换，而被测方普遍按 **30 秒**采集：
`30 % 10 == 0` ⇒ **每次都采到同一相位**，被测方看到的"路由器数量"恒定不变，
场景等于没生效（第一轮验证就是因此测不出来）。

改成 12 秒周期（`30 % 12 = 6` ⇒ 相位逐帧漂移），并在该文件里写明原因。

---

## 3. `client_network_config`：接线 + 既有规则生效

### 场景性质

这是**纯 probe 载体**场景：dish 侧字段全部正常，故障全在假探测目标
（假 DNS → NXDOMAIN，假 HTTP → 403）。

实测 mock 假 DNS：

```
正常模式:  9253(user) NOERROR   9254(base) NOERROR
场景激活:  9253(user) NXDOMAIN  9254(base) NOERROR   ← 正是双轨探针要的组合
```

### 为什么原来测不出来

SLMonitor 的探针配置是 `dns-dual-check: "google.com|8.8.8.8"`
—— 用户态走**系统 DNS**、基准态走 **8.8.8.8**，两者都跟 mock 的假目标无关。
而 `probeRunner` 的注释里其实已经写了第三段用法
（`domain|baseline_dns|user_dns`，专门"让被测方能打到假 DNS 服务器"），
只是配置里没用。

### 修法（测试环境接线）

把本机配置改成：

```
dns-dual-check → "google.com|127.0.0.1:9254|127.0.0.1:9253"
                  基准态 = mock 基准 DNS(9254)
                  用户态 = mock 用户 DNS(9253)
```

于是既有的 `dns_failure` 规则（连续 3 次失败触发）直接生效，
归因文案也正是这个场景的语义：

> ⚠️ 网页无法加载 (域名解析失败)
> 诊断结果：基础网络畅通，但您的当前域名服务器无响应。

> 说明：这是**开发机配置**（`~/Library/Application Support/Electron/config/config.json`），
> 产品默认仍是 `google.com|8.8.8.8` —— 生产环境没有 mock，不该指向假 DNS。

### 已知限制

场景里"假 HTTP 返回 403"这一半 SLMonitor 仍观测不到：它目前只有
ICMP / DNS / DNS-双轨 / TLS 四种探针，没有 HTTP 探针类型。
如需覆盖要新增探针类型 + 规则，暂未做。

---

## 4. 顺带补齐：设备侧 `alerts.dns` 无人消费

`DishAlertFlag` 里补上 `'dns'`，并新增规则 `dns_resolution`（warning）：
设备自己把 `alerts.dns` 置起来时必须告警。

这条规则**与上面两个场景无关**（mock 的 `client_network_config` 走 probe 路径，
dish 侧不置位），补的是真实设备上的盲区：此前设备报 DNS 异常，SLMonitor 静默丢弃。

---

## 5. 验收

| 场景 | 结果 |
|---|---|
| `client_network_config` 激活 210s | `dns_failure:dns-dual-check`（warning，ongoing）✓ 归因文案正确 |
| `client_device` 激活 210s | `router_flapping:starlink`（warning，"本地路由器反复上下线（近 10 分钟 7 次）"）✓ |
| 停止 `client_device` 后 | 静默期结束自动 `resolved` ✓ |
| 未激活任何场景 | 无该两条告警 ✓ |
| `vitest run` | 20 文件 / **310 测试全过**（新增 5 项） |
| `tsc` 双配置 | 0 错误 |

新增用例：
- `alerts.dns=true` ⇒ 报 `dns_resolution`；`false` ⇒ 不报
- 路由器数量 2↔1↔2↔1 ⇒ 报 `router_flapping`，且**不**报 `router_offline`
- 路由器数量恒定 ⇒ 不报
- 稳定满 5 分钟静默期 ⇒ 自动恢复

## 6. 两处"等不到"的教训

真机验证时踩了两次相同的坑，都不是代码问题而是**时长**：

1. DNS 告警要"连续 3 次失败"，探针周期 60 秒 ⇒ 需要 **≈3 分钟**
2. `router_flapping` 要 ≥3 次数量变化，采样周期 30 秒 ⇒ 需要 **≈2 分钟**

第一轮按 100 秒等待，两个场景都测不出来，差点误判成"规则没生效"。
