# 发布与升级托管契约（DishyWarden）

> **谁该读**：负责发版的人（本仓库）+ 云端服务实现者（`CloudServer/`）。
> **客户端代码**：`src/core/updater.ts`、`src/core/cloudClient.ts`、`src/config/manager.ts`。
> **打包细节**：[`WINDOWS-BUILD.md`](./WINDOWS-BUILD.md)。
> **云端既定设计**：`CloudServer/DESIGN.md` §3「路线 A：electron-updater + GitHub Releases 直连」。

---

## 0. 结论先行

**升级清单与产物格式是契约，托管方不是。**
electron-updater 只认两样东西：`latest.yml` 和它点名的安装器 `.exe`（+ 可选 blockmap）。
这两样在「GitHub Releases」和「自建静态目录」之间**字节完全一致**，切换只改两处配置（§2.3）。

| 托管方 | 状态 | 客户端 feed |
|---|---|---|
| **GitHub Releases（路线 A，既定）** | 待建公开仓库（`CloudServer/DEPLOYMENT-STATUS.md` P3） | `https://github.com/<owner>/DishyWarden/releases/latest/download/` |
| 自建静态目录（备选） | 本仓库当前就是配成这个（`build.publish: generic`） | `https://cloud.dishywarden.com/releases/win/` |

| 包型 | 支持自动升级 | 说明 |
|---|---|---|
| NSIS 安装器（per-machine） | ✅ 完整闭环 | Windows 侧 electron-updater 只有 `NsisUpdater` |
| 免安装 zip | ❌ | 见 §7；只能「提示 + 手动下载」，或自研替换器 |
| macOS dmg | ❌ | `MacUpdater` 要 `latest-mac.yml` + `.zip`；未签名公证 ⇒ 暂缓（DESIGN §3.2 已定） |

---

## 1. 客户端契约（与托管方无关）

### 1.1 固定常量

| 常量 | 当前值 | 位置 |
|---|---|---|
| 云端地址（只收发反馈/遥测） | `https://cloud.dishywarden.com` | `src/config/manager.ts` → `CLOUD_ENDPOINT` |
| 升级 feed | **`''`（空 = 通道关闭）** | `src/config/manager.ts` → `UPDATE_FEED_URL` |
| 更新缓存目录名 | `dishywarden-updater` | `app-update.yml` → `updaterCacheDirName` |
| 包内 feed 配置 | `resources/app-update.yml` | 由 `build.publish` 生成，随包分发 |

> 这两个常量由后台固定：配置里的 `cloud.endpoint` / `cloud.updateFeedUrl` 会在
> `mergeConfig()` 被强制覆盖 —— 用户改本地配置文件改不动它们。

### 1.2 检查时序

| 参数 | 值 |
|---|---|
| 首次检查 | 启动后 30 s |
| 检查间隔 | 12 h ± 30 min 随机抖动（错峰；服务端别按整点限流） |
| 单次检查超时 | 10 s（超时 → `error: check_timeout` 并上报） |
| 自动下载 | **关**（`autoDownload = false`，用户点「下载」才下） |
| 退出自动安装 | **关**（`autoInstallOnAppQuit = false`，用户点「安装」才装） |
| 开发态（未打包） | 直接 `disabled / dev_mode`（electron-updater 会解析到 npm 的 electron shim，必须先短路） |

### 1.3 状态机

```
disabled ──(填好 UPDATE_FEED_URL)──> idle
  ├─ dev_mode                     └ checking → up-to-date
  ├─ updater_unavailable                        └→ available
  └─ (feedUrl 为空 ⇒ 通道未开放)                      ├→ downloading → downloaded
                                                    └→ error
```

### 1.4 上报契约（服务端唯一要接的东西）

- **地址**：`POST {CLOUD_ENDPOINT}/api/feedback`
- **头**：`Content-Type: application/json`
- **成功判据**：HTTP **`204`**（非 204 一律失败；**客户端不重试**）
- **超时**：8 s；失败静默丢弃，绝不影响监控主职
- **请求体**（白名单字段）：

