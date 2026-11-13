# Windows 打包说明

> 面向在 **macOS 上交叉构建 Windows x64 安装包**的场景（本项目当前没有 Windows 构建机）。

## 一条命令

```bash
npm run build:win
```

产物：`release/SLMonitor Setup 0.1.0.exe`（NSIS 安装器，约 129 MB）。

脚本内部（`scripts/build-win.sh`）：

```
prepare-win-native.sh prepare   ← 原生模块换成 Windows 版（并备份本机版本）
vite build                       ← 渲染层
electron:build                   ← 主进程 + preload
electron-builder --win nsis      ← 打包
(trap EXIT) prepare-win-native.sh restore   ← 无论成败都还原本机版本
```

任一步失败 ⇒ 脚本失败（退出码如实透传），且本机原生模块一定被还原。

---

## 三个必须知道的坑

### 1. 原生模块要换成 Windows 版本（否则装上就崩）

`better-sqlite3` 是**平台相关**的二进制，本机 node_modules 里的是 Mach-O。
直接打包 ⇒ Windows 上 `require` 失败 ⇒ 应用启动即崩。

```bash
# 在 node_modules/better-sqlite3 目录里：
npx prebuild-install --runtime electron --target 33.4.11 --arch x64 --platform win32 --force
# 或者手动下载（prebuild-install 走 npm 缓存，沙箱里可能写不进去）：
# https://github.com/WiseLibs/better-sqlite3/releases/download/v12.11.1/better-sqlite3-v12.11.1-electron-v130-win32-x64.tar.gz
# 解包后覆盖 build/Release/better-sqlite3.node
```

**打包脚本已经自动处理**（`scripts/prepare-win-native.sh`）：

- `prepare`：备份本机版本 → 下载 win32 包 → 替换
- `restore`：把本机版本放回去（`build-win.sh` 用 `trap EXIT` 保证一定执行）

手工做的话：

```bash
npx prebuild-install --runtime electron --target 33.4.11 --arch x64 --platform win32 --force
# ... 打包 ...
npx prebuild-install --runtime electron --target 33.4.11 --arch arm64 --platform darwin --force
```

验证：

```bash
file node_modules/better-sqlite3/build/Release/better-sqlite3.node
# 打包期间应为 PE32+ ... for MS Windows；打包结束后应自动变回 Mach-O 64-bit arm64
```

> GitHub 偶发连不上（curl 28）。脚本会优先复用 `release/.prebuild/win32.tar.gz`，
> 那个文件已存在就直接用，不必重新下载。

> `v130` = Electron 33 的 NODE_MODULE_VERSION（ABI 130）。electron 与原生模块的
> ABI 必须一致，普通 node（ABI 147）加载会直接抛错。

### 2. exe 图标/版本信息需要 wine —— 用 electron-builder 自带的 portable wine

electron-builder 在 macOS 上给 `SLMonitor.exe` 写图标与版本信息需要 **wine**。
它会**自动下载一份 portable wine**（`wine-4.0.1-mac.7z`，19 MB）✓ 不需要自己装。

但 wine 首次运行要初始化 wineprefix，默认位置是 `~/.wine`：

- 普通终端里跑没问题；
- **在 DSH 沙箱里跑会永久挂起**（写不了 `~/.wine`，构建卡住不动，我第一次就卡了 25 分钟）。

**实测结论（别被表象骗了）**：

- 打包日志里这一行是 `updating asar integrity executable resource` ——
  它**同时**做两件事：写入 asar 完整性哈希（**必须有**，否则 Electron 拒绝加载 asar）
  和调用 rcedit 写图标/版本信息。
- 它会**自动下载 portable wine**（`wine-4.0.1-mac.7z`，19 MB）✓ 不需要自己装。
- **首次构建会卡很久**（实测 20 分钟以上）：wine 要先初始化 prefix
  （在 `release/.cache/builder/wine/wine-4.0.1-mac/wine-home/`，约 30 MB）。
  看起来像"卡死"，其实是在建 wineprefix —— 进程在、目录在涨，只是没日志。
- **自己设 `WINEPREFIX` 无效**：app-builder 启动 wine 时会覆盖成它自己的 wine-home。
  脚本里那行 `WINEPREFIX=release/.wineprefix` 可以删掉。

⇒ 第一次构建请预留 20–30 分钟；之后 prefix 已建好，重建只要 1–3 分钟。

> 若只想跳过这一步（少一个 wine 依赖、少等 20 分钟），加
> `--config.win.signAndEditExecutable=false`：
> **安装器图标、开始菜单图标仍然正确**（都来自 `build/icon.png`），
> exe 内嵌图标是 Electron 默认值 —— 但**任务栏/Alt-Tab/标题栏图标不受影响**，
> 因为主进程用 `BrowserWindow({ icon })` 显式指定了 `build/icon.png` ✓
> （Windows 的任务栏图标取的是**窗口图标**，不是 exe 内嵌图标）。

### 3. 图标文件必须存在

`build/icon.png`（≥256×256）由 `build/` 目录提供，**已入库**。
`build/` 不在 `.gitignore` 里，删了会导致打包报"图标不存在"。

---

## 打包内容检查清单

