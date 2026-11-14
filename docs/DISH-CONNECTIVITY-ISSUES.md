# 真机连不上 —— 问题档案（2026-11-15）

> 这份文档是**事实记录**，不是教程。按时间顺序记下"看到了什么 / 推断出什么 / 改了什么 / 怎么验证的"。
> 任何新结论请**追加**到对应小节，并写清楚证据来源（哪条命令、哪段日志、哪个文件）。
> 诊断脚本：`scripts/verify-dish.ps1`（纯 ASCII，Windows PowerShell 5.1 可直接跑）。

---

## 0. 一句话结论

设备的 grpc-web(9201) Handle 实测正常（§4）。历史上"连不上"至少有下面四个应用侧缺陷；
2026-11-15 评审又找到几处（见 §9）。**用户机器上仍无数据，根因尚未经现场确认**（§8）。

| # | 缺陷 | 症状 | 状态 |
|---|---|---|---|
| 1 | grpc-web 兜底也需要 9200 做 reflection | 9200 一挂，两条路一起瘫痪，每次 RPC 白等 10s | ✅ 已修（模块级 + 磁盘缓存描述符） |
| 2 | 默认配置是 DishyMock 的 `127.0.0.1` | 连的是本机 mock | ✅ 已修（改成真机默认） |
| 3 | 指标取自 status（真机固件不填这些字段） | 丢包率/延迟/吞吐恒为 0 ⇒ **丢包告警与切换分析是死代码** | ✅ 已修（改从 history 取） |
| 4 | history 是**环形缓冲**，最新样本不在末尾 | 缓冲绕回后指标变成 15 分钟前的值 ⇒ 告警阈值判断失真 | ✅ 已修（按 `current` 计数器定位） |

**9201 的 Handle 能力已实测确认**（见 §4），请求分支命名与我们的实现一致。
9200 的 reflection 是否可用**未测**（§3.1）。

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
| 11-15 | 仪表盘仍无数据 | 可能是设置里填了 9201 | ⏳ 端口已代码容错，但**根因未经现场确认**；评审又发现几处足以单独致"无数据"的缺陷（§9），需用新包重测 |

---

## 3. 关键概念（下一个 agent 必读）

### 3.1 dish 有两套协议

| 端口 | 协议 | 作用 |
|---|---|---|
| **9200** | 原生 gRPC (HTTP/2) | **reflection 在这里**（拿 proto 描述符）+ 部分 Handle 调用 |
| **9201** | grpc-web (HTTP/1.1) | Handle 调用的主力路径（浏览器可直接用） |

⇒ **设置页填 9200**（原生端口）。9201 由应用自动兜底，**不需要手填**。
⇒ **reflection 只在 9200 上**，grpc-web 不提供 ⇒ 描述符一旦拿不到，9201 发得出请求
  （按已知字段号手工编码）但**解不了响应**。
⚠️ **未验证**：真机 9200 的 reflection 是否可用。§4 只证明了 h2c SETTINGS 与 Handle 的行为，
  `verify-dish.ps1` 不测 reflection。这是 §8-1 最该先确认的一条。

### 3.2 UNIMPLEMENTED 的真实含义 ⚠️

实测（`verify-dish.ps1` §3d，grpc-web 9201）：

```
空请求（无分支字段） => http=200 grpc-status=12 bytes=291
```

⇒ 在 **9201** 上，终端回 UNIMPLEMENTED 的含义是 **"你的请求里没有我认识的分支字段"**，
  不是"Handle 方法没实现"。
⚠️ 这条**不能**直接套到 9200：9200 对 §4 里那些在 9201 上可用的分支也回 12，
  所以 9200 的 12 来自别的原因（§8-2，未定论）。

### 3.3 请求/响应字段名

