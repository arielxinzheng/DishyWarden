# 终端位置获取：调研与实现说明

> 结论先写：
> **① 终端 GPS（`get_location`）在住宅套餐上已被 SpaceX 关闭，别指望它。**
> **② 浏览器定位在 Electron 里必须 `enableHighAccuracy: true`（走系统 provider），
> 用 `false` 会走 Google 网络定位，而 Electron 没有 API key ⇒ 永远拿不到位置。**
> **③ Starlink 账号地址（dishylink 的做法）需要账号凭据，我们的自建云端没有这份数据。**

---

## 1. dishylink 的取值链（实测源码）

来源：`https://github.com/DaveyHert/dishylink`（`src/lib/observerLocation.ts`、
`src/hooks/useObserverLocation.ts`、`src/hooks/useAccountLocation.ts`）

其源码注释直接写明了背景：

> SpaceX removed local-API GPS (get_location) for consumer plans in May 2026 —
> it now answers PermissionDenied on Residential no matter what — so the observer
> location comes from, in order: the dish itself (still works on Priority plans),
> a saved location, or the browser's geolocation / manual entry.

它的实际排序：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | **终端 GPS**（`dishCoordinates`） | 仅 Priority 套餐；住宅套餐恒为 `PermissionDenied` |
| 2 | **已保存的位置**（localStorage） | 用户手填过就优先用它 |
| 3 | **Starlink 账号地址** ⭐ | `serviceLine.content.serviceAddress.geoLocation.{latitude,longitude}` |
| 4 | **浏览器 geolocation** | `enableHighAccuracy: false, timeout: 15s, maximumAge: 1h` |
| 5 | **IP 粗略定位** | `https://get.geojs.io/v1/ip/geo.json`（城市级，误差可达几百公里） |
| 6 | **手动粘贴坐标** | 支持 "6.5244, 3.3792" / 带度符号等格式 |

两个对我们有参考价值的点：

* **③ 账号地址**是最接近"自动"的来源（固定安装的终端，注册地址就是终端地址）。
  但它需要登录 Starlink 账号拿 `serviceLine` ⇒ **我们的自建云端只有上报接口，没有账号数据**，
  这条路暂时走不通。
* **⑤ IP 粗略定位**能兜底，但会把出口 IP 交给第三方 ⇒ 属��"要不要做"的产品决策，不是技术问题。

### 为什么 dishylink 能用 `enableHighAccuracy: false`

因为它跑在**浏览器扩展 / 网页**里：Chrome / Edge **自带** Google 定位服务的 API key，
网络定位 provider 可用 ⇒ `false`（低精度、走网络）就够用。

**Electron 没有这个 key** ⇒ `false` 会让 Chromium 走网络定位 provider ⇒
拿不到位置。**这是我们与 dishylink 最本质的差异。**

---

## 2. Electron 的两条 provider 链路

在 `Electron 33.4.11` 的 framework 二进制里可直接读到：

```
https://www.googleapis.com/geolocation/v1/geolocate     ← 网络定位 provider
Geolocation.PublicIpAddressGeolocator.ClientId          ← WinRT 平台 provider
LocationProviderManagerMode: NetworkOnly / PlatformOnly / HybridPlatform
"User has not allowed access to system location."       ← 平台 provider 的权限错误
GOOGLE_API_KEY / "Overriding API key "
```

Chromium 官方源码（`services/device/geolocation/location_provider_manager.cc`）：

```cpp
#if BUILDFLAG(IS_ANDROID) || BUILDFLAG(IS_IOS)
  provider_manager_mode_ = kPlatformOnly;
#elif BUILDFLAG(IS_CHROMEOS)
  provider_manager_mode_ = kNetworkOnly;
#else
  // On macOS / Windows / Linux platforms, use the mode specified by the feature flag.
  provider_manager_mode_ = features::GetLocationProviderManagerMode();
#endif
```

⇒ **Windows/macOS/Linux 由 feature flag 决定**，而默认的网络定位需要 `GOOGLE_API_KEY`
（Electron 文档明确要求用户自行提供），否则 geolocation 报
`POSITION_UNAVAILABLE` 并打印 `Network location provider at 'https://www.googleapis.com/' : No response received.`

⇒ Windows 上真正能用的是 **WinRT 平台 provider**：Windows 11 自带
`Geolocation.PublicIpAddressGeolocator`（**按公网 IP 定位，不需要 GPS**）——
这也是 Edge 在同一台机器上能定位的原因。

---

## 3. 本次回归：是我改坏的

用户反馈"**之前本地测试 Electron 能调用浏览器获得经纬度，现在不行了**"。

`git log -S enableHighAccuracy` 直接定位到：

