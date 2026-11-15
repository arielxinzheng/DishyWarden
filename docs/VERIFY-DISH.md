# 在（远程）Windows 上验证星链 Dish 地址与端口

**目标**：确认 `192.168.100.1:9200`（Dish 的 gRPC）在那台 Windows 机器上真的通。
**脚本**：[`scripts/verify-dish.ps1`](../scripts/verify-dish.ps1)（纯 ASCII，PowerShell 5.1 可用）。

---

## 0. 先记住三条判据

| # | 判据 | 为什么 |
|---|---|---|
| 1 | **TCP 能连上 9200** | 端口层通了。但**这不算证据**，见下条 |
| 2 | **控制端口必须被拒**（如 `45999`） | TUN 代理（Clash/Surge/Verge/V2Ray）、VPN、AV 网页防护会**接受任意地址任意端口**。控制端口也"通" ⇒ 前面全是假象 |
| 3 | **HTTP/2 握手下发 SETTINGS 帧** | 真 gRPC 服务收到 HTTP/2 preface 会回 `SETTINGS`（帧类型 `0x04`）。代理/假服务只会沉默或重置 |

只有 1+2+3 同时成立，才能说"这个端口是星链的 gRPC"。

> 我们真实踩过：本机 Mac 装了 TUN 模式代理，`192.168.100.1` 被 fake-IP 段（`198.18.0.1`）劫持，
> 在没有星链的环境里 `Test-NetConnection` 也返回 `True`。所以脚本里那个控制端口检测是必须的。

---

## 1. 在远程 Windows 上放脚本（四选一）

### 1.0 「打开方式 → PowerShell」跑完窗口就没了？（已修）

Windows 的「打开方式 → PowerShell」会开一个**临时控制台**，脚本一结束窗口立刻关闭，
输出刷一下就没了。脚本现在自带两个对策：

1. **结尾停在「按回车关闭」** —— 窗口不会自己关，结果看得完；
2. **自动把整份报告写盘**（脚本同目录，`verify-dish-<时间戳>.txt`）——
   即使窗口被误关，报告还在。

```powershell
# 默认行为：跑完停住等回车 + 写报告文件
powershell -ExecutionPolicy Bypass -File C:\Users\Public\verify-dish.ps1

# 不想停（自动化 / 已开着 PowerShell 窗口时）
powershell -ExecutionPolicy Bypass -File C:\Users\Public\verify-dish.ps1 -NoPause

# 指定报告路径
powershell -ExecutionPolicy Bypass -File C:\Users\Public\verify-dish.ps1 -ReportPath C:\Users\Public\dish-check.txt
```

想在**已有的** PowerShell 窗口里看结果，就不要用「打开方式」，直接在这个窗口里跑：

```powershell
& C:\Users\Public\verify-dish.ps1          # 输出直接刷在当前窗口
# 或
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\Public\verify-dish.ps1 | Tee-Object C:\Users\Public\dish-check.txt
```

报告文件是 **UTF-8 with BOM**，记事本直接打开不乱码；若在 cmd 里 `type` 出现乱码，
用 `Get-Content -Encoding UTF8` 读即可。

### 1.1 必须同时看 9200 和 9201（dish 有两套协议）

| 端口 | 协议 | 作用 |
|---|---|---|
| **9200** | 原生 gRPC (HTTP/2) | reflection（拿 proto 描述符）+ 部分 Handle 调用 |
| **9201** | **grpc-web (HTTP/1.1)** | Handle 调用的主力路径（应用在 9200 不通时自动切这里） |

`verify-dish.ps1` 现在会测两个端口：

- **§3 / §4**：9200 的 TCP + HTTP/2 SETTINGS 握手
- **§3c / §3d**：9201 的 TCP + grpc-web POST 探测（看 `http=` 与 `grpc-status=`）

⚠️ **一个隐蔽的依赖**：proto 描述符只能通过 **9200 上的 reflection** 取得，
而 grpc-web(9201) 的请求/响应都要靠它编解码 ⇒ **9200 整个挂掉时，
9201 也会跟着瘫痪**（日志里表现为 `grpc-web 兜底也失败: reflection 超时 (10s)`）。
应用为此做了两层缓存：进程内缓存 + 磁盘缓存（`%APPDATA%\DishyWarden\dish-descriptor.bin`），
所以只要 9200 成功过一次，之后它挂了也不影响 9201 工作。

