# 真机连不上 —— 问题档案（2026-11-15）

> 这份文档是**事实记录**，不是教程。按时间顺序记下"看到了什么 / 推断出什么 / 改了什么 / 怎么验证的"。
> 任何新结论请**追加**到对应小节，并写清楚证据来源（哪条命令、哪段日志、哪个文件）。
> 诊断脚本：`scripts/verify-dish.ps1`（纯 ASCII，Windows PowerShell 5.1 可直接跑）。

---

## 0. 一句话结论

设备**完全正常**。历史上"连不上"是**四个叠加的应用侧缺陷**造成的：

| # | 缺陷 | 症状 | 状态 |
|---|---|---|---|
| 1 | grpc-web 兜底也需要 9200 做 reflection | 9200 一挂，两条路一起瘫痪，每次 RPC 白等 10s | ✅ 已修（模块级 + 磁盘缓存描述符） |
| 2 | 默认配置是 DishyMock 的 `127.0.0.1` | 连的是本机 mock | ✅ 已修（改成真机默认） |
| 3 | 指标取自 status（真机固件不填这些字段） | 丢包率/延迟/吞吐恒为 0 ⇒ **丢包告警与切换分析是死代码** | ✅ 已修（改从 history 取） |
| 4 | history 是**环形缓冲**，最新样本不在末尾 | 缓冲绕回后指标变成 15 分钟前的值 ⇒ 告警阈值判断失真 | ✅ 已修（按 `current` 计数器定位） |

**设备侧能力已实测确认**（见 §4），分支命名与我们的实现一致。

---

## 1. 环境（用户那台远程 Windows）

```
主机      Windows 10 19045 (9L3123JF7EY0MO9), 用户 Administrator
IP        192.168.1.103 / 192.168.1.55 (WLAN) + 10.233.9.120 (ZeroTier)
          + 192.168.87.1 / 192.168.139.1 (VMware VMnet8/VMnet1)
设备      dish 192.168.100.1（不在同一 L2 段，走默认网关）
路由器    192.168.1.1:80 可达（Starlink 路由器）
代理      WinHTTP: none；WinINET ProxyEnable=0；无 TUN 网卡（只有 WeChatAppEx）
```

⚠️ 主机**不在** 192.168.100.0/24，dish 是跨路由可达的（靠路由器转发）。

---

## 2. 症状时间线

| 时间 | 现象 | 当时的判断 | 现在 |
|---|---|---|---|
| 早期 | `SLMonitor.exe` 闪退 | NSIS per-user 调 `SHGetKnownFolderPath` 崩溃 | ✅ 改 `perMachine` |
| 早期 | 黑屏 | `BrowserRouter` 在 `file://` 下失效 | ✅ 改 `HashRouter` |
| 11-13 | `getHistory 失败: 12 UNIMPLEMENTED` | 以为"方法没实现" | ❌ **误判**，见 §4 |
| 11-14 | `ECONNREFUSED 192.168.100.1:9200` + `grpc-web 兜底也失败: reflection 超时 (10s)` | 9200 当时不通 | ✅ 循环依赖，已修 |
| 11-15 | 仪表盘仍无数据 | 可能是设置里填了 9201 | ✅ 已做成代码容错 + 日志可见 |

---

## 3. 关键概念（下一个 agent 必读）

### 3.1 dish 有两套协议

| 端口 | 协议 | 作用 |
|---|---|---|
| **9200** | 原生 gRPC (HTTP/2) | **reflection 在这里**（拿 proto 描述符）+ 部分 Handle 调用 |
| **9201** | grpc-web (HTTP/1.1) | Handle 调用的主力路径（浏览器可直接用） |

⇒ **设置页填 9200**（原生端口）。9201 由应用自动兜底，**不需要手填**。
⇒ **reflection 只在 9200 上**，grpc-web 不提供 ⇒ 描述符一旦拿不到，9201 也用不了。

### 3.2 UNIMPLEMENTED 的真实含义 ⚠️

实测（`verify-dish.ps1` §3d，grpc-web 9201）：

```
空请求（无分支字段） => http=200 grpc-status=12 bytes=291
```

⇒ 终端回 UNIMPLEMENTED **不是**"这个方法没实现"，而是 **"你的请求里没有我认识的分支字段"**。

### 3.3 请求/响应字段名

