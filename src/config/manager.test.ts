/**
 * 配置管理器回归测试
 *
 * 重点守一个历史坑：**老配置文件里没有新增段落 ⇒ 合并时必须兜底**，
 * 否则 `config.cloud.endpoint` 直接抛 TypeError，整个设置页白屏
 * （SLMonitor 踩坑备忘 §22：老配置缺新字段 ⇒ 必须在 load() 里兼容合并）。
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// electron 在测试环境不存在 ⇒ 用 mock 顶掉，只需 app.getPath
vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.SLMONITOR_TEST_CONFIG_DIR ?? '/tmp',
  },
}));

import { ConfigManager } from './manager';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slmonitor-cfg-'));
  process.env.SLMONITOR_TEST_CONFIG_DIR = tmpDir;
});

beforeEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
});

function writeConfig(content: Record<string, unknown>): void {
  const dir = path.join(tmpDir, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(content), 'utf-8');
}

describe('ConfigManager · cloud 段落兼容', () => {
  it('首次运行应带出完整的 cloud 默认值', () => {
    const manager = new ConfigManager();
    const cloud = manager.getConfig().cloud;

    expect(cloud.endpoint).toBe('');
    expect(cloud.clientId).toBe('');
    expect(cloud.feedbackEnabled).toBe(false);
    expect(cloud.updateFeedUrl).toBe('');
    expect(cloud.checkIntervalHours).toBe(12);
  });

  it('老配置文件没有 cloud 段时,读 cloud.endpoint 不应抛', () => {
    // 模拟老版本落盘的配置：只有 collector/prometheus 等旧段落
    writeConfig({
      collector: { interval: 30000, bufferSize: 2880, dishAddress: '127.0.0.1', dishPort: 9200 },
      prometheus: { port: 9090, retentionTime: '90d', scrapeInterval: '30s' },
      version: '0.1.0',
    });

    const manager = new ConfigManager();

    // 这行以前会直接抛 TypeError（loaded.cloud 是 undefined）
    expect(() => manager.getConfig().cloud.endpoint).not.toThrow();
    expect(manager.getConfig().cloud.endpoint).toBe('');
    expect(manager.getConfig().cloud.checkIntervalHours).toBe(12);
  });

  it('已有的 cloud 配置应被保留,不被默认值覆盖', () => {
    writeConfig({
      cloud: {
        endpoint: 'https://cloud.example.com',
        clientId: 'abc-123',
        feedbackEnabled: true,
        updateFeedUrl: 'https://example.com/latest.yml',
        checkIntervalHours: 6,
      },
      version: '0.1.0',
    });

    const cloud = new ConfigManager().getConfig().cloud;

    expect(cloud.endpoint).toBe('https://cloud.example.com');
    expect(cloud.clientId).toBe('abc-123');
    expect(cloud.feedbackEnabled).toBe(true);
    expect(cloud.checkIntervalHours).toBe(6);
  });

  it('updateCloudConfig 应只改动传入的字段', () => {
    const manager = new ConfigManager();

    manager.updateCloudConfig({ clientId: 'uuid-0001' });
    manager.updateCloudConfig({ feedbackEnabled: true });

    const cloud = manager.getConfig().cloud;
    expect(cloud.clientId).toBe('uuid-0001');
    expect(cloud.feedbackEnabled).toBe(true);
    expect(cloud.endpoint).toBe('');
  });

  it('updateCloudConfig 应落盘,重开管理器仍在', () => {
    const manager = new ConfigManager();
    manager.updateCloudConfig({ endpoint: 'https://cloud.example.com' });

    const reopened = new ConfigManager();
    expect(reopened.getConfig().cloud.endpoint).toBe('https://cloud.example.com');
  });
});