```json
{
  "type": "upgrade_check",
  "client_id": "<安装时生成的 uuid，匿名，无硬件指纹>",
  "app_version": "0.1.0",
  "platform": "win32",
  "result": "available",
  "latest_version": "0.2.0",
  "ok": true,
  "error": "…",
  "to_version": "0.2.0"
}
```

`type` ∈ `upgrade_check` | `upgrade_download` | `upgrade_install` | `upgrade_heartbeat`
（另：`alert_false_positive`，受「匿名反馈」开关控制）。

- `result` 仅 `upgrade_check` 用：`no_update` | `available` | `error`
- `ok` 仅 `upgrade_download` 用；`error` 失败时 ≤200 字；`to_version` 仅 `upgrade_install` 用

**服务端必须幂等**：`upgrade_heartbeat` 每次启动一条（12h 节流），重启会重复；
`client_id` + `type` 可能重复到达。

**`upgrade_heartbeat` 的用处**：按 `app_version` 聚合即得各版本在线分布 ⇒
灰度放量与回滚决策的依据。

---

## 2. 托管方

### 2.1 路线 A：GitHub Releases（既定，推荐）

**为什么**：全球 CDN、下载量统计、免运维，且 `latest.yml` 原生支持（DESIGN §3.1/§7.1）。

**约定**：

- 仓库：`<owner>/DishyWarden`（**公开**；DESIGN.md 里写的是 `SLMonitor`，产品已改名，需同步）
- Release：`tag = v<version>`，**且 tag 必须等于 `package.json.version`**
- 每个 Release 挂这些资产（**Release 先保持 draft，资产齐了再 publish**）：
  1. `DishyWarden-Setup-<version>.exe`
  2. `DishyWarden-Setup-<version>.exe.blockmap`
  3. `latest.yml`
  4. （可选）`DishyWarden-Setup-<version>.exe.nsis.7z` 差分包
- 客户端 feed（**目录形式**，见 §2.3 的尾斜杠说明）：`https://github.com/<owner>/DishyWarden/releases/latest/download/`
- **`latest.yml` 必须原样上传**（只改名成 `latest.yml`，不要编辑任何字段）

**发版入口**：`.github/workflows/release.yml`（DESIGN §7.1）——
push tag ⇒ 校验版本一致 ⇒ Windows runner 构建 ⇒ `--publish always` ⇒ 自检清单可下。

### 2.2 备选：自建静态目录（本仓库当前配置）

```
https://cloud.dishywarden.com/releases/win/
├── latest.yml
├── DishyWarden-Setup-<version>.exe
├── DishyWarden-Setup-<version>.exe.blockmap
└── DishyWarden-Setup-<version>.exe.nsis.7z   （可选）
```

**HTTP 头要求**：

| 文件 | Content-Type | Cache-Control |
|---|---|---|
| `latest.yml` | `text/yaml` | **`no-cache, max-age=0`**（必须，否则客户端拿到旧清单） |
| `*.exe` / `*.blockmap` / `*.7z` | `application/octet-stream` | `public, max-age=31536000, immutable`（文件名带版本，可长缓存） |

需支持 `Range`（差分更新；不支持则退化为全量下载，功能不受影响）。
**只开 GET/HEAD**，无需鉴权。

**原子发布**：先传 exe/blockmap，确认可下载且校验通过，**最后**用「临时名 → rename」
替换 `latest.yml`。否则会出现「清单已换、安装器还没传完」⇒ 用户点下载 404。

### 2.3 两条路线的切换（两处配置）

```jsonc
// package.json → build.publish
// GitHub（路线 A）：
"publish": [{ "provider": "github", "owner": "<owner>", "repo": "DishyWarden" }]
// 自建静态目录（当前）：
"publish": [{ "provider": "generic", "url": "https://cloud.dishywarden.com/releases/win" }]
```

