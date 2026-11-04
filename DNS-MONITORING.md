# DNS 双轨监控模块 - 验证指南

## 功能概述

DNS 双轨监控通过同时探测用户态 DNS（系统默认）和基准态 DNS（公网可靠节点）来诊断域名解析故障的根因。

### 核心特性

1. **双轨对比探针**
   - 用户态：使用系统默认 DNS 解析 `google.com`
   - 基准态：强制使用 `8.8.8.8` 解析相同域名
   - 探测间隔：60 秒

2. **降噪告警规则**
   - 连续 3 次失败才触发告警（避免偶发抖动）
   - 依赖压制：底层 ICMP 断开时自动压制 DNS 告警
   - 延迟变高（>200ms）仅在状态条显示黄色，不触发横幅

3. **归因分析文案**
   - 用户 DNS 故障 + 基准 DNS 正常 → "建议修改 DNS 为 8.8.8.8"
   - 双轨均失败 + 本地网关延迟高 → "检测到局域网拥堵"
   - 双轨均失败 + 网络层正常 → "网络层故障或域名不存在"

## 验证步骤

### 1. 检查探针运行状态

启动 Electron 后，在终端日志中应该看到：

```bash
[Main] 探针节点配置: ..., dns-dual-check(dns_dual,enabled=true), ...
[Probe] OK dns-dual-check: 131.0ms / 双轨探测正常
```

### 2. 用 DishyMock 模拟 DNS 故障（推荐，无需改系统 DNS）

DishyMock 提供了**双轨 DNS 模拟**：两个独立的假 DNS 服务器

| 端口 | 角色 |
|---|---|
| `127.0.0.1:9253` | 用户态 |
| `127.0.0.1:9254` | 基准态 |

被测方把探针 target 配成 `domain|基准态|用户态`（**第三段是用户态**），
两轨就都打到假 DNS 上：

```
example.com|127.0.0.1:9254|127.0.0.1:9253
```

> ⚠️ **第三段只用于测试**。不填第三段时用户态走系统默认 DNS（真实语义）。
> Node 的 `dns.Resolver.setServers()` 支持 `ip:port`，所以假 DNS 能跑在非标准端口。

#### 2.1 配置探针（设置页或改配置）

设置页 → 探针节点管理 → 「DNS 双轨探测」的 target 改成：

```
example.com|127.0.0.1:9254|127.0.0.1:9253
```

#### 2.2 激活场景

> **也可以直接点控制台页面**：`http://127.0.0.1:9201/` → 「链路与性能」分组
> → 找到对应场景 → 点「触发」。**控制台页面与 API 等价**，
> 页面点「触发」就是调 `POST /api/scenarios/<id>/activate`。
>
> 页面上的 DNS 相关场景：
>
> | 卡片标题 | 场景 id | 效果 |
> |---|---|---|
> | DNS 异常 | `dns` | 用户态延迟 6s（打穿超时），基准态正常 |
> | DNS 双轨: 用户态故障 | `dns_dual_user_broken` | 用户态 NXDOMAIN，基准态正常 |
> | DNS 双轨: 双轨均故障 | `dns_dual_both_broken` | 两轨都超时 |
> | DNS 双轨: 用户态延迟高 | `dns_dual_slow` | 用户态 +800ms，**不告警** |
> | DNS 双轨: 已恢复 | `dns_dual_recovered` | 两轨正常，告警解除 |

```bash
# 用户态坏 / 基准态好 ⇒ 应归因「本地 DNS 配置问题」
curl -X POST http://127.0.0.1:9201/api/scenarios/dns_dual_user_broken/activate

# 双轨都坏 ⇒ 应归因「网络层故障或域名不存在」
curl -X POST http://127.0.0.1:9201/api/scenarios/dns_dual_both_broken/activate

# 用户态慢 ⇒ 显示「延迟明显高于基准」, 按设计**不触发横幅**
curl -X POST http://127.0.0.1:9201/api/scenarios/dns_dual_slow/activate

# 恢复正常 ⇒ 告警应解除
curl -X POST http://127.0.0.1:9201/api/scenarios/dns_dual_recovered/activate
```

