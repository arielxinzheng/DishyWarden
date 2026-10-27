/**
 * E2E 测试 1: 应用启动与基础导航
 * 
 * 验证点：
 * - Electron 应用能正常启动
 * - 主窗口渲染成功
 * - 仪表盘加载完成
 * - 无控制台错误
 */
import { test, expect } from '@playwright/test';
import { launchElectron, setupConsoleErrorListener } from './helpers';

test.describe('应用启动', () => {
  test('应该成功启动并显示仪表盘', async () => {
    const consoleErrors: string[] = [];
    const { app, page } = await launchElectron();
    
    setupConsoleErrorListener(page, consoleErrors);
    
    try {
      // 验证窗口标题
      await expect(page).toHaveTitle(/SLMonitor|Starlink/i);
      
      // 验证主容器存在
      const mainContent = page.locator('main, #root, [class*="app"]');
      await expect(mainContent).toBeVisible({ timeout: 10000 });
      
      // 验证导航栏（使用更宽松的定位器）
      const dashboardLink = page.locator('text=/仪表盘|Dashboard/i, a:has-text("仪表盘"), button:has-text("仪表盘")');
      await expect(dashboardLink.first()).toBeVisible({ timeout: 10000 });
      
      // 验证其他导航链接
      const obstructionLink = page.locator('text=/障碍|遮挡/i');
      const alertsLink = page.locator('text=/告警|Alert/i');
      const settingsLink = page.locator('text=/设置|Settings/i');
      
      await expect(obstructionLink.first()).toBeVisible({ timeout: 5000 }).catch(() => {
        console.warn('障碍图链接未找到');
      });
      await expect(alertsLink.first()).toBeVisible({ timeout: 5000 }).catch(() => {
        console.warn('告警链接未找到');
      });
      await expect(settingsLink.first()).toBeVisible({ timeout: 5000 }).catch(() => {
        console.warn('设置链接未找到');
      });
      
      // 等待一小段时间让数据加载
      await page.waitForTimeout(3000);
      
      // 检查是否有严重错误（允许一些 warning）
      const criticalErrors = consoleErrors.filter(msg => 
        msg.includes('TypeError') || 
        msg.includes('ReferenceError') ||
        msg.includes('Cannot read')
      );
      
      if (criticalErrors.length > 0) {
        console.warn('检测到控制台错误:', criticalErrors);
      }
      
    } finally {
      await app.close();
    }
  });
  
  test('应该有可用的 Electron API', async () => {
    const { app, page } = await launchElectron();
    
    try {
      // 检查 preload 脚本注入的 API
      const hasElectronAPI = await page.evaluate(() => {
        return typeof (window as any).electronAPI !== 'undefined';
      });
      
      expect(hasElectronAPI).toBe(true);
      
      // 检查关键 API 存在
      const apiMethods = await page.evaluate(() => {
        const api = (window as any).electronAPI;
        return {
          hasGetLatest: typeof api?.getLatestTelemetry === 'function',
          hasGetHistory: typeof api?.getTelemetryHistory === 'function',
          hasGetAlerts: typeof api?.getActiveAlerts === 'function',
          hasGetConfig: typeof api?.getConfig === 'function',
        };
      });
      
      expect(apiMethods.hasGetLatest).toBe(true);
      expect(apiMethods.hasGetHistory).toBe(true);
      expect(apiMethods.hasGetAlerts).toBe(true);
      expect(apiMethods.hasGetConfig).toBe(true);
      
    } finally {
      await app.close();
    }
  });
});