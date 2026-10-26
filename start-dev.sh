#!/bin/bash

# 清理旧进程
pkill -f "electron.*SLMonitor" 2>/dev/null
pkill -f "vite" 2>/dev/null
lsof -ti:5173 | xargs kill -9 2>/dev/null

cd "$(dirname "$0")"

echo "🚀 启动 Vite 开发服务器..."
npm run dev

echo "✅ 开发环境已启动"
echo "📱 Electron 窗口应该已打开"
echo "🌐 浏览器访问: http://localhost:5173"