* 请求分支（oneof）与响应字段是**两套名字** ⇒ 实测请求用 `get_*`，响应是 `dish_get_*`。
  例：请求 `get_history`(#1007) ⇒ 响应键 `dish_get_history`。
  （请求侧由 §4 的探针实测；响应键名是按 dishylink protoset / DishyMock 推断的，
  探针只看 grpc-status 不解码 —— 代码对两种键都做了兜底。）
* 例外：遮挡图的**请求**分支就叫 `dish_get_obstruction_map`(#2008)，不是 `get_*`。
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
| `0b82863` | **reflection 端口容错**：配置的端口拿不到描述符时自动回落 9200；日志打印实际端口（评审后收窄：只在配置端口 = grpc-web 端口时回落，见 §9） |
| `176bfc9` | 评审修复，见 §9 |

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
npx vitest run                                # 519 个用例（2026-11-15 评审后）
```

⚠️ DishyMock 的 9201 **不是 grpc-web** ⇒ 本地测不出 grpc-web 的真实传输 ⇒ 最终必须用真机验证。
之前写的"DishyMock 描述符缺 RouterInfo"是误判：RouterInfo 在描述符里，只是 `@grpc/reflection`
发的是**相对**类型名，bufbuild registry 不认（§9-3 已修）。grpc-web 的编解码现在由
`src/core/dishClient.desired.test.ts` 里的本地假 grpc-web 服务覆盖。

---

## 7. 还没做的（下一个 agent 的候选）

按价值排序。详细提示词见 `docs/HANDOFF-PROMPTS.md`。

| # | 事项 | 难度 | 备注 |
|---|---|---|---|
| A | **`outages[]` 字段名 / 单位 / 纪元对齐真机** | 中 | 代码读 `startTimestamp`/`durationMs`（DishyMock 毫秒）；据 dishylink 真机是 `*_ns` ⇒ 纳秒会被当毫秒、时长读成 0 ⇒ 全部误判为切换且时间窗外。比"差 18 秒"严重得多。需真机样本 |
| B | **路由器 API（192.168.1.1:9001）** | 中 | 温度、客户端级吞吐、事件日志都得从那儿取；dish 侧没有数字温度 |
| C | **LAN 写入被拒（status 7 PERMISSION_DENIED）** | 低 | UX 问题：现在会被当成网络错误 |
| D | ~~两次 history 调用合并成一次~~ | — | ✅ 评审已做（§9-6） |
| E | **告警阈值默认值校准** | 低 | 真机数据到位后重新标定 `highPacketLoss` / `highLatencyMs` |
| F | **文件日志落盘（`%APPDATA%\DishyWarden\logs\`）** | 低 | 现在只能靠 `--enable-logging` 看控制台 |
| G | **Windows `<1ms` RTT 解析** | 低 | `src/core/pingParse.ts` |

---

## 8. 已知未解 / 需要现场信息的问题

1. **用户那台机器上，仪表盘仍无数据** —— 需要**用当前 main 构建的新包**跑出的
   `--dump-dish-api` 与 `--enable-logging` 完整输出（旧包日志不能区分 §9 的几个缺陷）。
   候选原因（没有现场日志之前都只是假设，按应排查的顺序）：
   a. 9200 的 reflection 在真机上不可用 ⇒ 无描述符 ⇒ grpc-web 解不了响应
      （看日志有没有 `reflection 成功（端口 9200）`）
   b. registry 建不起来（`[DishGrpc] 描述符不完整, registry 不可用: ...`）——
      §9-3 修了相对类型名 / 缺 import 这一类，真机若仍报，记下缺的类型名
   c. 设置里端口填了 9201（已代码容错，日志会打印实际端口）
   d. §9-1 / §9-4：旧包里 grpc-web 的请求编码总是退化成手工字段号；
      reflection 返回传递依赖时原生通道建不起来
2. **9200 的 Handle 为何对所有分支回 UNIMPLEMENTED** —— 未定论。
   可能该固件只实现 grpc-web 入口；也可能 9200 需要特定握手。
   dishylink 在别的固件上用 9200 是正常的。
3. **Windows 侧 `pingParse` 对 `<1ms` 的处理** —— 可能是显示问题，不影响采集。

---

## 9. 2026-11-15 评审发现并修复的缺陷

证据都是本地可复现的实验或回归测试（`src/core/dishClient.desired.test.ts`，
本地起 `@grpc/reflection` + 假 grpc-web 服务），**没有一条经过真机验证**。

| # | 缺陷 | 证据 | 修法 |
|---|---|---|---|
| 1 | grpc-web 请求编码把 oneof 成员写成顶层属性 `{[field.name]: …}`；bufbuild v2 的 `toBinary` 直接抛 `Cannot read properties of undefined (reading 'case')`，被 catch 吞掉 ⇒ **永远退化成手工字段号编码**，不在 `KNOWN_FIELD_NUMBERS` 里的分支根本发不出去 | 最小复现：同一 Request 用两种写法编码，旧写法抛错，`{request:{case,value}}` 得 `0807e23e00` | 改用 `{[oneof.localName]: {case, value}}` |
| 2 | 模块级描述符缓存不分设备：设置里从 127.0.0.1 切到 192.168.100.1 后，仍用 mock 的描述符；磁盘缓存同理 | 代码路径（`moduleDescriptorCache` 是单值，`dish-descriptor.bin` 单文件） | 模块缓存按 host 分键并记下 nativePort；磁盘缓存按 host 分文件 `dish-descriptor-<host>.bin` |
| 3 | `@grpc/reflection` 发的是**相对**类型名（`RouterInfo`），且 `dependency` 为空；bufbuild registry 只认全限定名 ⇒ `type_name RouterInfo not found` ⇒ grpc-web 解不了码。之前在 §6.2 被误判成"mock 缺 RouterInfo" | 本地 DishyMock 描述符：26 个 typeName 全是相对名，RouterInfo 实际已定义 | 建 registry 前按 protoc 作用域规则补全限定名、补 import、按依赖拓扑排序；reflection 补依赖时也按包作用域展开相对名 |
| 4 | 标准 reflection 对 `fileContainingSymbol` 返回"文件 + 全部传递依赖"，按类型名补依赖会把同一文件收多次；proto-loader 遇重复文件直接抛 `duplicate name` ⇒ 原生通道建不起来 | 最小复现：同一 FileDescriptorProto 放两次，proto-loader 抛错（bufbuild 不抛） | 按文件名去重；已定义的类型不再请求；空错误响应也扣 inFlight（原来只看 errorMessage 非空，空消息时流不会结束，只能等 10s 超时） |
| 5 | 端口回落顺序是 [配置端口, 9200]：配置成 9201 时先在 HTTP/1.1 端口上做 HTTP/2 reflection，可能白等满超时；且对**任意**非 9200 端口都回落，可能静默连上同机 9200 上的别的服务 | 代码路径 | 只在配置端口 = grpc-web 端口时回落，直接试 9200；其它自定义端口不回落 |
| 6 | `getTelemetry()` 与 `analyzeHandoffs()` 每轮各拉一次 history（22KB × 2 / 30s），并发时还各跑一条 reflection 流 | 代码路径 | `DishClient.getHistoryResponse()` 合并并发请求、5s 内复用；`resolveDescriptor()` 合并并发；reflection 失败后 15s 内直接复用错误（否则一帧里三处各等 10s） |
| 7 | 遮挡图 60KB 每 30s 拉一次；status/history/遮挡图串行，撞 10s 采集预算 | 实测字节数 §4；historian 10s 超时 | 遮挡图 5 分钟刷新一次，间隔内沿用上一份图和它的 avgSnr；status 与 history 并发 |
| 8 | 原生与 grpc-web 都失败时只抛原生错误：9200 拒连（code 14）+ 9201 回 12 时，`callWithFallback` 看不到 12，不会试下一个候选分支 | 代码路径 | 抛出的错误同时带两条信息 |
| 9 | `--dump-dish-api` 不传 webPort（总打 9201）；`rawDescriptorBytes()` 绕过端口回落和缓存，配置 9201 时诊断的 [1] 段必失败 | 代码路径 | 传 webPort；诊断走与采集相同的 `resolveDescriptor()` |
| 10 | registry 构建失败后每次 RPC 都重建并刷一条告警日志 | 本地 mock 跑一帧出现 5 条相同告警 | 失败一次后记住 |
| 11 | `latestHistorySample` 用 `popPingLatencyMs` 的长度做环形基准，该数组缺失时其它数组退回取末尾 | 代码路径 | 每个数组按自身长度取模 |
| 12 | **grpc-web 请求带了 `sec-fetch-mode: cors`**：Node 的 `fetch`（undici）会自动加这个浏览器头；而 dish 有 "Referer guard"（带 Referer/Origin 的请求回空 200）。⇒ **裸 TCP 探针（不带这些头）能通，应用的 fetch 请求却被挡** —— 探针与应用的请求不等价，排查时极具误导性 | 本地实测：Node fetch 收到的头含 `sec-fetch-mode: cors`；`grpcWeb.ts` 注释记录了 dish 的 Referer guard | 主进程改用 `node:http`（`src/core/grpcWebNode.ts`），请求头完全可控、不带任何 `sec-fetch-*`；加回归测试断言这些头不存在 |

**对用户四个已修根因的复核结论**：
* 根因 1（描述符缓存）：方向对，但有缺陷 2、3、4、6
* 根因 2（默认配置）：`src/config/manager.ts` 与 `DishClient` / `DataCollector` 构造器默认值一致（192.168.100.1 / 9200 / 9201 / 192.168.1.1）✓
* 根因 3（指标改从 history 取）：`pick()` 的优先级是 status 有值用 status、否则 history ✓；
  但 history 取的是**最新 1 秒**的样本，30s 采集周期下丢包率单点很抖（已写进 P3 提示词）
* 根因 4（环形索引）：`(current - 1) % arrayLength` 与 dishylink 描述一致 ✓；补了缺陷 11

**仍未处理（超出本次可改范围或需真机）**：
* `src/core/outageTypes.ts` / `outageAnalyzer.ts` 的字段名与单位（§7-A）——不在本次可改文件范围
* grpc-web 请求头已核对：`content-type: application/grpc-web+proto`、`x-grpc-web: 1`，
  不发 Referer/Origin ✓。Node fetch 会自带 `sec-fetch-mode: cors`（本地实测），
  而 `grpcWeb.ts` 注释说 dish 会拒 `sec-fetch-*`。§4 的探针是裸 TCP，不带这个头 ⇒
  **应用的 fetch 与探针并不等价**。需要真机确认；若被拒，应改用 `node:http`
  （`grpcWeb.ts` 不在本次可改范围）
