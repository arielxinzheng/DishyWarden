/**
 * alertFormat.ts 单元测试
 * 
 * 覆盖：JSON 容错解析、告警持续时长计算
 */

import { describe, it, expect } from 'vitest';
import {
  parseRecommendations,
  parseEvidence,
  formatAlertDuration,
} from './alertFormat';

describe('alertFormat.ts - JSON 容错解析', () => {
  describe('parseRecommendations', () => {
    it('正常 JSON 数组解析', () => {
      const input = JSON.stringify(['建议1', '建议2', '建议3']);
      expect(parseRecommendations(input)).toEqual(['建议1', '建议2', '建议3']);
    });

    it('空值返回空数组', () => {
      expect(parseRecommendations(null)).toEqual([]);
      expect(parseRecommendations(undefined)).toEqual([]);
      expect(parseRecommendations('')).toEqual([]);
    });

    it('已经是数组直接返回', () => {
      const input = ['建议1', '建议2'] as any;
      expect(parseRecommendations(input)).toEqual(['建议1', '建议2']);
    });

    it('单个字符串 JSON 包装成数组', () => {
      const input = JSON.stringify('单条建议');
      expect(parseRecommendations(input)).toEqual(['单条建议']);
    });

    it('损坏的 JSON 当作纯文本单条展示', () => {
      const brokenJson = '这不是有效的JSON';
      expect(parseRecommendations(brokenJson)).toEqual(['这不是有效的JSON']);
    });

    it('非数组 JSON 对象返回空数组', () => {
      const input = JSON.stringify({ key: 'value' });
      expect(parseRecommendations(input)).toEqual([]);
    });

    it('数组中非字符串元素转为字符串', () => {
      const input = JSON.stringify([123, true, null]);
      expect(parseRecommendations(input)).toEqual(['123', 'true', 'null']);
    });
  });

  describe('parseEvidence', () => {
    it('正常 JSON 对象解析', () => {
      const input = JSON.stringify({ latency: 150, threshold: 100 });
      const result = parseEvidence(input);
      expect(result).toEqual({ latency: 150, threshold: 100 });
    });

    it('空值返回 null', () => {
      expect(parseEvidence(null)).toBeNull();
      expect(parseEvidence(undefined)).toBeNull();
      expect(parseEvidence('')).toBeNull();
    });

    it('损坏的 JSON 返回 null', () => {
      expect(parseEvidence('这不是JSON')).toBeNull();
      expect(parseEvidence('{"unclosed":')).toBeNull();
    });

    it('数组 JSON 返回 null（预期对象）', () => {
      const input = JSON.stringify([1, 2, 3]);
      expect(parseEvidence(input)).toBeNull();
    });

    it('字符串 JSON 返回 null（预期对象）', () => {
      const input = JSON.stringify('just a string');
      expect(parseEvidence(input)).toBeNull();
    });

    it('嵌套对象正确解析', () => {
      const input = JSON.stringify({
        metric: 'latency',
        details: { current: 150, avg: 45 },
      });
      const result = parseEvidence(input);
      expect(result).toHaveProperty('metric', 'latency');
      expect(result).toHaveProperty('details');
    });
  });

  describe('formatAlertDuration', () => {
    it('29秒显示为"不到 1 分钟"', () => {
      const start = '2024-01-15T10:00:00Z';
      const end = '2024-01-15T10:00:29Z';
      expect(formatAlertDuration(start, end)).toBe('不到 1 分钟');
    });

    it('小于 1 小时显示分钟', () => {
      const start = '2024-01-15T10:00:00Z';
      const end = '2024-01-15T10:25:00Z';
      expect(formatAlertDuration(start, end)).toBe('25 分钟');
    });

    it('小于 24 小时显示小时+分钟', () => {
      const start = '2024-01-15T10:00:00Z';
      const end = '2024-01-15T12:35:00Z';
      expect(formatAlertDuration(start, end)).toBe('2 小时 35 分钟');
    });

    it('大于 24 小时显示天数', () => {
      const start = '2024-01-15T10:00:00Z';
      const end = '2024-01-17T14:00:00Z';
      expect(formatAlertDuration(start, end)).toBe('2 天');
    });

    it('无效时间戳返回 null', () => {
      expect(formatAlertDuration('invalid', '2024-01-15T10:00:00Z')).toBeNull();
      expect(formatAlertDuration('2024-01-15T10:00:00Z', 'invalid')).toBeNull();
    });

    it('结束时间早于开始时间返回 null', () => {
      const start = '2024-01-15T10:00:00Z';
      const end = '2024-01-15T09:00:00Z';
      expect(formatAlertDuration(start, end)).toBeNull();
    });

    it('开始和结束相同返回"不到 1 分钟"', () => {
      const time = '2024-01-15T10:00:00Z';
      expect(formatAlertDuration(time, time)).toBe('不到 1 分钟');
    });
  });
});