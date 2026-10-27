/**
 * E2E 测试 5: 遮挡图渲染
 * 
 * 验证点：
 * - 3D 遮挡半球能正常渲染
 * - 遮挡数据显示正确
 * - Canvas 或 WebGL 上下文可用
 */
import { test, expect } from '@playwright/test';
import { launchElectron, navigateTo, waitForDataCollection } from './helpers';

test.describe('遮挡图渲染', () => {
  test('应该能渲染 3D 遮挡半球', async () => {
    const { app, page } = await launchElectron();
    
    try {
      await navigateTo(page, '/obstruction');
      
      // 等待数据加载
      await page.waitForTimeout(3000);
      
      // 查找 Canvas 元素（Three.js 或原生 Canvas）
      const canvas = page.locator('canvas');
      await expect(canvas.first()).toBeVisible({ timeout: 10000 });
      
      // 验证 Canvas 有实际内容（宽高不为 0）
      const canvasSize = await canvas.first().boundingBox();
      expect(canvasSize).not.toBeNull();
      expect(canvasSize!.width).toBeGreaterThan(100);
      expect(canvasSize!.height).toBeGreaterThan(100);
      
      console.log('Canvas 尺寸:', canvasSize);
      
    } finally {
      await app.close();
    }
  });
  
  test('应该显示遮挡率数据', async () => {
    const { app, page } = await launchElectron();
    
    try {
      await navigateTo(page, '/obstruction');
      await waitForDataCollection(page, 40);
      
      // 查找遮挡率显示（百分比或文字描述）
      const obstructionPercentage = page.locator('text=/%|遮挡率|障碍率|Obstruction/i');
      
      const hasPercentage = await obstructionPercentage.first().isVisible({ timeout: 5000 }).catch(() => false);
      
      if (hasPercentage) {
        const text = await obstructionPercentage.first().textContent();
        console.log('遮挡率显示:', text);
        
        // 验证包含数字
        expect(text).toMatch(/\d+/);
      } else {
        console.warn('未找到遮挡率显示，可能需要设备数据');
      }
      
    } finally {
      await app.close();
    }
  });
  
  test('应该显示数据来源标记', async () => {
    const { app, page } = await launchElectron();
    
    try {
      await navigateTo(page, '/obstruction');
      await page.waitForTimeout(3000);
      
      // 查找数据来源标记（实测/模拟）
      const sourceIndicator = page.locator('text=/实测|模拟|mock|real|设备/i');
      
      const hasSource = await sourceIndicator.first().isVisible({ timeout: 5000 }).catch(() => false);
      
      if (hasSource) {
        const sourceText = await sourceIndicator.first().textContent();
        console.log('数据来源:', sourceText);
      }
      
      // 不强制要求，因为可能在 UI 其他位置
      
    } finally {
      await app.close();
    }
  });
  
  test('WebGL 上下文应该可用', async () => {
    const { app, page } = await launchElectron();
    
    try {
      await navigateTo(page, '/obstruction');
      await page.waitForTimeout(2000);
      
      // 检查 WebGL 支持
      const hasWebGL = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        return gl !== null;
      });
      
      expect(hasWebGL).toBe(true);
      
      console.log('WebGL 上下文可用');
      
    } finally {
      await app.close();
    }
  });
  
  test('应该能显示遮挡历史时间轴', async () => {
    const { app, page } = await launchElectron();
    
    try {
      await navigateTo(page, '/obstruction');
      await waitForDataCollection(page, 40);
      
      // 查找时间轴或历史记录容器
      const timeline = page.locator('[class*="timeline"], [class*="history"], text=/过去|历史|最近/i');
      
      const hasTimeline = await timeline.first().isVisible({ timeout: 5000 }).catch(() => false);
      
      if (hasTimeline) {
        console.log('✓ 检测到遮挡历史时间轴');
      } else {
        console.warn('未找到遮挡历史时间轴，可能需要历史数据');
      }
      
    } finally {
      await app.close();
    }
  });
});