| 提交 | 值 | 结果 |
|---|---|---|
| `5e63e7c`（基线） | `enableHighAccuracy: true` | ✅ 能拿到（走平台 provider） |
| `a21eb15`（我改的：取值链自动串联） | `enableHighAccuracy: false` | ❌ 拿不到（走没 key 的网络定位） |

⇒ **根因是我在重构取值链时把 `true` 改成了 `false`。**

修法（`src/renderer/lib/geolocation.ts`）：

* 恢复 `enableHighAccuracy: true`（⇒ 走平台 provider）
* **加自己的硬超时**（20s）：Chromium 自带的 `timeout` 不覆盖"权限询问"与
  "provider 挂起"两种情况 ⇒ 那两种情况下两个回调都不触发 ⇒ 界面永远转圈
  ⇒ 用户看到的就是"点了没反应、也没有错误原因"。现在硬超时保证界面一定有结论。

---

## 4. 本次还加的：Chromium 日志落盘

`src/main/index.ts` 新增 `enableChromiumLogging()`：

```
app.commandLine.appendSwitch('enable-logging');
app.commandLine.appendSwitch('log-file', <userData>/logs/chromium.log);
app.commandLine.appendSwitch('v', '1');
```

⇒ 以后定位类问题**不用再猜**：Chromium 会把
`provider_manager_mode_ is initialized to ...`、
`Network location provider ... No response received`、
`User has not allowed access to system location.` 等原文写进日志，
用户把 `logs/chromium.log` 发回来即可定位。

---

## 5. 本次新增：IP 粗略定位兜底（已实现）

dishylink 的第 ⑤ 兜底我们这次做进来了（`src/renderer/lib/ipLocation.ts`）：

* 接口：`https://get.geojs.io/v1/ip/geo.json`（与 dishylink **完全一致**）
* 解析：geojs 的经纬度是**字符串**；字段缺失会变 NaN ⇒ 显式判空 + 越界检查
* 精度：**城市级**，误差可达几百公里 ⇒ 界面明确标注"粗略估算"
* **隐私**：它会把出口 IP 交给第三方 ⇒ 因此做成**独立按钮**（用户点了才发请求），
  绝不在后台自动调用、也绝不与其他请求捎带

⇒ 这条路**只要能出网就能用**，不依赖系统定位 provider ⇒
 远程桌面 / 精简系统 / 容器环境下也能拿到一个"大概在哪"的答案。

---

## 5.5 ⭐ 真机日志定性 + Chromium 源码级根因（决定性）

用户在 Windows 真机跑出新包后，Chromium 日志给出了**完整因果链**。

### 日志原文（关键行）

```
Geolocation: DEBUG: geolocation_provider_impl.cc:317 Start provider: high_accuracy=1
Geolocation: DEBUG: network_location_provider.cc:179 Start provider: high_accuracy=1
Geolocation: DEBUG: wifi_data_provider_common.cc:95 Scanned: update_available=1 is_first_scan_complete=0
Geolocation: DEBUG: network_location_request.cc:200 Sending a network location request: Number of Wi-Fi APs=22
Geolocation: DEBUG: network_location_request.cc:267 Got network location response: response_code=403
NetworkLocationRequest::CreateGeopositionErrorResult() : Network location provider at
    'https://www.googleapis.com/' : Returned error code 403.
```

⇒ **两个事实**：
1. **403** ⇒ Google 定位服务拒绝 ⇒ **Electron 没有 `GOOGLE_API_KEY`** ⇒ 网络定位必然失败
2. 日志里**只有 `network_location_provider`**，`location_provider_winrt`（平台 provider）
   **一次都没有 Start** ⇒ ⇒ **平台 provider 在这台机器上根本没被创建**

### Chromium 官方源码给出的完整链条

| # | 源码位置 | 逻辑 |
|---|---|---|
| ① | `services/device/geolocation/location_provider_manager.cc` | Windows 默认 `kPlatformOnly`（平台 provider 优先） |
| ② | `services/device/public/cpp/device_features.cc` → `GetLocationProviderManagerMode()` | **若** `!IsWindowsLocationPlatformSupported()`（Win10 < 1903/build 18362）**则退回** `kNetworkOnly` |
| ③ | `services/device/geolocation/win/location_provider_winrt.cc` → `NewSystemLocationProvider()` | **若** `!IsSystemLocationSettingEnabled()` **则 `return nullptr`** ⇒ 平台 provider 根本不存在 |
| ④ | `services/device/geolocation/network_location_request.cc` | 网络 provider 没有 API key ⇒ **403** ⇒ `POSITION_UNAVAILABLE` |

`IsSystemLocationSettingEnabled()` 的实现（同一文件第 80-105 行）：

