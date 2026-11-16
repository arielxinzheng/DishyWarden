/**
 * E2E 测试辅助函数
 */
import { _electron as electron } from '@playwright/test';
// 类型专用导入：ElectronApplication / Page 只是类型，运行时没有这个导出。
// 写成值导入时 Playwright 的转译器会原样保留它，报
// "does not provide an export named 'ElectronApplication'"。
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

/**
 * 启动 Electron 应用
 */
export async function launchElectron(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(process.cwd(), 'dist-electron/main/index.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
  });

  // 等待第一个窗口
  const page = await app.firstWindow();
  
  // 等待应用初始化（渲染层加载）
  await page.waitForLoadState('domcontentloaded');
  
  // 等待 React 应用挂载（检查 root 元素有内容）
  await page.waitForSelector('#root > *', { timeout: 15000 }).catch(() => {
    // 如果没有 #root，尝试等待 body 有内容
    return page.waitForSelector('body > div', { timeout: 15000 });
  });
  
  // 额外等待路由初始化
  await page.waitForTimeout(2000);
  
  return { app, page };
}

/**
 * 清空测试数据库（避免状态污染）
 */
export async function cleanTestDatabase(): Promise<void> {
  const dbPath = path.join(
    os.homedir(),
    'Library/Application Support/Electron/data/telemetry.db'
  );
  
  try {
    await fs.unlink(dbPath);
  } catch (err) {
    // 文件不存在时忽略错误
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * 等待数据采集（采集器 30s 一次）
 * @param seconds 等待秒数，默认 35 秒（一个完整周期）
 */
export async function waitForDataCollection(page: Page, seconds = 35): Promise<void> {
  await page.waitForTimeout(seconds * 1000);
}

/**
 * 导航到指定页面
 */
export async function navigateTo(page: Page, route: '/' | '/obstruction' | '/alignment' | '/satellite' | '/alerts' | '/settings'): Promise<void> {
  const routeMap = {
    '/': ['仪表盘', 'Dashboard'],
    '/obstruction': ['障碍图', '遮挡', 'Obstruction'],
    '/alignment': ['校准', 'Alignment'],
    '/satellite': ['卫星雷达', '卫星', 'Satellite'],
    '/alerts': ['告警', 'Alert'],
    '/settings': ['设置', 'Settings'],
  };
  
  const keywords = routeMap[route];
  
  // 尝试多个可能的文本匹配
  for (const keyword of keywords) {
    const link = page.locator(`text=${keyword}, a:has-text("${keyword}"), button:has-text("${keyword}")`);
    const isVisible = await link.first().isVisible({ timeout: 2000 }).catch(() => false);
    
    if (isVisible) {
      await link.first().click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1000);
      return;
    }
  }
  
  // 如果所有关键词都找不到，抛出错误
  throw new Error(`无法找到导航到 ${route} 的链接`);
}

/**
 * 检查控制台错误
 */
export function setupConsoleErrorListener(page: Page, errors: string[]): void {
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });
  
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
}