```ts
// src/config/manager.ts
// ⚠️ 必须是**目录形式**(带尾斜杠), 不能写成完整文件路径 ——
//    electron-updater 用 generic provider, 它按「发布目录」语义拼 URL:
//    newBaseUrl(feed) 会给路径补尾斜杠, 再 new URL('latest.yml', base)。
//    实测: 写成 .../latest/download/latest.yml ⇒ 实际请求
//          .../latest/download/latest.yml/latest.yml   ❌ 404
export const UPDATE_FEED_URL = 'https://github.com/<owner>/DishyWarden/releases/latest/download/';
```

改完**必须重新打包发版**（两者都编译/写入进包）。未填 feed 时以上配置全部惰性，
客户端一个请求都不发。

---

## 3. 产物契约

### 3.1 命名（不要随意改：云端脚本、灰度、回滚都按它匹配）

| 项 | 值 | 来源 |
|---|---|---|
| 安装器 | `DishyWarden-Setup-<version>.exe` | `build.nsis.artifactName` |
| 免安装包 | `DishyWarden-<version>-win-x64.zip` | `build.artifactName` |
| exe 名 / 安装目录 | `DishyWarden.exe` / `Program Files\DishyWarden` | `productName` + `executableName` |
| appId | `com.dishywarden.app` | `build.appId` |

### 3.2 `latest.yml`（`npm run build:win` 生成，**禁止手工编辑**）

```yaml
version: 0.1.0
files:
  - url: DishyWarden-Setup-0.1.0.exe
    sha512: 9nM5yeF4…（base64，44 字节，以 == 结尾）
    size: 104246155
path: DishyWarden-Setup-0.1.0.exe
sha512: 9nM5yeF4…
releaseDate: '2026-11-13T15:04:18.748Z'
```

| 字段 | 作用 | 改错了会怎样 |
|---|---|---|
| `version` | 与客户端 `app_version` 比较 | 不大于客户端 ⇒ 永远「已是最新」 |
| `files[].url` | 客户端拼下载路径 | 与实际文件名不一致 ⇒ 404 |
| `sha512` / `size` | 下载后校验 | 不匹配 ⇒ `download_failed` |
| `releaseDate` | UI 展示 | 无害 |

### 3.3 不可变约定

| 项 | 为什么不能改 |
|---|---|
| `appId = com.dishywarden.app` | 决定安装器升级识别；改了 ⇒ 老安装版无法原地升级（变成并存两个应用） |
| `productName = DishyWarden` | exe 名 / 安装目录 / 清单里的文件名都由它派生 |
| userData 目录 `<appData>/DishyWarden` | 已从 `SLMonitor`/`slmonitor` 迁移过一次；再改等于用户配置+历史全丢 |
| `version` 只增不减 | 客户端只认真实递增 |
| 安装模式 `perMachine: true` | per-user 模式在部分机器上 NSIS 插件崩溃（见 §6） |

---

## 4. 发版流程

### 4.1 GitHub Actions（路线 A）

```yaml
# .github/workflows/release.yml（要点，非完整文件）
on: { push: { tags: ['v*'] } }
jobs:
  build-win:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: 校验 tag 与 package.json 一致
        run: node -e "const v=process.env.GITHUB_REF.replace('refs/tags/v','');const p=require('./package.json').version;if(v!==p){console.error(`tag ${v} != package ${p}`);process.exit(1)}"
      - run: npx vite build
      - run: npm run electron:build
      - run: npx electron-builder --win nsis --x64 --publish always
        env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
      - name: 自检清单
        run: curl -sf https://github.com/${{ github.repository }}/releases/download/${{ github.ref_name }}/latest.yml
```

> **在 Windows runner 上构建的好处**：原生模块（`better-sqlite3`）和安装器都在目标平台生成，
> 不需要本仓库那套 `scripts/prepare-win-native.sh` 换模块，也不需要 wine。
> macOS 本机打包只是「没有 CI 时的临时通道」。

