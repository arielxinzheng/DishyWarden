/**
 * E2E 测试 2: 页面导航
 * 
 * 验证点：
 * - 所有导航链接可点击
 * - 页面切换正常
 * - 各页面关键元素存在
 */
import { test, expect } from '@playwright/test';
import { launchElectron, navigateTo } from './helpers';

test.describe('页面导航', () => {
  test('应该能导航到障碍图页面', async () => {
    const { app, page } = await launchElectron();
    
    try {
      await navigateTo(page, '/obstruction');
      
      // 验证页面标题或特征元素
      await expect(
        page.locator('text=遮挡图').or(page.locator('text=障碍'))
      ).toBeVisible({ timeout: 5000 });
      
      // 验证 3D 渲染容器或遮挡图容器
      const obstructionContainer = page.locator('canvas, [class*="obstruction"], [class*="hemisphere"]');
      await expect(obstructionContainer.first()).toBeVisible({ timeout: 10000 });
      
    } finally {
      await app.close();
    }
  });
  
  test('应该能导航到卫星雷达页面', async () => {
    const { app, page } = await launchElectron();
    
    try {
      await navigateTo(page, '/satellite');
      
      // 验证页面加载
      await expect(
        page.locator('text=卫星').or(page.locator('text=雷达'))
      ).toBeVisible({ timeout: 5000 });
      
      // 验证罗盘或卫星列表容器
      const radarElements = page.locator('canvas, [class*="radar"], [class*="satellite"]');
      await expect(radarElements.first()).toBeVisible({ timeout: 10000 });
      
    } finally {
      await app.close();
    }
  });
  
  test('应该能导航到告警页面', async () => {
    const { app, page } = await launchElectron();
    
    try {
      await navigateTo(page, '/alerts');
      
      // 验证页面标题
      await expect(page.locator('text=告警')).toBeVisible();
      
      // 验证告警列表容器（即使为空也应该存在）
      const alertContainer = page.locator('[class*="alert"], table, [role="list"]');
      await expect(alertContainer.first()).toBeVisible({ timeout: 5000 });
      
    } finally {
      await app.close();
    }
  });
  
  test('应该能导航到设置页面', async () => {
    const { app, page } = await launchElectron();
    
    try {
      await navigateTo(page, '/settings');
      
      // 验证页面标题
      await expect(page.locator('text=设置')).toBeVisible();
      
      // 验证保存按钮存在
      await expect(
        page.locator('button:has-text("保存")').or(page.locator('button:has-text("应用")')
      )).toBeVisible({ timeout: 5000 });
      
    } finally {
      await app.close();
    }
  });
  
  test('应该能在多个页面间切换', async () => {
    const { app, page } = await launchElectron();
    
    try {
      // 完整导航流程
      await navigateTo(page, '/');
      await expect(page.locator('text=仪表盘')).toBeVisible();
      
      await navigateTo(page, '/satellite');
      await expect(page.locator('text=卫星').or(page.locator('text=雷达'))).toBeVisible();
      
      await navigateTo(page, '/alerts');
      await expect(page.locator('text=告警')).toBeVisible();
      
      await navigateTo(page, '/settings');
      await expect(page.locator('text=设置')).toBeVisible();
      
      // 返回仪表盘
      await navigateTo(page, '/');
      await expect(page.locator('text=仪表盘')).toBeVisible();
      
    } finally {
      await app.close();
    }
  });
});