* 请求分支（oneof）与响应字段是**两套名字** ⇒ 实测请求用 `get_*`，响应是 `dish_get_*`。
  例：请求 `get_history`(#1007) ⇒ 响应键 `dish_get_history`。
* 不同固件命名会变（dishylink 的 protoset 与本机 mock 就不同）⇒ 应用**按设备描述符推导**分支名。

### 3.4 history 是环形缓冲 ⚠️

dishylink `decodeHistoryWindow` 的原话：

> each array holds the last `arrayLength` samples at one sample per second,
> where **absolute sample counter `c` lives at index `c % arrayLength`**.

⇒ 最新样本下标 = **`(current - 1) % arrayLength`**（`current` = 自启动以来的样本计数）。
⇒ **取数组末尾是错的**（绕回后拿到最旧样本）。900 样本 @1Hz ⇒ 15 分钟就绕回。

---

## 4. 设备侧实测能力清单（2026-11-15，grpc-web 9201）

| 字段号 | 分支 | grpc-status | 字节 | 结论 |
|---|---|---|---|---|
| 1004 | `get_status` | 0 | 835 | ✅ |
| 1007 | `get_history` | 0 | 22,446 | ✅（900 样本环形缓冲） |
| 2006 | `dish_get_history` | 12 | 291 | ❌ 本固件没有 |
| 2008 | `dish_get_obstruction_map` | 0 | 60,803 | ✅（60KB！） |
| 1008 | `get_device_info` | 0 | 412 | ✅ |
| — | 空请求 | 12 | 291 | 基准 |

其它已验证事实：
* 9200 TCP 通、h2c 握手回 SETTINGS 帧 ⇒ 原生 gRPC 服务在（但 Handle 对这些分支回 UNIMPLEMENTED）
* 控制端口 45999 被拒 ⇒ 无代理劫持（否则上面的结果不可信）
* 路由器 `192.168.1.1:80` 可达

---

## 5. 已改动的代码（提交号）

| 提交 | 内容 |
|---|---|
| `9e3ec8f` | 默认配置改真机：`dishAddress=192.168.100.1` / `dishPort=9200` / `dishWebPort=9201` / `routerAddress=192.168.1.1` |
| `b088014` | `registry.getMessage` 空值检查 |
| `24a3a60` | 模块级描述符缓存（打破 grpc-web 对 9200 reflection 的循环依赖） |
| `629032c` | 描述符**磁盘**缓存（跨重启）+ `verify-dish.ps1` 补测 9201 |
| `304b748` | 分支名按设备描述符推导 + `--dump-dish-api` 打印 Request 字段清单 |
| `1e7edc3` | 探针读满整个响应（grpc-status 在 trailers 帧里） |
| `2c39ce1` | **history 环形缓冲**：`latestHistorySample` 按 `current` 定位最新样本 |
| `c9298a8` | 遮挡图响应键兜底 + 真机能力清单文档 |
| （本提交） | **reflection 端口容错**：配置的端口拿不到描述符时自动回落 9200；日志打印实际端口 |

关键文件：
* `src/core/dishGrpc.ts` —— 传输层（native / grpc-web 双通道 + 描述符缓存 + 端口回落）
* `src/core/dishClient.ts` —— 遥测组装 + `latestHistorySample`（环形索引）
* `src/core/grpcWeb.ts` —— grpc-web 帧编解码
* `src/main/dishApiDump.ts` —— `--dump-dish-api` 诊断
* `scripts/verify-dish.ps1` —— 远程 Windows 诊断脚本（纯 ASCII）

---

## 6. 怎么复现 / 验证

### 6.1 远程 Windows 上

```powershell
# ① 网络层
powershell -ExecutionPolicy Bypass -File .\verify-dish.ps1
#    看 §3/§3c/§3d：9200 TCP、9201 TCP、每个分支的 grpc-status

# ② 应用层（最强证据）
& ".\DishyWarden.exe" --dump-dish-api --enable-logging
#    [1] Request 字段清单（这台固件的真实分支名 + 字段号）
#    [2] 原生 9200 段 / grpc-web 9201 段各分支是否可用
#    [3] 结论

# ③ 正常跑，看仪表盘数字是否随时间变化
& ".\DishyWarden.exe" --enable-logging
```

### 6.2 本地开发

```bash
npm run dev                                   # 需 DishyMock 在 127.0.0.1:9200
npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.electron.json
npx vitest run                                # 510 个用例
```

⚠️ DishyMock 的 9201 **不是 grpc-web**，且它的描述符不完整（缺 RouterInfo）⇒
本地**测不出** grpc-web 通道 ⇒ 必须用真机验证。

---

## 7. 还没做的（下一个 agent 的候选）

按价值排序。详细提示词见 `docs/HANDOFF-PROMPTS.md`。

| # | 事项 | 难度 | 备注 |
|---|---|---|---|
| A | **`outages[]` 解析 + GPS epoch（+18s）** | 中 | dishylink 明确指出时间戳是 GPS epoch，与 Unix 差 18 秒 ⇒ 直接用会让"中断时刻"错 18 秒 |
| B | **路由器 API（192.168.1.1:9001）** | 中 | 温度、客户端级吞吐、事件日志都得从那儿取；dish 侧没有数字温度 |
| C | **LAN 写入被拒（status 7 PERMISSION_DENIED）** | 低 | UX 问题：现在会被当成网络错误 |
| D | **两次 history 调用合并成一次** | 低 | 现在 22KB × 2 / 30s |
| E | **告警阈值默认值校准** | 低 | 真机数据到位后重新标定 `highPacketLoss` / `highLatencyMs` |
| F | **文件日志落盘（`%APPDATA%\DishyWarden\logs\`）** | 低 | 现在只能靠 `--enable-logging` 看控制台 |
| G | **Windows `<1ms` RTT 解析** | 低 | `src/core/pingParse.ts` |

---

## 8. 已知未解 / 需要现场信息的问题

1. **用户那台机器上，仪表盘仍无数据** —— 需要 `--dump-dish-api` 的完整输出。
   最可能：设置里端口填了 9201（现在已代码容错 + 日志会打印实际端口）；
   次可能：设备的 proto 描述符让严格 registry 建不起来
   （日志会出现 `[DishGrpc] 描述符不完整, registry 不可用: ...`）。
2. **9200 的 Handle 为何对所有分支回 UNIMPLEMENTED** —— 未定论。
   可能该固件只实现 grpc-web 入口；也可能 9200 需要特定握手。
   dishylink 在别的固件上用 9200 是正常的。
3. **Windows 侧 `pingParse` 对 `<1ms` 的处理** —— 可能是显示问题，不影响采集。