### 4.2 手工发版（自建目录 / 无 CI 时）

```bash
cd "<REPO_ROOT>"
npm version patch --no-git-tag-version    # 升版本；不要动 appId
npm run build:win                          # 产出 exe + zip + latest.yml + blockmap

# 核对：清单里的 sha512/size 必须与安装器一致
python3 - <<'PY'
import base64, hashlib, yaml
m = yaml.safe_load(open('release/latest.yml'))
f = m['files'][0]
data = open('release/' + f['url'], 'rb').read()
got = base64.b64encode(hashlib.sha512(data).digest()).decode()
print('sha512 match:', got == f['sha512'], '| size match:', len(data) == f['size'])
PY

# 传 3 个文件（先产物，最后清单）
scp release/DishyWarden-Setup-<ver>.exe          <USER>@<SERVER>:/srv/releases/win/
scp release/DishyWarden-Setup-<ver>.exe.blockmap <USER>@<SERVER>:/srv/releases/win/
scp release/latest.yml <USER>@<SERVER>:/tmp/latest.yml
ssh <USER>@<SERVER> 'mv /tmp/latest.yml /srv/releases/win/latest.yml'
```

---

## 5. 灰度与回滚

### 5.1 GitHub Releases

- **预发布**：先把 Release 设成 prerelease（客户端 `latest` 路径默认拿不到），
  只给内测机器手动下载；稳定后再取消 prerelease。
- **回滚**：把上一版 Release 重新设回 latest（或删掉新 Release 里的 `latest.yml` 资产），
  **不要删旧的 exe/blockmap** —— 已下载到用户缓存里的引用会失效。
- **放量观察**：`upgrade_heartbeat` 按 `app_version` 聚合 ⇒ 看新版在线数是否上升、
  `upgrade_download` / `upgrade_install` 失败率是否异常。

### 5.2 自建静态目录

`latest.yml` 单文件、全网一致，**无法按人群区分**。两条路：

1. 零改造：先只上安装器、不换清单；观察上报，没问题再换清单。
2. 服务端动态清单：按请求特征返回新版或旧版 `latest.yml`。注意清单必须
   `no-cache`，否则 CDN 会把灰度结果缓存成全网生效。

---

## 6. 与 `CloudServer/DESIGN.md` 的差异清单（需对齐）

产品改名 + 本轮实测之后，云端文档里有 5 处已不准确，**发版前必须同步**：

| # | DESIGN.md 原写法 | 现在的事实 |
|---|---|---|
| 1 | 仓库名 `SLMonitor` | 已改名 → `DishyWarden` |
| 2 | 安装器 `SLMonitor-Setup-x.y.z.exe` | `DishyWarden-Setup-<version>.exe` |
| 3 | 「oneClick + runAfterFinish」 | 实际 `oneClick: false`、**`perMachine: true`**、`allowToChangeInstallationDirectory: true` ⇒ 有向导页、需管理员（UAC 一次）；`runAfterFinish` 仍为默认 true |
| 4 | 「Windows 未签名 → SmartScreen 警告」 | 仍成立；且 per-machine 比 per-user 多一次提权 |
| 5 | `build.publish` 计划 `provider: github` | 当前仓库配的是 `provider: generic`（自建目录，§2.2）；走路线 A 时改回 github |

另：`isAdminRightsRequired` 字段可能不出现在 `latest.yml`（取决于构建模式），
但 per-machine 安装器运行时一定要求提权 —— 别因为清单里没有该字段就以为不需要管理员。

---

## 7. 免安装 zip 的策略

**硬事实**：`node_modules/electron-updater/out/` 的 Windows 实现只有 `NsisUpdater`，
**没有 portable/zip 更新器** ⇒ zip 版没有任何自动升级路径。

zip 的定位：**给无管理员权限、或安装器在该机器崩掉的用户兜底**，走下载页手动更新。

