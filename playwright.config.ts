import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright 配置 - Electron E2E 测试
 * 
 * 运行命令：
 * - npm run test:e2e          # 运行所有 E2E 测试
 * - npm run test:e2e:ui       # UI 模式
 * - npm run test:e2e:debug    # 调试模式
 */
export default defineConfig({
  testDir: './tests/e2e',
  
  // 每个测试超时时间（包含启动 Electron + 数据加载）
  timeout: 120000, // 2 分钟
  
  // 期望断言超时
  expect: {
    timeout: 10000,
  },
  
  // 失败重试次数（Electron 启动有时会慢）
  retries: process.env.CI ? 2 : 1,
  
  // 并行运行测试（Electron 实例隔离）
  workers: process.env.CI ? 1 : 2,
  
  // 报告器
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list'],
  ],
  
  use: {
    // 失败时自动截图
    screenshot: 'only-on-failure',
    
    // 失败时记录追踪
    trace: 'retain-on-failure',
    
    // 视频录制（可选）
    video: process.env.CI ? 'retain-on-failure' : 'off',
  },
  
  // 项目配置
  projects: [
    {
      name: 'electron',
      use: { 
        ...devices['Desktop Chrome'],
        // Electron 特定配置会在测试文件中通过 electron.launch 处理
      },
    },
  ],
});