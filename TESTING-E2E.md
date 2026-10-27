# Playwright E2E 测试文档

## 测试框架

- **框架**: Playwright for Electron
- **测试文件**: `tests/e2e/*.spec.ts`
- **配置**: `playwright.config.ts`

## 运行测试

```bash
# 运行所有 E2E 测试
npm run test:e2e

# UI 模式（交互式查看测试执行）
npm run test:e2e:ui

# 调试模式（逐步执行）
npm run test:e2e:debug

# 查看测试报告
npm run test:e2e:report
```

## 测试套件（P0 冒烟测试）

### 1. 应用启动测试 (`01-startup.spec.ts`)

**验证点**:
- Electron 应用能正常启动
- 主窗口渲染成功
- 导航栏所有链接可见
- Electron API 注入成功（`window.electronAPI`）
- 关键 API 方法存在（`getLatestTelemetry`、`getTelemetryHistory`、`getActiveAlerts`、`getConfig`）
- 无严重控制台错误

**运行时间**: ~10 秒

### 2. 页面导航测试 (`02-navigation.spec.ts`)

**验证点**:
- 能导航到障碍图页面（3D 容器或遮挡图可见）
- 能导航到卫星雷达页面（罗盘或卫星列表可见）
- 能导航到告警页面（告警列表容器存在）
- 能导航到设置页面（保存按钮可见）
- 多个页面间切换流畅

**运行时间**: ~20 秒

### 3. 设置保存测试 (`03-settings.spec.ts`)

**验证点**:
- 能修改 Dish 地址并保存
- 能修改告警阈值并保存
- 重启应用后配置持久化保持

**运行时间**: ~30 秒（含一次应用重启）

### 4. 告警列表测试 (`04-alerts.spec.ts`)

**验证点**:
- 告警列表能正常加载（空状态或有告警）
- 活跃/历史视图切换功能
- 告警卡片显示关键信息（时间、严重程度）

**运行时间**: ~45 秒（含数据采集等待）

### 5. 遮挡图渲染测试 (`05-obstruction.spec.ts`)

**验证点**:
- 3D 遮挡半球能正常渲染（Canvas 元素可见）
- Canvas 有实际内容（宽高不为 0）
- WebGL 上下文可用
- 遮挡率数据显示
- 数据来源标记（实测/模拟）
- 遮挡历史时间轴（如果有数据）

**运行时间**: ~50 秒（含数据采集等待）

## 总运行时间

约 **2.5-3 分钟**（5 个测试套件，15+ 个测试用例）

## 前置条件

### 1. 构建 Electron 主进程

```bash
npm run electron:build
```

确保 `dist-electron/main/index.js` 存在。

### 2. 启动 DishyMock（可选）

如果需要真实数据验证，启动本地 gRPC 模拟器：

```bash
# DishyMock 应运行在 127.0.0.1:9200
```

测试会在 `NODE_ENV=test` 环境下运行，使用独立的数据库路径。

## 测试辅助函数

### `helpers.ts`

- **`launchElectron()`**: 启动 Electron 应用并返回 `{ app, page }`
- **`cleanTestDatabase()`**: 清空测试数据库（避免状态污染）
- **`waitForDataCollection(seconds)`**: 等待数据采集周期
- **`navigateTo(page, route)`**: 导航到指定页面
- **`setupConsoleErrorListener(page, errors)`**: 监听控制台错误

## 测试策略

### 容错设计

- 使用 `.first()` 选择器避免多元素匹配失败
- 使用 `.or()` 提供多个备选定位器
- 使用 `isVisible({ timeout }).catch(() => false)` 避免断言失败
- 动态检查元素存在性，对缺失元素输出警告而非失败

### 时间控制

- 短等待（1-3 秒）：UI 渲染、页面切换
- 中等等待（5-10 秒）：数据加载、API 调用
- 长等待（35-40 秒）：数据采集周期（采集器 30s 一次）

### 数据隔离

每个测试套件使用独立的应用实例，测试间互不影响。如需完全重置状态，可在 `beforeEach` 中调用 `cleanTestDatabase()`。

## 报告输出

测试完成后会生成：

- **HTML 报告**: `playwright-report/index.html`
- **截图**: 失败测试自动截图
- **追踪**: 失败测试保留执行追踪（可用 Playwright Inspector 回放）

## 持续集成

可集成到 CI/CD：

```yaml
# .github/workflows/test.yml
- name: 构建主进程
  run: npm run electron:build

- name: 运行 E2E 测试
  run: npm run test:e2e

- name: 上传测试报告
  if: always()
  uses: actions/upload-artifact@v3
  with:
    name: playwright-report
    path: playwright-report/
```

## 已知限制

1. **DishyMock 场景切换**：当前测试不自动切换 DishyMock 场景，需要手动配置后运行相应测试
2. **数据依赖**：某些测试需要数据采集周期完成，运行时间较长
3. **视觉回归**：未包含截图对比测试，仅验证功能可用性

## 下一步扩展

- **P1**: 增加告警触发端到端测试（需 DishyMock API 支持场景切换）
- **P2**: 增加性能测试（启动时间、页面切换响应）
- **P3**: 增加视觉回归测试（Percy 或 Playwright 截图对比）

## 故障排查

### 测试超时

```bash
# 增加超时时间
npx playwright test --timeout=180000
```

### WebGL 不可用

检查 Electron 是否启用硬件加速：

```typescript
app.commandLine.appendSwitch('enable-gpu');
```

### 数据库锁定

确保没有其他 Electron 实例正在运行：

```bash
pkill -f "SLMonitor"
```