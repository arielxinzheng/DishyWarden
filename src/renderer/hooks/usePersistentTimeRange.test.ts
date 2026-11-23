/**
 * 周期偏好持久化的单元测试（#12：仪表盘不记住所选采集周期）。
 *
 * 覆盖三件事：
 *   ① 首次启动（没有历史选择）→ 默认 1h
 *   ② 读写往返 → 选 15m/6h 后重新读取仍是同一个值（模拟重启/切页回来）
 *   ③ 非法/损坏的存储值 → 回落默认 1h，不崩、不返回空选择
 *
 * 存储用结构化接口注入内存实现，所以在 node 测试环境里不需要 jsdom。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIME_RANGE,
  TIME_RANGE_OPTIONS,
  TIME_RANGE_SECONDS,
  TIME_RANGE_STORAGE_KEY,
  isValidTimeRange,
  readTimeRange,
  writeTimeRange,
  type TimeRange,
  type TimeRangeStorage,
} from './usePersistentTimeRange';

/** 内存版 localStorage（接口与真实 Storage 一致） */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage: TimeRangeStorage = {
    getItem: (key) => (data.has(key) ? data.get(key)! : null),
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
  return { storage, data };
}

/** 一个每次访问都抛异常的存储，模拟隐私模式/权限受限 */
const throwingStorage: TimeRangeStorage = {
  getItem() {
    throw new Error('SecurityError: localStorage is not available');
  },
  setItem() {
    throw new Error('QuotaExceededError: storage is full');
  },
};

describe('readTimeRange —— 首次启动与默认值', () => {
  it('没有任何历史选择时返回默认 1h', () => {
    expect(readTimeRange(memoryStorage().storage)).toBe(DEFAULT_TIME_RANGE);
    expect(DEFAULT_TIME_RANGE).toBe('1h');
  });

  it('存储不可用（null）时返回默认 1h', () => {
    expect(readTimeRange(null)).toBe(DEFAULT_TIME_RANGE);
  });

  it('读取抛异常时返回默认 1h，不向上冒泡', () => {
    expect(readTimeRange(throwingStorage)).toBe(DEFAULT_TIME_RANGE);
  });
});

describe('写入 + 读取往返（模拟切页往返 / 重启应用）', () => {
  it('保存 15m 后重新读取得到 15m', () => {
    const { storage } = memoryStorage();
    expect(writeTimeRange('15m', storage)).toBe(true);
    expect(readTimeRange(storage)).toBe('15m');
  });

  it('保存 6h 后重新读取得到 6h', () => {
    const { storage } = memoryStorage();
    expect(writeTimeRange('6h', storage)).toBe(true);
    expect(readTimeRange(storage)).toBe('6h');
  });

  it('多次切换以最后一次为准（不残留旧值）', () => {
    const { storage } = memoryStorage();
    writeTimeRange('15m', storage);
    writeTimeRange('6h', storage);
    writeTimeRange('1h', storage);
    expect(readTimeRange(storage)).toBe('1h');
    expect(storage.getItem(TIME_RANGE_STORAGE_KEY)).toBe('1h');
  });

  it('存的是裸字符串，与存储键约定一致', () => {
    const { storage, data } = memoryStorage();
    writeTimeRange('6h', storage);
    expect(data.get(TIME_RANGE_STORAGE_KEY)).toBe('6h');
  });

  it('写入抛异常时返回 false，但不会崩（下次启动回落默认）', () => {
    expect(writeTimeRange('15m', throwingStorage)).toBe(false);
  });
});

describe('非法/损坏的存储值回落默认 1h', () => {
  const invalidValues = [
    '30m', // 不支持的周期
    '24h', // SLICE_PLANS 里有，但选择器不接受
    '15M', // 大小写错误
    '1H',
    '1.5h',
    '15', // 只有数字
    '', // 空串
    'null',
    '"15m"', // 被 JSON 包装过（历史格式差异）
    '{"range":"15m"}',
    'undefined',
    '  1h  ', // 带空白
  ];

  for (const raw of invalidValues) {
    it(`存储值为 ${JSON.stringify(raw)} 时回落 1h`, () => {
      const { storage } = memoryStorage({ [TIME_RANGE_STORAGE_KEY]: raw });
      expect(readTimeRange(storage)).toBe(DEFAULT_TIME_RANGE);
    });
  }

  it('非法值不会被写入（返回 false）', () => {
    const { storage, data } = memoryStorage();
    // 模拟运行时拿到意料之外的值（类型系统之外的调用方）
    expect(writeTimeRange('2h' as unknown as TimeRange, storage)).toBe(false);
    expect(data.has(TIME_RANGE_STORAGE_KEY)).toBe(false);
    expect(readTimeRange(storage)).toBe(DEFAULT_TIME_RANGE);
  });
});

describe('isValidTimeRange —— 选择器选项与秒数表一致', () => {
  it('三个合法周期都通过校验', () => {
    for (const range of TIME_RANGE_OPTIONS) {
      expect(isValidTimeRange(range)).toBe(true);
    }
  });

  it('非字符串/非法字符串都不通过', () => {
    for (const value of [null, undefined, 0, 15, {}, [], '2h', '15M']) {
      expect(isValidTimeRange(value)).toBe(false);
    }
  });

  it('每个选项都有对应的查询秒数', () => {
    expect(TIME_RANGE_SECONDS['15m']).toBe(15 * 60);
    expect(TIME_RANGE_SECONDS['1h']).toBe(60 * 60);
    expect(TIME_RANGE_SECONDS['6h']).toBe(6 * 60 * 60);
    expect(Object.keys(TIME_RANGE_SECONDS)).toEqual([...TIME_RANGE_OPTIONS]);
  });
});
