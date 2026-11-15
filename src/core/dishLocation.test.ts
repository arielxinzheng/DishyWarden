/**
 * dish 侧位置：响应解析 + 失败分类 + 界面提示。
 *
 * 背景：远程 Windows 上 navigator.geolocation 拿不到位置（系统定位服务不可用），
 * 改为优先从 dish 自带 GPS 读。dish 默认可能不对局域网开放位置（PERMISSION_DENIED），
 * 这时界面必须告诉用户**去 App 里开哪个开关**，不能只说"失败"。
 */
import { describe, it, expect } from 'vitest';
import { parseDishLocation, classifyDishLocationError } from './dishGrpc';
import {
  geolocationCodeName,
  geolocationFailureText,
  dishLocationFailureText,
} from '../renderer/lib/locationMessages';

describe('parseDishLocation', () => {
  it('标准响应 getLocation.lla', () => {
    expect(
      parseDishLocation({
        id: '1',
        getLocation: { lla: { lat: 31.2304, lon: 121.4737, alt: 12.5 }, sigmaM: 3.2, source: 'GNSS_ONLY' },
      }),
    ).toEqual({ lat: 31.2304, lon: 121.4737, alt: 12.5, sigmaM: 3.2, source: 'GNSS_ONLY' });
  });

  it('兼容 dishGetLocation 键与 sigma_m', () => {
    expect(parseDishLocation({ dishGetLocation: { lla: { lat: -33.8, lon: 151.2 }, sigma_m: 5 } }))
      .toEqual({ lat: -33.8, lon: 151.2, sigmaM: 5 });
  });

  it('未定位（全 0 / 缺字段 / 越界）返回 null', () => {
    expect(parseDishLocation({ getLocation: { lla: { lat: 0, lon: 0 } } })).toBeNull();
    expect(parseDishLocation({ getLocation: {} })).toBeNull();
    expect(parseDishLocation({ getLocation: { lla: { lat: 95, lon: 10 } } })).toBeNull();
    expect(parseDishLocation({ id: '1' })).toBeNull();
  });
});

describe('classifyDishLocationError', () => {
  it.each([
    ['gRPC 调用失败: Permission denied (code 7)', 'permission_denied'],
    ['gRPC 调用失败: Unimplemented (code 12)', 'unsupported'],
    ['读取 dish 位置：设备不认任何一个候选分支 (getLocation)；最后错误: ...', 'unsupported'],
    ['无法编码请求：描述符里没有 Request 类型，且分支 getLocation 没有已知字段号', 'unsupported'],
    ['gRPC 调用失败: connect ECONNREFUSED 192.168.100.1:9201', 'unreachable'],
    ['gRPC 调用失败: unavailable (code 14)', 'unreachable'],
    ['something weird', 'other'],
  ])('%s ⇒ %s', (msg, expected) => {
    expect(classifyDishLocationError(msg)).toBe(expected);
  });
});

describe('界面提示带上真实错误码', () => {
  const t = (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}${JSON.stringify(opts)}` : key;

  it('geolocation code → 规范名', () => {
    expect(geolocationCodeName(1)).toBe('PERMISSION_DENIED');
    expect(geolocationCodeName(2)).toBe('POSITION_UNAVAILABLE');
    expect(geolocationCodeName(3)).toBe('TIMEOUT');
  });

  it('POSITION_UNAVAILABLE：说明 + 错误码 + Chromium 原文', () => {
    const text = geolocationFailureText(t, {
      code: 2,
      message: 'Network location provider at https://www.googleapis.com/ : No response received.',
    });
    expect(text).toContain('settings:location.position_unavailable');
    expect(text).toContain('"code":"POSITION_UNAVAILABLE"');
    expect(text).toContain('No response received.');
  });

  it('dish PERMISSION_DENIED：给出对应提示 + 原始错误', () => {
    const text = dishLocationFailureText(t, {
      reason: 'permission_denied',
      error: 'gRPC 调用失败: Permission denied (code 7)',
    });
    expect(text).toBe('settings:location.dish_permission_denied (gRPC 调用失败: Permission denied (code 7))');
  });
});
