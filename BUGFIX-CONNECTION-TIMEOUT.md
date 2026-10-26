# 黑屏问题修复说明

## 问题描述

在连接 Starlink 设备后，应用会一直显示"正在连接 Starlink 设备..."的加载状态，无法进入主界面（黑屏）。

## 根本原因

1. **无超时机制**：前端 `useDish` hook 在调用 Electron IPC 获取数据时，没有设置超时限制
2. **后端无超时保护**：collector 在调用 gRPC 接口时，如果设备无响应会无限等待
3. **错误信息不清晰**：即使超时，用户也无法得到明确的错误提示和解决方案

## 修复方案

### 1. 前端添加超时机制 (`useDish.tsx`)

```typescript
// 添加 15 秒超时保护
const timeoutPromise = new Promise<null>((_, reject) => 
  setTimeout(() => reject(new Error('连接超时：无法访问 Starlink 设备')), 15000)
);

const dataPromise = window.electronAPI.getLatestTelemetry();
const data = await Promise.race([dataPromise, timeoutPromise]);
```

### 2. 后端添加超时机制 (`collector/historian.ts`)

```typescript
// 添加 10 秒超时保护
const timeoutPromise = new Promise<never>((_, reject) => 
  setTimeout(() => reject(new Error('Starlink 设备连接超时 (10s)')), 10000)
);

const collectPromise = Promise.all([
  this.client.getTelemetry(),
  this.routerClient.getTelemetry(),
]);

const [telemetry, routerTelemetry] = await Promise.race([
  collectPromise,
  timeoutPromise
]);
```

### 3. 优化错误提示界面 (`Dashboard/index.tsx`)

添加了详细的错误提示和排查指南：
- 显示具体的错误信息
- 提供常见问题检查清单
- 添加"重试连接"按钮

## 修改的文件

1. `src/renderer/hooks/useDish.tsx` - 添加前端超时机制和错误提示优化
2. `src/renderer/components/Dashboard/index.tsx` - 优化错误展示界面和用户体验
3. `src/collector/historian.ts` - 添加后端数据采集超时保护

## 测试建议

### 正常连接场景
1. 确保电脑已连接到 Starlink 网络（192.168.100.x）
2. 启动应用，应该在 10-15 秒内连接成功
3. Dashboard 应该显示实时数据

### 超时场景
1. 断开 Starlink 网络或访问不可达的设备地址
2. 启动应用
3. 应该在 15 秒后显示超时错误
4. 错误界面应显示详细的排查指南
5. 点击"重试连接"按钮可以手动重试

### 开发模式
1. 不连接 Starlink 设备，在浏览器中运行 `npm run dev`
2. 应该显示模拟数据，无需实际设备

## 预期效果

- ✅ 不再出现无限加载（黑屏）的情况
- ✅ 15 秒内必定给出反馈（成功或失败）
- ✅ 错误信息清晰，帮助用户自主排查问题
- ✅ 提供手动重试功能
- ✅ 开发模式下使用模拟数据，便于调试