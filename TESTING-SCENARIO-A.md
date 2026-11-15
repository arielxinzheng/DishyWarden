# 场景 A 手工测试指南 —— 首次安装采集失败 (Day 0 / Zero Data State)

> 实现: `src/renderer/components/Dashboard/firstInstall.ts`(判定) + `SetupGuide.tsx`(引导页)
> 提交: `bafbc31`

## 为什么不能用 DishyMock 直接触发

场景 A 的判定是**两个信号的与**:

```
isFirstInstallFailure = (gRPC 采集失败) && (本地历史库为空)
```

DishyMock 只能造前半 —— 关掉它、或把 dish 地址指到不存在的端口,
SLMonitor 就会连接失败。但**后半在你开发机上永远不成立**:
`~/Library/Application Support/Electron/data/telemetry.db` 里已有几千条历史。
于是判定为 false, 显示的是**运行中断连**的错误框(场景 B), 不是引导页。

⇒ 手工触发必须**同时**满足两个条件, 只能动 SLMonitor 本地状态。
和 DishyMock 唯一相关的操作是: 触发完场景 A 后, 把隔离实例的 dish
地址改回 127.0.0.1:9200 验证「引导页 → 仪表盘」的恢复路径。

## 手工触发: 隔离实例(推荐, 已实测可行)

不动真实数据、不重启正在跑的 dev 栈。前提: dev 栈活着(vite 5173
在跑 —— 渲染层已含场景 A 代码, HMR 自动推)。

### 为什么不能直接起完整主进程

正在跑的 dev 实例占着 9817(Prometheus exporter), 第二个完整主进程
初始化到 `await exporter.start()` 就会因端口冲突 reject —— 实测确认,
`src/main/index.ts` 里没有 try/catch 兜这个。裸 `Electron --user-data-dir`
也不行(Electron 会打 usage 退出, user-data-dir 不是这样用的)。

⇒ 隔离实例用一个**最小主进程脚本**: 真实 preload、真实 5173 渲染层,
只 mock 三个 IPC 的返回值(遥测=null、库统计 sampleCount=0、
dish 地址指向必失败的 127.0.0.1:59999)。渲染层代码路径 100% 真实。

### 步骤

```bash
cd "<REPO_ROOT>"

# 1. 造手工版脚本(把窗口显示出来, 跑完不退出)
cat > /tmp/probe/manual_day0.cjs <<'EOF'
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const PROJ = '<REPO_ROOT>';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath('userData', '/tmp/slm-day0-manual');
process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173';

// 最小主进程: 契约对齐 src/main/index.ts, dish 必失败 + 空库
ipcMain.handle('get-latest-telemetry', () => null);
ipcMain.handle('get-latest-obstruction', () => null);
ipcMain.handle('get-storage-stats', () => ({
  dbPath: '/tmp/slm-day0-manual/telemetry.db', fileSizeBytes: 0,
  sampleCount: 0,            // ← Day 0 的关键
  oldestSampleTs: null, newestSampleTs: null,
  hourlyCount: 0, retention: { sampleDays: 30, hourlyDays: 365 },
}));
ipcMain.handle('retry-dish-connection', () => ({ success: true }));
ipcMain.handle('get-config', () => ({
  collector: { dishAddress: '127.0.0.1', dishPort: 59999 },   // ← 必失败
}));
ipcMain.handle('get-history', () => []);
ipcMain.handle('get-history-summary', () => null);
ipcMain.handle('get-active-alerts', () => []);
ipcMain.handle('get-collector-stats', () => null);
ipcMain.handle('get-handoffs', () => []);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, width: 1440, height: 900,   // 可见窗口, 随便点
    webPreferences: {
      preload: path.join(PROJ, 'dist-electron/main/preload.cjs'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win.on('closed', () => app.exit(0));
  await win.loadURL('http://localhost:5173/');
  console.log('[manual] 窗口已开: 前 ~15s 是"正在连接"转圈, 超时后进引导页');
  console.log('[manual] 关窗口即退出');
});
EOF

# 2. 起
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /tmp/probe/manual_day0.cjs
```

窗口会留在屏幕上, 按下面的清单逐项点。

## 引导页肉眼检查清单

| # | 检查项 | 预期 |
|---|---|---|
| 1 | 首屏(前 ~15s) | 转圈「正在连接 Starlink 设备...」, **不是**引导页 |
| 2 | 15s 超时落定 | 切到引导页: 雷达停扫, 中心红色 WifiOff, 标题「未找到 Starlink 设备」 |
| 3 | 页面任何位置 | **没有**红色告警横幅(系统未跑起来, 无告警概念) |
| 4 | 排查表单 4 项 | 勾选第一项, 计数 0/4 → 1/4, 文字划线置灰 |
| 5 | 「当前目标」 | 显示 127.0.0.1:59999 |
| 6 | 重试按钮 | 点击 → 转圈「正在重试...」→ 仍失败 → 停回引导页 |
| 7 | 侧栏 | 仍在, 点「设置」能跳转 |
| 8 | 错误文案 | 引导页正文显示具体错误(连接超时/ECONNREFUSED) |

## 恢复路径(引导页 → 仪表盘)

把 `get-config` 的返回值里 `dishPort: 59999` 改成 `9200`(DishyMock),
并且加一个真的会返回数据的 handler:

```js
ipcMain.handle('get-latest-telemetry', () => ({
  state: 'ONLINE', uptime: 3600, popPingLatencyMs: 35, popPingDropRate: 0,
  downlinkThroughputBps: 120e6, uplinkThroughputBps: 12e6, snr: 12,
}));
```

再跑一次脚本: 首帧直接进正常仪表盘, 引导页根本不出现 ——
因为判定要求「采集失败」, 数据通了就不满足。

要看「引导页 → 重试成功 → 自动消失」的完整过程:
先保持必失败配置让引导页出现, 然后在 DevTools console 里手动推事件:

```js
// DevTools console(窗口右键 Inspect):
// 模拟设备恢复 —— 用真实路径里 telemetry-update 的形状
window.electronAPI.onTelemetryUpdate(() => {});  // 仅确认通道存在
```

⇒ 隔离脚本无法真正模拟"主进程突然连上了"(mock 的 telemetry 是常量)。
要验恢复路径的**真实事件流**, 用自动化脚本 `/tmp/probe/e2e_day0.cjs`
里的 A4/A5, 或临时把脚本里 `get-latest-telemetry` 从 null 改成返回数据、
重试前改回 —— 引导页会因 telemetry 到达而消失。

## 自动化兜底(平时可以不手工)

| 层 | 命令 | 覆盖 |
|---|---|---|
| 判定纯函数 | `npx vitest run src/renderer/components/Dashboard/firstInstall.test.ts` | 5/5 边界 |
| 端到端 | `./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /tmp/probe/e2e_day0.cjs` | 7/7(依赖 5173) |
| 视觉结构 | `./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /tmp/probe/visual_assert.cjs` | 6/6 |

⚠️ /tmp 下的脚本会被 macOS 重启清掉 —— 三个脚本如需长期保留应挪进仓库
(建议 `scripts/qa/`), 挪之前先删掉脚本里 print 的敏感路径检查。
