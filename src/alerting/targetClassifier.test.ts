/**
 * 目标分类（内网 vs 公网）测试。
 *
 * 分错的后果很具体：
 * - 内网 webhook 被当成公网 ⇒ 断网时它本该立刻发，却被丢进队列；
 * - 公网 webhook 被当成内网 ⇒ 断网时它会一直干等，白白耗超时。
 */

import { describe, it, expect } from 'vitest';
import {
  classifyTarget,
  hostFromSmtpAddress,
  hostFromUrl,
  isLanHost,
} from './targetClassifier';

describe('内网主机判定', () => {
  it('RFC1918 私有网段是内网', () => {
    expect(isLanHost('192.168.1.10')).toBe(true);
    expect(isLanHost('192.168.100.1')).toBe(true);
    expect(isLanHost('10.0.0.5')).toBe(true);
    expect(isLanHost('10.255.255.254')).toBe(true);
    expect(isLanHost('172.16.0.1')).toBe(true);
    expect(isLanHost('172.31.255.254')).toBe(true);
  });

  it('172.32+ 不是私网段（公网）', () => {
    expect(isLanHost('172.32.0.1')).toBe(false);
    expect(isLanHost('172.15.0.1')).toBe(false);
    expect(isLanHost('8.8.8.8')).toBe(false);
    expect(isLanHost('1.1.1.1')).toBe(false);
  });

  it('本机回环与本地名是内网', () => {
    expect(isLanHost('127.0.0.1')).toBe(true);
    expect(isLanHost('localhost')).toBe(true);
    expect(isLanHost('::1')).toBe(true);
    expect(isLanHost('homeassistant')).toBe(true); // 裸主机名
    expect(isLanHost('nas.local')).toBe(true);
  });

  it('公网域名不是内网', () => {
    expect(isLanHost('api.telegram.org')).toBe(false);
    expect(isLanHost('example.com')).toBe(false);
    expect(isLanHost('hooks.example.co')).toBe(false);
  });

  it('大小写与空白不影响判定', () => {
    expect(isLanHost('  192.168.0.1 ')).toBe(true);
    expect(isLanHost('LOCALHOST')).toBe(true);
  });
});

describe('主机名提取', () => {
  it('从 URL 取主机名', () => {
    expect(hostFromUrl('http://192.168.1.10:8123/api/hook')).toBe('192.168.1.10');
    expect(hostFromUrl('https://hooks.example.com/x')).toBe('hooks.example.com');
    expect(hostFromUrl('http://user:pw@10.1.2.3:9000/p')).toBe('10.1.2.3');
  });

  it('URL 不合法时也要能提取（用户手写的地址不能因为解析失败就被当成公网）', () => {
    expect(hostFromUrl('192.168.1.10:8123/hook')).toBe('192.168.1.10');
    expect(hostFromUrl('http://')).toBe('');
  });

  it('从 SMTP 地址取主机名', () => {
    expect(hostFromSmtpAddress('smtp.gmail.com')).toBe('smtp.gmail.com');
    expect(hostFromSmtpAddress('mail.example.com:587')).toBe('mail.example.com');
    expect(hostFromSmtpAddress('user:pass@mail.local:25')).toBe('mail.local');
  });
});

describe('通道目标分类', () => {
  it('Telegram 恒为公网', () => {
    expect(classifyTarget('telegram', 'api.telegram.org').scope).toBe('public');
  });

  it('内网 webhook → 内网', () => {
    const t = classifyTarget('webhook', '192.168.1.50');
    expect(t.scope).toBe('lan');
    expect(t.reason).toContain('192.168.1.50');
  });

  it('公网 webhook → 公网', () => {
    expect(classifyTarget('webhook', 'hooks.example.com').scope).toBe('public');
  });

  it('内网 SMTP → 内网', () => {
    expect(classifyTarget('email', 'mail.local').scope).toBe('lan');
  });

  it('没填地址按公网处理（发不出去，交由队列兜住）', () => {
    const t = classifyTarget('webhook', '');
    expect(t.scope).toBe('public');
    expect(t.reason).toContain('未配置');
  });
});
