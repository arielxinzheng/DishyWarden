# Windows 打包说明

> 面向在 **macOS 上交叉构建 Windows x64 安装包**的场景（本项目当前没有 Windows 构建机）。

## 一条命令

```bash
npm run build:win
```

产物：`release/SLMonitor Setup 0.1.0.exe`（NSIS 安装器，约 129 MB）。

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

**打完之后必须换回来**，否则本机开发起不来：

```bash
npx prebuild-install --runtime electron --target 33.4.11 --arch arm64 --platform darwin --force
```

验证：

```bash
file node_modules/better-sqlite3/build/Release/better-sqlite3.node
# 打包前应为 PE32+ ... for MS Windows；还原后应为 Mach-O 64-bit arm64
```

> `v130` = Electron 33 的 NODE_MODULE_VERSION（ABI 130）。electron 与原生模块的
> ABI 必须一致，普通 node（ABI 147）加载会直接抛错。

### 2. macOS 上没有 wine ⇒ 必须跳过 exe 编辑

electron-builder 在 macOS 上给 `SLMonitor.exe` 写图标/版本信息需要 **wine**
（它会自带一份 portable wine，但要初始化 wineprefix，沙箱里写不了 `~/.wine`
就会**永久挂起**，表现为构建卡住不动）。

```bash
--config.win.signAndEditExecutable=false
```

代价（仅外观）：**exe 内嵌图标和文件属性里的版本信息是 Electron 默认值**。
不影响：安装器图标、开始菜单快捷方式图标（两者都来自 `build/icon.png` ✓）。

想要内嵌图标：在 Windows 上构建，或本机装 wine 后去掉该参数重跑。

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
