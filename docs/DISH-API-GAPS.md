# 真机 gRPC 对照：与 dishylink 的底层实现核对结果

> 参考来源：[DaveyHert/dishylink](https://github.com/DaveyHert/dishylink)（master 分支）
> - `schema/dish.protoset`（161 KB，**从真机 reflection 导出**的完整 proto）
> - `LOCAL-API.md`（真机实测记录，硬件 `rev4_panda_prod2`，固件 `2026.07.06.mr81950`）
> - `core/dishClient.ts` / `core/grpcWeb.ts`（它的客户端实现）
> - `scripts/probe-rpcs.mts`（它的 RPC 探测脚本）
>
> 核对时间：2026-11-14。**固件更新后要重新核对。**

## 0. 先说结论

我们和 dishylink 的**协议认知是一致的**（服务名、方法名、分支名、响应键都对），
真正的缺口有 **3 个**（已修 2 个、待办 1 个），另有 **3 条固件限制**需要知道。

## 1. 权威字段对照（来自真机 protoset）

`service SpaceX.API.Device.Device { rpc Handle(Request) returns (Response) }` —— **一元调用** ✓ 与我们一致。

`Request` 的 oneof 分支（proto 里是 snake_case，proto-loader `keepCase:false` 后是我们用的 camelCase）：

| 分支 | 字段号 | 我们用过？ | 真机可用？ |
|---|---|---|---|
| `get_status` → `getStatus` | 1004 | ✅ | ✅ |
| `get_history` → `getHistory` | 1007 | ✅ | ✅ |
| `dish_get_obstruction_map` → `dishGetObstructionMap` | 2008 | ✅ | ✅ |
| `get_device_info` | 1008 | ❌ | ✅ |
| `get_network_interfaces` | 1015 | ❌ | ✅ |
| `get_ping` | 1009 | ❌ | ✅ |
| `dish_get_config` | 2011 | ❌ | ✅ |

`Response` 的对应键（**注意 request 分支名与 response 键名不同**，这点我们没搞错）：
`get_status` → **`dish_get_status`**；`get_history` → **`dish_get_history`**；
`dish_get_obstruction_map` → **`dish_get_obstruction_map`**。

⇒ 我们的 `getStatus→dishGetStatus`、`getHistory→dishGetHistory`、`dishGetObstructionMap→dishGetObstructionMap`
**全部正确**，之前怀疑的"分支名不对"可以排除。

## 2. 缺口一（已修）：传输层 —— 真机有两个端口

| 端口 | 协议 | dishylink 的用法 |
|---|---|---|
| **9200** | 原生 gRPC (HTTP/2) | 只用 `grpcurl describe` 拿 reflection |
| **9201** | **grpc-web (HTTP/1.1)** | **所有 Handle 调用都走这个** |

现象：某些固件上 9200 的 `Handle` 对我们用的请求分支回 `12 UNIMPLEMENTED`，
而 9201 正常（这正是用户在远程 Windows 上看到的报错）。

**已修**：`DishGrpcClient` 增加 grpc-web 传输层
（`src/core/grpcWeb.ts`：1 字节标志 + 4 字节大端长度的手工帧），
原生 gRPC 失败时自动切 9201，并记住选择不再来回试。

坑（dishylink 实测）：dish 对带 `Referer`/`Origin` 的请求会回**空的 200**
（"Referer guard"）⇒ 客户端不能发这两个头。

## 3. 缺口二（已修）：指标该从 `dish_get_history` 取

dishylink 的实测结论：**`dish_get_status` 的数值字段在某些固件上"存在但永远不填"**，
真值在 `dish_get_history` 的 1 Hz 数组里：

| 字段 | `dish_get_status` | `dish_get_history` |
|---|---|---|
| `pop_ping_drop_rate` | 字段存在但可能空 ❌ | ✅ 数组 |
| `pop_ping_latency_ms` | 同上 ⚠️ | ✅ 数组 |
| `downlink/uplink_throughput_bps` | 同上 ⚠️ | ✅ 数组 |
| `power_in` | **没有这个字段** ❌ | ✅ 数组 |
| `pop_ping_drop_rate`/`power_in` 若只从 status 读 | ⇒ **丢包率恒为 0 ⇒ 丢包告警与"全丢包=中断"判定一起失效** | |

**已修**：采集时额外拉一次 `getHistory`，用**最新样本**补齐 status 里缺失的数值
（`src/core/dishClient.ts` 的 `latestHistorySample`）。
`power_in` 我们没有对应字段（无功耗图），不适用。

## 4. 缺口三（待办）：`outages[]` 没解析

`DishGetHistoryResponse.outages[]` = `{ cause, start_timestamp_ns, duration_ns, did_switch }`，
是**设备自己报告的中断事件**（含卫星切换 `did_switch`），比"靠丢包推断中断"可靠得多。

⚠️ 两个坑：
1. `start_timestamp_ns` 是 **GPS epoch**（比 Unix 快 **18 秒**），dishylink 专门做了换算；
2. `duration_ns` / `start_timestamp_ns` 是 int64 ⇒ protobuf 里是 **string**，要转数字。

我们目前完全没用这个字段 ⇒ 中断判定只能靠丢包推断，而丢包又受缺口二影响 ⇒ 双重失效。

## 5. 固件限制（知道即可，别按不存在设计）

| 限制 | 表现 | 对我们的影响 |
|---|---|---|
| dish **没有数字温度** | `TransceiverGetStatus` = Unimplemented；`get_radio_stats.thermalStatus.temp` 不填（只有 `temp2`），且 `get_radio_stats` 是**路由器**的 RPC | 我们不读温度 ✓；温度只能从路由器（192.168.1.1:9001）取 |
| **LAN 写操作被拒** | `status 7 PERMISSION_DENIED`（设置、配置、校准类写） | 写操作要有明确提示，不能报"网络错误" |
| history 缓冲 = **900 样本 @ 1 Hz（15 分钟）** | 每次 `dish_get_history` 返回整个环，18 KB | 我们 30 s 轮询一次 ⇒ ~0.6 kB/s ✓ 无压力；但**长周期图表只能靠本地 SQLite**，设备侧只有 15 分钟 |

## 6. 诊断命令

```powershell
# 双通道对比：原生 gRPC(9200) vs grpc-web(9201)，逐个分支试
& "C:\Program Files\DishyWarden\DishyWarden.exe" --dump-dish-api --enable-logging
```

输出三段：① reflection 拿到的消息/字段名清单；② 两条通道各自哪些分支**真的有数据**
（注意：只看"有没有报错"不够 —— DishyMock 对任何未知分支都回一个只有 `apiVersion`
的空响应，所以判据是**响应里有没有数据键**）；③ 结论。

## 7. 待办

- [ ] 解析 `outages[]` 并接进中断判定（含 GPS epoch +18s 换算）
- [ ] LAN 写操作的明确错误提示（PERMISSION_DENIED ≠ 网络故障）
- [ ] 路由器 API（192.168.1.1:9001）：`wifi_get_clients` / `get_radio_stats` /
      `wifi_get_history` 是**客户端级**吞吐、温度、事件日志的唯一来源
- [ ] 固件升级后重新核对本文件（dishylink 的做法：重跑 grpcurl describe）
