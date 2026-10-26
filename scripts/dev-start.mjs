#!/usr/bin/env node

/**
 * 简化的开发启动脚本
 * 使用 tsx 实时编译 TypeScript 主进程代码
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

console.log('[dev-start] 启动 Vite 开发服务器...');

// 启动 Vite
const vite = spawn('npx', ['vite'], {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: true,
});

// 等待 Vite 启动
setTimeout(() => {
  console.log('[dev-start] 启动 Electron (使用 tsx 实时编译)...');
  
  // 使用 tsx 运行 TypeScript 主进程
  const electron = spawn('npx', ['electron', '.', '--inspect'], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ELECTRON_DEV: 'true',
    },
  });

  electron.on('exit', (code) => {
    console.log(`[dev-start] Electron 退出，代码: ${code}`);
    vite.kill();
    process.exit(code || 0);
  });
}, 3000);

vite.on('exit', (code) => {
  console.log(`[dev-start] Vite 退出，代码: ${code}`);
  process.exit(code || 0);
});

// 处理退出信号
process.on('SIGINT', () => {
  console.log('[dev-start] 收到中断信号，停止所有进程...');
  vite.kill();
  process.exit(0);
});