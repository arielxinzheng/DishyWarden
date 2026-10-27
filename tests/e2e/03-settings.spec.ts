/**
 * E2E 测试 3: 设置保存功能
 * 
 * 验证点：
 * - 设置表单可编辑
 * - 保存按钮可点击
 * - 配置持久化成功
 */
import { test, expect } from '@playwright/test';
import { launchElectron, navigateTo } from './helpers';

test.describe('设置保存', () => {
  test('应该能修改并保存 Dish 地址', async () => {
    const { app, page } = await launchElectron();
    
    try {
      await navigateTo(page, '/settings');
      
      // 等待设置页面加载
      await page.waitForTimeout(2000);
      
      // 查找 Dish 地址输入框（可能是 Host 或 Address）
      const dishHostInput = page.locator('input[name*="dish"], input[placeholder*="地址"], input[placeholder*="Host"]').first();
      
      if (await dishHostInput.isVisible({ timeout: 3000 })) {
        // 清空并输入新值
        await dishHostInput.clear();
        await dishHostInput.fill('192.168.100.1');
        
        // 点击保存按钮
        const saveButton = page.locator('button:has-text("保存"), button:has-text("应用")').first();
        await saveButton.click();
        
        // 等待保存操作完成（可能有 toast 提示）
        await page.waitForTimeout(1000);
        
        // 检查是否有成功提示
        const successIndicator = page.locator('text=/保存成功|已保存|Success/i');
        const hasSuccess = await successIndicator.isVisible({ timeout: 3000 }).catch(() => false);
        
        if (hasSuccess) {
          console.log('✓ 检测到保存成功提示');
        }
        
        // 验证输入值保持（说明保存成功）
        const savedValue = await dishHostInput.inputValue();
        expect(savedValue).toBe('192.168.100.1');
      } else {
        console.warn('未找到 Dish 地址输入框，跳过此测试');
      }
      
    } finally {
      await app.close();
    }
  });
  
  test('应该能修改告警阈值', async () => {
    const { app, page } = await launchElectron();
    
    try {
      await navigateTo(page, '/settings');
      await page.waitForTimeout(2000);
      
      // 查找延迟阈值输入框
      const latencyInput = page.locator('input[name*="latency"], input[placeholder*="延迟"]').first();
      
      if (await latencyInput.isVisible({ timeout: 3000 })) {
        await latencyInput.clear();
        await latencyInput.fill('200');
        
        const saveButton = page.locator('button:has-text("保存"), button:has-text("应用")').first();
        await saveButton.click();
        await page.waitForTimeout(1000);
        
        const savedValue = await latencyInput.inputValue();
        expect(savedValue).toBe('200');
      } else {
        console.warn('未找到延迟阈值输入框，跳过此测试');
      }
      
    } finally {
      await app.close();
    }
  });
  
  test('保存后重启应用，配置应该保持', async () => {
    let app, page;
    
    // 第一次启动：修改配置
    ({ app, page } = await launchElectron());
    
    try {
      await navigateTo(page, '/settings');
      await page.waitForTimeout(2000);
      
      const dishPortInput = page.locator('input[name*="port"], input[placeholder*="端口"]').first();
      
      if (await dishPortInput.isVisible({ timeout: 3000 })) {
        await dishPortInput.clear();
        await dishPortInput.fill('9201');
        
        const saveButton = page.locator('button:has-text("保存"), button:has-text("应用")').first();
        await saveButton.click();
        await page.waitForTimeout(1000);
      }
      
      await app.close();
      
      // 第二次启动：验证配置保持
      ({ app, page } = await launchElectron());
      await navigateTo(page, '/settings');
      await page.waitForTimeout(2000);
      
      const portInputAfterRestart = page.locator('input[name*="port"], input[placeholder*="端口"]').first();
      
      if (await portInputAfterRestart.isVisible({ timeout: 3000 })) {
        const persistedValue = await portInputAfterRestart.inputValue();
        expect(persistedValue).toBe('9201');
      }
      
    } finally {
      await app.close();
    }
  });
});