/**
 * 配置管理器回归测试
 *
 * 重点守一个历史坑：**老配置文件里没有新增段落 ⇒ 合并时必须兜底**，
 * 否则 `config.cloud.endpoint` 直接抛 TypeError，整个设置页白屏
 * （DishyWarden 踩坑备忘 §22：老配置缺新字段 ⇒ 必须在 load() 里兼容合并）。
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { CLOUD_ENDPOINT, UPDATE_FEED_URL } from './manager';
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

    expect(cloud.endpoint).toBe(CLOUD_ENDPOINT); // 后台常量, 用户不可改
    expect(cloud.clientId).toBe('');
    expect(cloud.feedbackEnabled).toBe(false);
    expect(cloud.updateFeedUrl).toBe(UPDATE_FEED_URL);
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
    expect(manager.getConfig().cloud.endpoint).toBe(CLOUD_ENDPOINT);
    expect(manager.getConfig().cloud.checkIntervalHours).toBe(12);
  });

  it('已有 cloud 配置: 用户意愿字段保留, endpoint/feed 强制用后台常量', () => {
    writeConfig({
      cloud: {
        endpoint: 'https://cloud.example.com', // 老版本存下来的，必须被覆盖
        clientId: 'abc-123',
        feedbackEnabled: true,
        updateFeedUrl: 'https://example.com/latest.yml',
        checkIntervalHours: 6,
      },
      version: '0.1.0',
    });

    const cloud = new ConfigManager().getConfig().cloud;

    // endpoint / updateFeedUrl 由后台固定（防填错、防指向第三方）
    expect(cloud.endpoint).toBe(CLOUD_ENDPOINT);
    expect(cloud.updateFeedUrl).toBe(UPDATE_FEED_URL);
    // 其余是用户意愿，照旧保留
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
    expect(cloud.endpoint).toBe(CLOUD_ENDPOINT); // 后台常量, 用户不可改
  });

  it('updateCloudConfig 应落盘,重开管理器仍在', () => {
    const manager = new ConfigManager();
    manager.updateCloudConfig({ feedbackEnabled: true });

    const reopened = new ConfigManager();
    expect(reopened.getConfig().cloud.feedbackEnabled).toBe(true);
  });

  it('updateCloudConfig 不采纳 endpoint / updateFeedUrl（防篡改渲染层）', () => {
    const manager = new ConfigManager();
    manager.updateCloudConfig({
      endpoint: 'https://evil.example.com',
      updateFeedUrl: 'https://evil.example.com/latest.yml',
      feedbackEnabled: true,
    });

    const cloud = manager.getConfig().cloud;
    expect(cloud.endpoint).toBe(CLOUD_ENDPOINT);
    expect(cloud.updateFeedUrl).toBe(UPDATE_FEED_URL);
    expect(cloud.feedbackEnabled).toBe(true);
  });
});

describe('配置落盘健壮性', () => {
  // ConfigManager 的路径 = <userData>/config/config.json，
  // 测试里 userData 被 mock 成 tmpDir（见文件头的 vi.mock）
  const configPath = () => path.join(tmpDir, 'config', 'config.json');

  it('保存后目录里应有 .bak（上一次的好配置）', () => {
    const manager = new ConfigManager();
    manager.updateCloudConfig({ feedbackEnabled: true });
    manager.updateCloudConfig({ feedbackEnabled: false });

    expect(fs.existsSync(`${configPath()}.bak`)).toBe(true);
  });

  it('配置文件损坏时不覆盖原文件 —— 改名留证后用默认值启动', () => {
    // 半截 JSON（模拟写盘途中进程被杀）
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });
    fs.writeFileSync(configPath(), '{"collector": {"interval": 30000', 'utf-8');

    const manager = new ConfigManager();
    // 应用仍能起来（默认值）
    expect(manager.getConfig().collector.interval).toBe(30000);
    // 坏文件被改名留证 —— 原始内容还在，没被抹掉
    expect(fs.existsSync(`${configPath()}.corrupt`)).toBe(true);
    expect(fs.readFileSync(`${configPath()}.corrupt`, 'utf-8')).toContain('"collector"');
    // 同名位置现在是一份可用的默认配置
    expect(() => JSON.parse(fs.readFileSync(configPath(), 'utf-8'))).not.toThrow();
  });

  it('保存过程中不留 .tmp 残留', () => {
    const manager = new ConfigManager();
    manager.updateCloudConfig({ feedbackEnabled: true });
    expect(fs.existsSync(`${configPath()}.tmp`)).toBe(false);
  });
});
