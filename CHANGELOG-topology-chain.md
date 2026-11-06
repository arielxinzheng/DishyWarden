# 变更记录：仪表盘全链路拓扑状态链

**日期**: 2026-11-06
**范围**: `src/renderer/components/Dashboard/topologyModel.ts`（新增）、
`TopologyChain.tsx`（新增）、`topologyModel.test.ts`（新增）、`index.tsx`（挂载）
**状态**: 单测 + Electron 实机验收通过

> 相关总览见 [`DEVELOPMENT-STATUS.md`](./DEVELOPMENT-STATUS.md)。

---

## 1. 它解决什么问题

仪表盘原来只有「状态 / 对准 / 运行时间 / 中断次数 / 连接状态」5 块并列指标和折线图。
这些都在回答「数值是多少」，**没有一个东西回答「现在到底哪一段坏了」**。

拓扑链就是那个视觉锚点：

```
[💻 用户终端] ──局域网── [🖧 本地路由器] ──gRPC 9200── [📡 星链天线] ──PoP 出口── [🌐 互联网]
```

位置：全局状态条（5 块 overview band）之下、折线图卡之上。
断流横幅排在它上面是刻意的——数据陈旧时「拓扑全绿」是最误导人的画面。

## 2. 三条链路的数据源与判据

| 链路 | 数据源 | 判据（自上而下短路） |
|---|---|---|
| **lan** 终端→路由器 | `getRouterProbe()`：本地网关 ICMP + 保留地址基线自检 | 探测不可信 → 🟡未知；不可达 → 🔴断；丢包≥50% → 🔴断；≥10% → 🟠降级；否则 🟢 |
| **grpc** 路由器→天线 | `useDish()` 的遥测 + `isConnected`（采集链路是否在推数据） | 上游已断 → 🟡未知；无遥测且报错 → 🔴断；有遥测但不推了 → 🔴断；否则 🟢 |
| **wan** 天线→公网 | `popPingLatencyMs` / `popPingDropRate` + DNS 双轨探针 | 上游已断 → 🟡未知；天线未锁定（非 ONLINE）→ 🟡未知；PoP 100% 丢包或延迟为 0 → 🔴断；DNS 双轨全挂 → 🔴断；本机 DNS 挂但基准正常 → 🟠降级；PoP 丢包≥10% → 🟠降级；否则 🟢 |

## 3. 相对原始需求的三处修正（都是「避免假信息」）

1. **`trusted === false` → 灰色而不是绿色**
   需求写「Ping 正常则绿」。但某些环境（VPN / 隧道 / 安全软件）会**应答所有 ICMP**：
   实测连 RFC 5737 保留地址 `192.0.2.1` 都能 ping 通，此时「可达 / 0% 丢包 / 0.1ms」
   全是环境造出来的假象（`RouterProbe` 自带基线自检，见 `routerProbeShape.ts`）。
   这种情况渲染 🟡「状态未知」，且**不展示那个假 RTT**。

2. **`state !== 'ONLINE'` → 灰色而不是红色**
   需求写「gRPC 通畅但 PoP 100% 丢包 ⇒ 天线到卫星断了」。但天线在**开机 / 寻星 /
   收起**时同样会 100% 丢包——这是「还没连上」，不是「链路故障」。
   直接标红会让用户以为该去检查硬件，实际只需要等十几秒。

3. **只认第一个断点，下游一律灰色**
   上游断了，下游不是「也坏了」而是「测不出来」。否则一次路由器掉线会让三条链路
   全红、满屏飘红，用户根本不知道该修哪。实现上：`lan` 断 ⇒ `grpc` 与 `wan` 强制
   `unknown`，且节点不再展示**残留的旧读数**（否则会出现「采集中断」旁边挂着
   「误差 0.4°」这种自相矛盾的画面）。

## 4. 与告警系统的联动

**单向**：告警 → 拓扑（不新增告警规则，避免与既有 19 条规则重复报警）。

- 规则到链路的静态归属表（`ALERT_LINK_MAP`）：
  - `router_offline` → lan
  - `cable_connectivity` / `dish_offline` / `motors_stowed` / `poe_power` / `collector_heartbeat_lost` / `alignment_issue` → grpc
  - `high_latency` / `high_packet_loss` / `low_throughput` / `low_snr` / `obstruction_detected` / `severe_weather` / `dns_failure` / `frequent_searching` / `service_*` / `roaming` → wan
  - 不在表里的规则（`wifi_signal` 等）**不参与**——强行归类会让人以为「WiFi 弱 = 网线断」
- 节点右上角显示红色角标（条数），悬停列出 summary，点击打开告警抽屉
- 头部在「全链路正常」旁边额外显示「N 条告警」——链路健康 ≠ 没有告警
- ⚠️ **告警不改变颜色**：颜色只由实测数据决定。告警可能刚 resolve 而探测已恢复，
  反过来也可能数据健康但告警还在窗口期内

## 5. 验收记录

| 项 | 结果 |
|---|---|
| `tsc -p tsconfig.json` / `tsconfig.electron.json` | 0 错误 / 0 错误 |
| `vitest run` | **20 文件 / 284 测试全过**（新增 21 项拓扑判据用例） |
| 浏览器实渲染（注入桩数据） | 全绿态 / 局域网断线态 / 链路绿但 2 条告警态，控制台 0 报错 |
| Electron 实机 | 拓扑区渲染正常；本环境探针被判定「不可信」→ 局域网段如实显示 🟡「状态未知」且不显示假 RTT（这正是规则 1 生效） |
| 其他页面回归 | `/alerts`、`/alignment` 均 0 报错 |

## 6. 已知遗留

1. **拓扑指标尚未进 Prometheus**。判据已抽成纯函数（`buildTopology`），
   将来导出 `starlink_topology_link_up{link="lan|grpc|wan"}` 只需在 exporter 里调一次。
2. **DNS 双轨探针不是必配项**。未配置节点时 `dnsProbe` 为 null，WAN 段只看 PoP
   指标——这是有意的降级，不是漏判。
3. 移动端/窄窗口：链路主体最小宽度 760px，更窄时横向滚动（不做竖排链路，
   竖排会让「哪段断了」的横向对齐语义丢失）。
