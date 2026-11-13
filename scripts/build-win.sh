#!/usr/bin/env bash
#
# Windows x64 安装包构建（macOS 上交叉构建）。
#
# 流程：
#   1. 原生模块换成 Windows 版（prepare）
#   2. 构建渲染层 + 主进程
#   3. electron-builder 打 NSIS 包
#   4. **无论成败都还原**本机 (macOS) 原生模块（trap EXIT）
#
# 退出码如实透传：任一步失败 ⇒ 脚本失败 ⇒ npm run build:win 失败。
#
set -euo pipefail
cd "$(dirname "$0")/.."

# trap EXIT：成功/失败/中断都会还原本机原生模块
trap 'bash scripts/prepare-win-native.sh restore || true' EXIT

bash scripts/prepare-win-native.sh prepare

npx vite build
npm run electron:build

export ELECTRON_CACHE="$PWD/release/.cache/electron"
export ELECTRON_BUILDER_CACHE="$PWD/release/.cache/builder"

# 两种产物：
#   nsis —— 安装器（部分 Win10 环境里 NSIS 的 System 插件会崩，见 docs/WINDOWS-BUILD.md）
#   zip  —— 免安装版，解压即用，完全绕开 NSIS
npx electron-builder --win nsis zip --x64 --publish never \
  --config.win.signAndEditExecutable=false

echo "[build-win] 产物:"
echo "  release/SLMonitor Setup 0.1.0.exe   （NSIS 安装器）"
echo "  release/SLMonitor-0.1.0-win.zip     （免安装版，推荐优先试这个）"