### A. RDP + 剪贴板（最快）
1. 本地打开 `scripts/verify-dish.ps1`，全选复制（RDP 默认开着剪贴板重定向）
2. 远程 Windows 的 PowerShell 里：
```powershell
notepad C:\Users\Public\verify-dish.ps1     # 粘贴 → 保存 → 关掉
powershell -ExecutionPolicy Bypass -File C:\Users\Public\verify-dish.ps1
Tee-Object 结果：加 | Tee-Object -FilePath C:\Users\Public\dish-check.txt
```
> 别放在 `\\tsclient\`（RDP 驱动器重定向）里直接跑 —— 执行策略/杀软常拦网络路径上的脚本。

### B. WinRM（管理员 PowerShell，一次搞定 + 结果自动回传）
```powershell
Invoke-Command -ComputerName <WINDOWS_HOST> -Credential (Get-Credential) `
  -FilePath .\scripts\verify-dish.ps1 | Tee-Object -FilePath .\dish-check.txt
```
（远程需已启用 WinRM：`Enable-PSRemoting -Force`）

### C. SSH（远程装了 OpenSSH Server）
```bash
scp scripts/verify-dish.ps1 <WINDOWS_USER>@<WINDOWS_HOST>:C:/Users/Public/
ssh <WINDOWS_USER>@<WINDOWS_HOST> powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/Public/verify-dish.ps1
```

### D. 一行版（不想传文件，直接粘进远程 PowerShell）
```powershell
$ip='192.168.100.1'
"9200  : " + (Test-NetConnection $ip -Port 9200  -WarningAction SilentlyContinue).TcpTestSucceeded
"45999 : " + (Test-NetConnection $ip -Port 45999 -WarningAction SilentlyContinue).TcpTestSucceeded
```
读法：`9200=True 且 45999=False` ⇒ 端口层通过（还需 §2 协议/应用确认）；
`两个都 True` ⇒ 代理在接管，先解决代理。

---

## 2. 结论怎么读

| 脚本输出 | 含义 | 下一步 |
|---|---|---|
| `VALID: TCP open + HTTP/2 answers` | 就是星链的 gRPC | 设置页把设备地址改成 `192.168.100.1`、端口 `9200`，保存后点「重试连接」 |
| `INVALID: proxy/tunnel is intercepting` | 代理/TUN 劫持 | 退出代理客户端，或给 `192.168.100.0/24` 加直连规则（Clash: `IP-CIDR,192.168.100.0/24,DIRECT`），再重跑 |
| `SUSPICIOUS: TCP open but no HTTP/2` | 端口上有东西但不是 gRPC | 确认端口号是否被改过；确认不是别的服务占着；用 §3 应用自证 |
| `NOT REACHABLE` | 到不了 | 看 §4 拓扑，或防火墙/AV/终端没上电 |

---

## 3. 最强验证：让应用自己作证（推荐作为最终判据）

脚本只能证明"端口/协议对"，**只有应用能证明"数据真的采到了"**：

```powershell
cd "C:\Program Files\DishyWarden"
.\DishyWarden.exe --enable-logging
```

（从 cmd/PowerShell 启动会保留控制台，日志直接打在窗口里）

| 日志 | 含义 |
|---|---|
| `[Collector] 历史库已就绪: …\data\telemetry.db` | 本地库正常（与 Dish 无关） |
| `[Main] All background services started successfully` | 服务起来了 |
| `[Main] Page loaded successfully` | 界面加载（**黑屏会是这行之后没有 DOM**，与本问题无关） |
| **没有** `Dish 采集失败` 且仪表盘出现延迟/丢包/吞吐数字 | ✅ **Dish 连通成功** |
| `Dish 采集失败: … ECONNREFUSED 127.0.0.1:9200` | ⚠️ 配置里还是 **DishyMock 的 `127.0.0.1`**（默认值已改成真机的 `192.168.100.1`，但老配置的 config.json 不会被自动改），去设置页改成 `192.168.100.1` |
| `Dish 采集失败: … 14 UNAVAILABLE … 192.168.100.1:9200` | 地址对但连不上 ⇒ 回看 §1 的 TCP/h2c 结论 |

界面里也有自证：「未找到 Starlink 设备」引导页底部会写 **「当前目标 127.0.0.1:9200」**，
点「重试连接」后如果变成仪表盘有数据，就是通了。

---

## 4. 网络拓扑前提（最常见的"不是 bug"的情况）

| 设备 | 默认地址 | 说明 |
|---|---|---|
| Dish（终端）gRPC | `192.168.100.1:9200` | 内部链路 `192.168.100.0/24` |
| Starlink 路由器 LAN 网关 | `192.168.1.1` | Gen2/Gen3 出厂默认 |

- **PC 挂在 Starlink 路由器后面（`192.168.1.x`）**：默认情况下 **到不了** `192.168.100.1`
  （路由器不为这条内部链路做转发）。这不是软件问题。