#### 2.3 预期结果

| 场景 | 用户态 | 基准态 | 期望文案 |
|---|---|---|---|
| `dns_dual_user_broken` | ENOTFOUND | OK | 「本地 DNS 配置问题」 |
| `dns_dual_both_broken` | ETIMEOUT | ETIMEOUT | 「网络层故障或域名不存在」 |
| `dns_dual_slow` | OK +800ms | OK | 「延迟明显高于基准」（不告警） |
| `dns_dual_recovered` | OK | OK | 告警 resolved |

**告警需要连续 3 次失败才触发**（探测间隔 60s ⇒ 约 3 分钟）。

#### 2.3.1 实测结果（2026-11-04 验证）

Electron 16:03 重启后，用真实链路跑通：

```
t=5s   ok=true  用户态=OK        基准态=OK        连续失败=0
t=10s  ok=false 用户态=ENOTFOUND 基准态=OK        连续失败=1
t=20s  ok=false 用户态=ENOTFOUND 基准态=OK        连续失败=2
t=30s  ok=false 用户态=ENOTFOUND 基准态=OK        连续失败=3
```

告警触发内容：

```
alert_key   dns_failure:dns-dual-check   status=ongoing   occ=3
标题        ⚠️ 网页无法加载 (域名解析失败)
描述        诊断结果：基础网络畅通，但您的当前域名服务器无响应。
evidence    {"node_id":"dns-dual-check","consecutive_failures":3,
             "user_dns":{"ok":false,"rtt_ms":null,"error":"ENOTFOUND"},
             "baseline_dns":{"ok":true,"rtt_ms":2,"resolved_ip":"127.0.0.1"}}
```

恢复路径（切 `dns_dual_recovered`）：告警**自动**置为 `resolved`。

另一种归因（切 `dns_dual_both_broken`）：

```
描述        诊断结果：网络层故障或目标域名不存在。
user_dns      ok=false  ETIMEOUT
baseline_dns  ok=false  ETIMEOUT
```

> 验证时把探针间隔临时改成 10s 以缩短等待（连续 3 次失败约 30s），
> 验证完记得改回 60s。

#### 2.3.2 单轨「DNS 异常」场景（2026-11-04 改造后实测）

「DNS 异常」场景原本是 `alerts.dns=true` 字段补丁 + 单轨假 DNS，
但**单轨探针触发不了 DNS 告警** —— `checkDnsProbe()` 第一行就是
`if (!probeResult.dualDns) return;`。已改造成双轨（用户态延迟 6s）。

控制台点「DNS 异常」→「触发」后实测：

```
alert_key   dns_failure:dns-dual-check   status=ongoing   occ=1
标题        ⚠️ 网页无法加载 (域名解析失败)
描述        诊断结果：基础网络畅通，但您的当前域名服务器无响应。
evidence    {"consecutive_failures":3,
             "user_dns":{"ok":false,"rtt_ms":null,"error":"ETIMEOUT"},
             "baseline_dns":{"ok":true,"rtt_ms":1,"resolved_ip":"127.0.0.1"}}
```

`ETIMEOUT` 证明 6s 延迟确实打穿了 5s 超时阈值；
`baseline_dns.ok=true` 证明归因正确落在「本地 DNS 配置问题」。

> `alerts.dns` 这个字段在 **SLMonitor** 侧是**落库但无人消费**的
> （写进 `telemetry_samples.alerts_json`，但没有任何规则或 UI 读它），
> 所以针对 SLMonitor 的场景不再置位它。
>
> ⚠️ 这只针对 SLMonitor。`alerts.dns` 对 Starlink 自己的固件/云端消费者
> 是**通的**（`classifyAlert("dns")` → internet/warning）。
> 详见 DishyMock `src/scenarios/link.ts` 与 DESIGN.md §"DNS 的两条路径"。

