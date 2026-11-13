#!/usr/bin/env bash
#
# Windows 打包用：原生模块平台二进制切换。
#
# 为什么需要：better-sqlite3 是**平台相关**的二进制，本机 node_modules 里
# 是 Mach-O。直接打包 ⇒ Windows 上 require 失败 ⇒ 应用启动即崩。
#
# v130 = Electron 33 的 NODE_MODULE_VERSION（ABI 130），
# 必须与 package.json 里的 electron 版本匹配（改 electron 版本时要同步改这里）。
#
# 用法：
#   scripts/prepare-win-native.sh prepare   # 换成 Windows 版
#   scripts/prepare-win-native.sh restore   # 还原本机（macOS）版
#
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-prepare}"
MODULE_DIR="node_modules/better-sqlite3"
NODE_FILE="$MODULE_DIR/build/Release/better_sqlite3.node"
WORK="release/.prebuild"
ABI="v130"
VER="12.11.1"

mkdir -p "$WORK"

is_pe() { file "$NODE_FILE" 2>/dev/null | grep -q "PE32"; }

case "$MODE" in
  prepare)
    if is_pe; then
      echo "[native] 已经是 Windows 二进制，跳过下载"
      exit 0
    fi
    if [ ! -f "$WORK/better_sqlite3.node.macos" ]; then
      echo "[native] 备份本机 (macOS) 二进制..."
      cp "$NODE_FILE" "$WORK/better_sqlite3.node.macos"
    fi
    # 优先用已下载好的包（GitHub 偶发连不上时不必干等）
    if [ ! -s "$WORK/win32.tar.gz" ]; then
      echo "[native] 下载 win32-x64 / electron-$ABI 预编译包..."
      URL="https://github.com/WiseLibs/better-sqlite3/releases/download/v$VER/better-sqlite3-v$VER-electron-$ABI-win32-x64.tar.gz"
      curl -sSL --fail --max-time 300 -o "$WORK/win32.tar.gz" "$URL"
    else
      echo "[native] 复用已下载的 win32 预编译包"
    fi
    tar -xzf "$WORK/win32.tar.gz" -C "$WORK"
    cp "$WORK/build/Release/better_sqlite3.node" "$NODE_FILE"
    echo -n "[native] 已替换为: "; file "$NODE_FILE" | sed 's/.*: //'
    ;;

  restore)
    if [ -f "$WORK/better_sqlite3.node.macos" ]; then
      cp "$WORK/better_sqlite3.node.macos" "$NODE_FILE"
      echo -n "[native] 已还原本机版本: "; file "$NODE_FILE" | sed 's/.*: //'
    else
      echo "[native] 没有备份可还原（跳过）"
    fi
    ;;

  *)
    echo "用法: $0 prepare|restore" >&2
    exit 2
    ;;
esac
