# SLMonitor 测试说明

## 当前配置

### 默认地址已更新为本地模拟器
- **Dish 地址**: 127.0.0.1:9200
- **Router 地址**: 127.0.0.1:9200

## 已知问题和解决方案

### 1. 设置页面保存按钮在浏览器中不工作

**原因**: 设置页面需要 Electron 的 IPC 通信来保存配置，在纯浏览器环境下 `window.electronAPI` 未定义。

**解决方案**: 需要在 Electron 环境中运行应用。

### 2. 如何在 Electron 中运行

由于 TypeScript 配置问题，需要先修复编译配置或使用以下方法：

#### 方法 1: 使用开发模式（推荐）
```bash
# 安装依赖（如果还没有）
npm install

# 同时启动 Vite 开发服务器和 Electron
npm run electron:dev
```

#### 方法 2: 直接启动 Electron（需要先构建）
```bash
# 构建主进程和渲染进程
npm run build

# 启动 Electron
electron .
```

## 测试模拟器连接

### 1. 启动你的 dishy 模拟器
确保模拟器运行在:
- Dish: 127.0.0.1:9200
- Router: 127.0.0.1:9200

### 2. 检查连接
应用启动后，数据采集器会自动尝试连接到模拟器。查看控制台日志:
```
[Collector] Starting with 30000ms interval
[Collector] Sample 1: latency=45.2ms, state=ONLINE, router_clients=6
```

### 3. 在设置页面修改配置
1. 打开应用后访问设置页面
2. 修改 Dish/Router 地址和端口
3. 点击"保存"按钮
4. 配置会保存到 `userData/config/config.json`
5. 采集器会立即使用新配置重新连接

## 当前数据状态

目前所有页面显示的都是**模拟数据**，原因：
- `DishClient.getTelemetry()` 使用 `getMockTelemetry()` 生成随机数据
- `RouterClient.getTelemetry()` 同样使用模拟数据

要连接真实的模拟器，需要：
1. 实现真实的 gRPC 调用（替换 `getMockTelemetry()`）
2. 添加 Starlink protobuf 定义
3. 实现 protobuf 消息的序列化/反序列化

## 配置文件位置

### 开发环境
- macOS: `~/Library/Application Support/Electron/config/config.json`
- Linux: `~/.config/Electron/config/config.json`
- Windows: `%APPDATA%/Electron/config/config.json`

### 生产环境
- macOS: `~/Library/Application Support/slmonitor/config/config.json`

## 测试清单

- [ ] Electron 应用启动成功
- [ ] 设置页面可以打开
- [ ] 可以修改 Dish 地址为 127.0.0.1:9200
- [ ] 可以修改 Router 地址为 127.0.0.1:9200
- [ ] 点击保存按钮，配置成功保存
- [ ] Dashboard 显示数据（目前是模拟数据）
- [ ] 控制台显示采集器日志

## 下一步工作

1. 修复 TypeScript 编译配置，使 `npm run electron:dev` 可以正常工作
2. 实现真实的 gRPC 连接替换模拟数据
3. 测试与你的 dishy 模拟器的连接
4. 验证数据采集是否正常工作