#### 2.4 直接控制两轨（不走场景）

```bash
# 用户态 NXDOMAIN，基准态正常
curl -X POST http://127.0.0.1:9201/api/probes \
  -H "Content-Type: application/json" \
  -d '{"dnsDual":{"user":{"mode":"nxdomain"},"baseline":{"mode":"normal"}}}'

# 查看当前状态（含基准态端口）
curl http://127.0.0.1:9201/api/probes
# {"dns":{...},"dnsBaseline":{...},"dnsBaselinePort":9254,...}
```

### 3. 模拟用户 DNS 故障（改真实系统 DNS，不用 DishyMock 时）

#### macOS/Linux

```bash
# 修改系统 DNS 为不存在的地址
sudo networksetup -setdnsservers Wi-Fi 192.0.2.1

# 等待 3 分钟（连续 3 次探测失败）
# 应该触发告警：⚠️ 网页无法加载 (域名解析失败)

# 恢复默认 DNS
sudo networksetup -setdnsservers Wi-Fi 8.8.8.8 1.1.1.1
```

#### Windows

```powershell
# 以管理员身份运行 PowerShell
Set-DnsClientServerAddress -InterfaceAlias "Wi-Fi" -ServerAddresses ("192.0.2.1")

# 等待 3 分钟

# 恢复
Set-DnsClientServerAddress -InterfaceAlias "Wi-Fi" -ServerAddresses ("8.8.8.8","1.1.1.1")
```

### 4. 验证依赖压制逻辑

模拟底层网络断开（ICMP 探针连续失败）：

```bash
# 断开 WiFi 或拔网线
# 此时 DNS 告警应该被压制，只报物理断网告警
```

### 5. 检查告警详情

打开告警详情抽屉，应该看到：

- **告警标题**：`⚠️ 网页无法加载 (域名解析失败)`
- **详情描述**：归因分析（如"基础网络畅通，但您的当前域名服务器无响应"）
- **建议操作**：具体的修复步骤
- **证据数据**：双轨探测的延迟、状态和解析结果

## 日志关键字

```bash
# 探针成功
[Probe] OK dns-dual-check: 双轨探测正常

# 探针失败（用户态）
[Probe] FAIL dns-dual-check: ENOTFOUND / 用户 DNS 故障，但基准 DNS 正常

# 告警触发
[AlertManager] DNS 告警触发: dns-dual-check, 连续失败 3 次

# 告警恢复
[AlertManager] DNS 告警已恢复: dns-dual-check

# 告警压制
[AlertManager] DNS 告警被压制：底层网络已断开 (dns-dual-check)
```

## 配置位置

- **探针配置**：`src/config/manager.ts` 中的 `DEFAULT_CONFIG.probe.nodes`
- **告警逻辑**：`src/alerting/manager.ts` 中的 `checkDnsProbe()` 方法
- **探针实现**：`src/core/probeRunner.ts` 中的 `probeDnsDual()` 函数
- **假 DNS 服务器**：`~/ClaudeCode/DishyMock/src/probes/dns.ts`
  （用户态 9253 / 基准态 9254）
- **双轨场景**：`~/ClaudeCode/DishyMock/src/scenarios/dns-dual.ts`

## 已知限制

1. 目标域名硬编码为 `google.com`，未来可改为配置项
2. 基准 DNS 固定为 `8.8.8.8`，未来可支持多个备选
3. 探测间隔固定 60 秒，未来可根据故障状态动态调整
4. **用户态解析器在生产环境固定为系统默认 DNS** —— 只有 target 的第三段
   才能指定它。第三段是为测试（打假 DNS）加的，生产配置不要填

## 下一步计划

- [ ] 前端展示双轨对比数据（柱状图对比用户态 vs 基准态延迟）
- [ ] 添加 DNS 解析历史趋势图
- [ ] 支持自定义探测域名和基准 DNS
- [ ] 记录 DNS 探测数据到 telemetry.db（当前仅内存状态）