| 项 | 期望 | 怎么查 |
|---|---|---|
| 原生模块 | `PE32+ ... x86-64` | `file release/win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better-sqlite3.node` |
| 内置星历 | 在 asar 里 | `npx asar list release/win-unpacked/resources/app.asar \| grep tle-seed` |
| 渲染层 | `dist/` | 已有 |
| 主进程 | `dist-electron/main/index.js` + `preload.cjs` | 已有 |

> 内置星历曾经**漏包**：`src/renderer/assets/tle-seed.json.gz` 不在旧的 `files` 白名单里，
> 而打包版的读取路径正是 `src/renderer/assets/...` ⇒ 断网时卫星页一颗星都没有。
> 现已加进 `package.json` 的 `build.files`。

---

## 目标机器上的注意事项

1. **SmartScreen 拦截**：安装包未签名，双击会提示"Windows 已保护你的电脑"
   → 「更多信息」→「仍要运行」。
2. **防火墙弹窗**：Prometheus exporter 监听 9817，首次启动会弹网络访问询问。
   不需要 Prometheus 可以忽略（缺失二进制时主进程会打 warn 并跳过 ✓）。
3. **数据目录**：打包版的 userData 是 **`%APPDATA%\slmonitor\`**
   （取自 package.json 的 `name`，全小写；`productName` 只影响 exe/安装器名字）
   —— 开发态是 `%APPDATA%\Electron\`，**两套数据互不相通**。
   配置文件在 `%APPDATA%\slmonitor\config\config.json`，
   遥测/告警库在 `%APPDATA%\slmonitor\data\`。
   实测（Parallels Windows 11）：`C:\Users\<user>\AppData\Roaming\slmonitor\data\telemetry.db` ✓
4. **默认配置指向本机 dish**：`collector.dishAddress=127.0.0.1:9200`，
   测试机上没有 dish ⇒ 采集器连不上 ⇒ 约 3 分钟后会报"采集心跳丢失"告警（属预期行为）。
5. **首次启动没有位置向导**：卫星方位/仰角需要手工去设置页填经纬度。
6. **未签名的自动更新**：更新源 `UPDATE_FEED_URL` 目前为空 ⇒ 检查更新功能处于
   "更新通道未开放"状态，不会联网。


---

## NSIS 安装器在部分 Win10 上崩溃（c0000005 / 应用程序错误 1000）

### 现象

双击安装器 → 「应用程序错误 1000」→ 任务管理器里没有 SLMonitor 进程。

WER 事件数据的特征（用来确认是**安装器**崩、不是应用崩）：

```
故障模块: C:\Users\<user>\AppData\Local\Temp\nswXXXX.tmp\System.dll
异常代码: c0000005（STATUS_ACCESS_VIOLATION 访问冲突）
```

- `nsw*.tmp` 是 **NSIS 安装器的临时解包目录** ⇒ 崩在安装过程中
- 那个 `System.dll` **不是** Windows 的 System.dll，是 **NSIS 的 System 插件**
  （electron-builder 自带 `nsis-3.0.4.1/Plugins/x86-ansi/System.dll`）
- ⇒ **应用本体从未启动过**，与应用代码无关

### 崩在哪

electron-builder 的 `installer.nsi` → `multiUser.nsh` 求「每用户程序目录」：

```nsis
System::Call 'SHELL32::SHGetKnownFolderPath(g "${FOLDERID_UserProgramFiles}", i ${KF_FLAG_CREATE}, p 0, *p .r2)i.r1'
System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'
```

「每用户程序目录」解析异常时，NSIS System 插件会在自己代码里访问冲突。

### 三条出路

1. **用免安装 zip（推荐）**：解压到任意目录 → 直接跑 `SLMonitor.exe`。
   完全不碰 NSIS，也没有 UAC/路径解析。
2. **用 7-Zip 解包安装器**：NSIS 安装器本身就是 7-Zip 能读的归档 ——
   右键 → 7-Zip → 打开压缩包 → 取出 `SLMonitor.exe` 与 `resources/` → 直接运行。
3. **查那台机器**（如果一定要用安装器）：
   - `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders\Programs`
     是否被**重定向**到网络盘/失效路径/EFS 加密目录（域策略常见）——
     这正是 `SHGetKnownFolderPath(FOLDERID_UserProgramFiles)` 出问题的典型原因
   - 崩溃报告里 **Desktop 路径与 Temp 路径属于不同用户** ⇒ 安装器可能是在
     "另一个账户"（管理员/域账号）下运行的，`HKCU` 指向了意料之外的配置
   - 杀毒软件（360 / 火绒 / Defender）是否把 `%TEMP%\nsw*.tmp` 里的插件拦了
   - 把安装器放到纯英文、无空格的路径再试

### 顺带做的瘦身（降低解包出问题的概率）

把 20 个**运行时根本不需要**的包（echarts / three / @react-three / tailwind /
grpc / react / i18next …，它们早已被 Vite/esbuild 打进产物）从 `dependencies`
移到 `devDependencies`：

| | 之前 | 之后 |
|---|---|---|
| app.asar | 227 MB | **40 MB** |
| NSIS 安装器 | 129 MB | **98.5 MB** |
| 解包文件数 | — | 297 |
