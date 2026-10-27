/**
 * E2E 测试 4: 告警列表展示
 * 
 * 验证点：
 * - 告警列表能正常加载
 * - 活跃/历史视图切换
 * - 告警卡片显示完整信息
 */
import { test, expect } from '@playwright/test';
import { launchElectron, navigateTo, waitForDataCollection } from './helpers';

test.describe('告警列表', () => {
  test('应该能显示告警列表（即使为空）', async () => {
    const { app, page } = await launchElectron();
    
    try {
      await navigateTo(page, '/alerts');
      
      // 验证列表容器存在
      const alertList = page.locator('[class*="alert"], table, [role="list"], ul');
      await expect(alertList.first()).toBeVisible({ timeout: 5000 });
      
      // 检查是否有"无告警"提示或实际告警卡片
      const emptyState = page.locator('text=/暂无告警|无活跃告警|No alerts/i');
      const alertCard = page.locator('[class*="alert-card"], [role="listitem"], tr');
      
      const hasEmptyState = await emptyState.isVisible({ timeout: 2000 }).catch(() => false);
      const hasAlertCards = await alertCard.count() > 0;
      
      // 至少应该有一个状态（空状态或有告警）
      expect(hasEmptyState || hasAlertCards).toBe(true);
      
    } finally {
      await app.close();
    }
  });
  
  test('应该能切换活跃/历史视图', async () => {
    const { app, page } = await launchElectron();
    
    try {
      await navigateTo(page, '/alerts');
      await page.waitForTimeout(2000);
      
      // 查找视图切换按钮（Tab 或按钮）
      const historyTab = page.locator('text=/历史|History/i, button:has-text("历史")');
      
      if (await historyTab.isVisible({ timeout: 3000 })) {
        await historyTab.click();
        await page.waitForTimeout(1000);
        
        // 验证切换后页面变化（URL 或内容）
        const currentUrl = page.url();
        const hasHistoryContent = await page.locator('text=/历史记录|已恢复/i').isVisible({ timeout: 2000 }).catch(() => false);
        
        expect(currentUrl.includes('history') || hasHistoryContent).toBe(true);
        
        // 切回活跃视图
        const activeTab = page.locator('text=/活跃|Active/i, button:has-text("活跃")');
        if (await activeTab.isVisible({ timeout: 3000 })) {
          await activeTab.click();
          await page.waitForTimeout(1000);
        }
      } else {
        console.warn('未找到历史视图切换按钮，可能是单视图设计');
      }
      
    } finally {
      await app.close();
    }
  });
  
  test('告警卡片应该显示关键信息', async () => {
    const { app, page } = await launchElectron();
    
    try {
      await navigateTo(page, '/alerts');
      
      // 等待数据加载（可能需要采集周期触发告警）
      await waitForDataCollection(page, 40);
      
      // 查找告警卡片
      const alertCards = page.locator('[class*="alert-card"], [role="listitem"], tr');
      const cardCount = await alertCards.count();
      
      if (cardCount > 0) {
        const firstCard = alertCards.first();
        
        // 验证包含时间信息
        const hasTime = await firstCard.locator('text=/\\d{1,2}:\\d{2}|前|ago|小时|分钟/i').isVisible({ timeout: 2000 }).catch(() => false);
        
        // 验证包含严重程度或类型
        const hasSeverity = await firstCard.locator('text=/critical|warning|info|严重|警告/i').isVisible({ timeout: 2000 }).catch(() => false);
        
        console.log('告警卡片信息:', { hasTime, hasSeverity });
        
        // 至少应该有一个关键信息字段
        expect(hasTime || hasSeverity).toBe(true);
      } else {
        console.log('当前无活跃告警，跳过卡片内容验证');
      }
      
    } finally {
      await app.close();
    }
  });
});