- 能通的做法：① PC 用 PoE 注入器**直连终端**（会拿到 `192.168.100.x` 租约）；
  ② 路由器切**旁路/桥接模式**（你自己的路由器 WAN 落在 `192.168.100.x`）；
  ③ 在你自己的路由器上加静态路由（多数消费级路由器不转发，实测常失败）。

判据：`ipconfig` 里有没有 `192.168.100.x` 的地址、`route print` 里到 `192.168.100.1`
是不是走默认网关（走默认网关 = 大概率不通）。

---

## 5. 远程机专属注意事项

- **测的是那台机器的网络栈**：RDP/SSH 进去跑，结果就是它自己的连通性，可信。
  不要在本机测完推断远程结果。
- 若远程机通过**跳板机/VPN**接入，注意它的默认路由可能被 VPN 改写
  （脚本 §0 会打出 WinHTTP/IE 代理与隧道网卡，§6 会打出路由）。
- **杀软/EDM**：360/火绒/奇安信可能拦 `nc`/`curl`/PowerShell 的原始 TCP。
  脚本用 .NET `TcpClient`，被拦时表现为"无响应" ⇒ 临时给 PowerShell 放行再测。
- **结果取回**：`Invoke-Command` 的输出会随管道回本地；RDP 里跑就加
  `| Tee-Object -FilePath C:\Users\Public\dish-check.txt`，再用剪贴板/`scp` 拿回来。
  贴日志给我时，把 §0/§3b/§4 三段和 `VERDICT` 一起贴就够了。

---

## 6. 一句话流程

```text
远程机上跑 verify-dish.ps1
  → 若 INVALID：先关代理/TUN，重跑
  → 若 NOT REACHABLE：先看是否在 192.168.100.x 网段（拓扑问题）
  → 若 VALID/SUSPICIOUS：改设置页地址为 192.168.100.1:9200
  → 用 --enable-logging 启动，仪表盘有数据 = 最终确认
```

---

## 7. 直接用 PowerShell 启动（比双击更适合排查）

`.exe` 不受 `ExecutionPolicy` 限制（那条只管 `.ps1`），路径含空格记得引号；
安装在 `Program Files` 但应用只读、只写 `%APPDATA%\DishyWarden` ⇒ **不需要管理员**。

### A. 要日志落文件（推荐，已实测）

```powershell
$exe = 'C:\Program Files\DishyWarden\DishyWarden.exe'
$log = "$env:TEMP\dw-launch.log"
Start-Process cmd.exe -WindowStyle Hidden -PassThru `
  -ArgumentList ('/c ""' + $exe + '" --enable-logging > "' + $log + '" 2>&1"') | Out-Null
Start-Sleep 15
Get-Content $log -TotalCount 10          # 看启动日志
Select-String -Path $log -Pattern 'Collector|采集失败|UNAVAILABLE|Page loaded'
```

实测（Parallels Windows 11，装到 `Program Files`）：进程 4 个存活、日志正常生成 ✓。

> ⚠️ 实测坑：PowerShell 的 `Start-Process -RedirectStandardError/-RedirectStandardOutput`
> 对 Electron **抓不到任何内容（0 字节）**，而且进程会很快退出。
> `--enable-logging` 是写 stderr，但只有“重定向到**文件**”（cmd 的 `>`）才拿得到。

### B. 日志直接打在窗口里（会阻塞）

```powershell
& "C:\Program Files\DishyWarden\DishyWarden.exe" --enable-logging
```
交互式控制台里能看到实时日志；这个命令会一直占着窗口，关窗即退出。

### C. 只要跑起来，不占窗口（无日志）

```powershell
Start-Process "C:\Program Files\DishyWarden\DishyWarden.exe"
```

### D. 带调试端口（可用 CDP 检查界面/状态）

```powershell
Start-Process "C:\Program Files\DishyWarden\DishyWarden.exe" -ArgumentList '--remote-debugging-port=9222'
# 然后 GET http://127.0.0.1:9222/json/list 拿 webSocketDebuggerUrl
```

### E. 想拿退出码（例如“闪退”排查）

```powershell
& "C:\Program Files\DishyWarden\DishyWarden.exe"
"exit code = $LASTEXITCODE"
```
GUI 程序正常是不会自己退出的；**能立刻返回 exit code 就说明它在启动阶段就死了**
（历史上两种情况：缺 `@grpc/reflection` 的 .proto、`BrowserRouter` 在 `file://` 下路由不匹配）。

### F. 远程机的 GUI 前提

- 通过 **RDP 保持在登录会话**里跑，窗口才会显示、渲染进程才正常；
  纯 SSH（无交互桌面）跑 GUI 程序，窗口可能不出现、甚至渲染层起不来。
- 只要验证网络/端口，用 `verify-dish.ps1` 就够了（**不需要 GUI**，SSH 也能跑）。