```cpp
bool IsSystemLocationSettingEnabled() {
  ... CreateFromDeviceClass(DeviceClass::DeviceClass_Location, &dev_access_info);
  auto status = DeviceAccessStatus::DeviceAccessStatus_Unspecified;
  dev_access_info->get_CurrentStatus(&status);
  return !(status == DeviceAccessStatus_DeniedBySystem ||
           status == DeviceAccessStatus_DeniedByUser);
}
```

⇒ 它查的是 Windows **「设备类 = Location」的访问状态**，
也就是系统设置里 **「允许桌面应用访问你的位置」** 那一位。

### 结论

这台机器上 **Windows 位置服务对桌面应用是拒绝状态** ⇒ 平台 provider 返回 nullptr
⇒ Chromium 只剩网络 provider ⇒ 没有 API key ⇒ **403** ⇒ `POSITION_UNAVAILABLE`。

**为什么 Edge 能定位？** Edge 用的是**微软自己的云定位服务**（不依赖 Windows 位置服务开关），
所以"浏览器能定位"**不能证明**本机定位服务可用 ⭐ —— 之前的推断在这里是错的。

### 修复路径（Windows 侧）

**设置 → 隐私和安全性 → 位置 → 「允许桌面应用访问你的位置」打开**（最关键的一位），
并确保「位置服务」总开关打开。

验证：改完再点一次，Chromium 日志里应当出现
`location_provider_winrt.cc:... Start provider` ⇒ 平台 provider 起来了 ⇒ 成功。

查当前这一位的值（cmd）：

```cmd
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\location" /v Value
```

末 4 位十六进制**从低位到高位**：位0 = 允许桌面应用访问你的位置、位1 = 允许应用访问、
位2 = 允许传统桌面应用、位3 = 允许广告 ID。**位0 = 0 ⇒ 平台 provider 被系统拒绝**。

### 顺带修正：Chromium 的 provider 模式开关写法（已从源码确认）

```cpp
const base::FeatureParam<device::mojom::LocationProviderManagerMode>::Option
    location_provider_manager_mode_options[] = {
        {kNetworkOnly,   "NetworkOnly"},
        {kPlatformOnly,  "PlatformOnly"},
        {kHybridPlatform,"HybridPlatform"},
        {kHybridPlatform2,"HybridPlatform2"},
    };
```

⇒ 值是**字符串名**（不是整数）⇒ 命令行写法为
`--enable-features=LocationProviderManagerMode:HybridPlatform`。

⚠️ 但**本项目没有采用这个开关**：Windows 默认已经是 `kPlatformOnly`，
问题是③的系统权限被拒 —— 改 feature flag 绕不过系统权限，
而且 `kPlatformOnly` 恰好就是"没有网络兜底"的模式 ⇒ 反而更糟
（源码注释：*"Because `kPlatformOnly` has no fallback, leaving it selected where the
Windows Location Platform is unavailable makes every location request fail with
`kPositionUnavailable`."*）。

---

## 6. 我们当前的取值链

```
① 浏览器定位（enableHighAccuracy: true ⇒ 平台 provider）
      ↓ 失败
② 星链终端 GPS（get_location，住宅套餐多半 PermissionDenied ⇒ 静默失败）
      ↓ 失败
③ IP 粗略定位（独立按钮，用户点了才发请求；只要能出网就有结果，城市级）
      ↓ 失败
④ 手动填写（终点的兜底，永远可用）
```

差异说明：

* dishylink 的 ③ **账号地址**我们没有（自建云端无账号数据）
* dishylink 的 ⑤ **IP 粗略定位**我们也没做（会把出口 IP 交给第三方；
  需要产品决策）
* 我们的 ② 放在 ① 之后是刻意的：既然用户实测确认终端 GPS 多被封闭，
  就不该让它当首选

---

## 7. 用户需要在 Windows 上验证什么

1. 设置 → 终端位置 → 点「获取当前位置」
   - **成功**：经纬度自动填好 ⇒ 收工
   - **失败**：现在**一定会显示错误码**（PERMISSION_DENIED / POSITION_UNAVAILABLE / TIMEOUT）
     ⇒ 把那行贴回来
2. 若仍失败，把这两个文件发回来：
   - `%APPDATA%\DishyWarden\logs\dishywarden-*.log`
   - `%APPDATA%\DishyWarden\logs\chromium.log`（本次新增）
   ⇒ `chromium.log` 里能看到 provider 模式与 Chromium 的原话
3. 对照：同一 RDP 会话里 Edge 能定位 ⇒ 说明系统定位服务可用
   ⇒ 若我们的 EXE 失败，日志里会明确指出是"网络定位没有 API key"还是
   "系统定位被拒"
