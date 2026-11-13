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
3. **数据目录**：打包版的 userData 是 `%APPDATA%\SLMonitor\`
   （开发态是 `%APPDATA%\Electron\`，**两套数据互不相通**）。
4. **默认配置指向本机 dish**：`collector.dishAddress=127.0.0.1:9200`，
   测试机上没有 dish ⇒ 采集器连不上 ⇒ 约 3 分钟后会报"采集心跳丢失"告警（属预期行为）。
5. **首次启动没有位置向导**：卫星方位/仰角需要手工去设置页填经纬度。
6. **未签名的自动更新**：更新源 `UPDATE_FEED_URL` 目前为空 ⇒ 检查更新功能处于
   "更新通道未开放"状态，不会联网。