若一定要让 zip 版也能升级，得自研替换器（成本高，Windows 文件锁是主坑）：

1. 云端另给 `manifest.json`：`{version, url, sha256, size, notes}`（用标准 hex `sha256`，不是 `sha512` base64）；
2. 客户端下载到 `%TEMP%\dishywarden-update\`，校验 hash + size；
3. 启动 helper（打包内的 `updater.exe` 或批处理），主进程先 `app.quit()`；
4. helper 等进程退出 → **整体 rename 目录**（运行中的 exe 不能覆盖自己，但能改名整个目录）
   → 解压新包 → 启动 → 成功后删 `.old`，失败回滚；
5. 替换时**不要动** `%APPDATA%\DishyWarden`（配置/历史都在里面）。

结论：**优先安装器，zip 只兜底**。

---

## 8. 排障表

| 现象 | 原因 | 处理 |
|---|---|---|
| UI「更新通道未开放」 | `UPDATE_FEED_URL` 为空 | 正常（通道未开） |
| `disabled / dev_mode` | 未打包运行 | 正常 |
| `disabled / updater_unavailable` | asar 缺 electron-updater 或其嵌套依赖 | 检查 `dependencies`；`builder-util-runtime` 等在嵌套目录里，别手删也别提到顶层 |
| `check_timeout` | feed 不可达 / 10s 内无响应 | `curl` 清单地址；查 DNS/证书/代理 |
| 一直 `up-to-date` 但服务端有新版 | 清单 `version` 不大于客户端；或清单被 CDN 缓存 | 核对 `version`；确认 `no-cache` |
| `download_failed` + 服务端 404 | 清单先换、安装器没传完 | 按「先产物后清单」重发 |
| `download_failed` + 校验失败 | `sha512`/`size` 被手工改过 | 用 `build:win` 生成的清单重传 |
| 安装步骤弹 UAC | per-machine 安装器 | 预期行为；无权限机器用 zip |
| 安装器崩溃（`System.dll` / c0000005） | NSIS per-user 模式的历史坑 | 已改 perMachine 修复（`WINDOWS-BUILD.md`）；必要时给用户 zip |
| 升级后配置/历史丢失 | userData 目录变了 | 恢复 `<appData>/DishyWarden`；已内置从 `SLMonitor`/`slmonitor` 的迁移 |

---

## 9. 上线自检

```bash
# 路线 A（GitHub）
GH=https://github.com/<owner>/DishyWarden/releases/latest/download
curl -sf $GH/latest.yml | head -12
curl -sI $GH/DishyWarden-Setup-1.0.0.exe | grep -iE 'HTTP/|content-length|content-type'

# 自建目录
BASE=https://cloud.dishywarden.com/releases/win
curl -sf $BASE/latest.yml | head -12
curl -sI $BASE/latest.yml | grep -qi 'no-cache' && echo 'OK: 清单不缓存'
```

链路验收（看上报就够）：服务端出现 `upgrade_check result=available`
→ 随后 `upgrade_download ok=true` → `upgrade_install to_version=0.2.0` ⇒ 全链路通。

---

## 10. 待办（按优先级）

1. **定托管方**：走 GitHub（路线 A，需建公开仓库 + workflow）还是先用自建目录；
   定完把 `build.publish` 与 `UPDATE_FEED_URL` 一次性对齐（§2.3）。
2. 同步 `CloudServer/DESIGN.md` 的 5 处差异（§6）。
3. `/api/feedback` 实现 `204` 应答 + `upgrade_*` 落库（`upgrade_heartbeat` 用于版本分布）。
4. 首个正式版本发布 + 让 1 台真机走完「检查 → 下载 → 安装 → 重启」。
5. （可选）macOS 自动升级：`build.mac.target` 加 `zip`，产出 `latest-mac.yml`，并准备签名/公证。
6. （可选）差分包 `*.nsis.7z` 托管，观察省流量。
