import { describe, it, expect } from 'vitest';
import {
  requestGeolocation,
  GEO_PERMISSION_DENIED,
  GEO_POSITION_UNAVAILABLE,
  GEO_TIMEOUT,
} from './geolocation';

/** 造一个可控的 geolocation 桩 */
function stub(opts: {
  success?: { lat: number; lon: number };
  error?: { code: number; message?: string };
  /** 什么都不回调（模拟 provider 挂起） */
  silent?: boolean;
}) {
  const calls: Array<PositionOptions | undefined> = [];
  const getCurrentPosition = (
    _success: PositionCallback,
    error?: PositionErrorCallback | null,
    options?: PositionOptions,
  ) => {
    calls.push(options);
    if (opts.silent) return; // 永远不回调 ⇒ 模拟挂起
    if (opts.success) {
      _success({
        coords: {
          latitude: opts.success.lat,
          longitude: opts.success.lon,
          accuracy: 10,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
        timestamp: Date.now(),
      } as GeolocationPosition);
      return;
    }
    if (opts.error) {
      error?.({ code: opts.error.code, message: opts.error.message } as GeolocationPositionError);
    }
  };
  return { getCurrentPosition, calls };
}

describe('requestGeolocation', () => {
  it('成功时返回经纬度', async () => {
    const g = stub({ success: { lat: 39.9042, lon: 116.4074 } });
    const out = await requestGeolocation({ geolocation: g as never });
    expect(out.lat).toBeCloseTo(39.9042);
    expect(out.lon).toBeCloseTo(116.4074);
  });

  it('⭐ 必须传 enableHighAccuracy: true（否则 Chromium 走没 key 的网络定位）', async () => {
    const g = stub({ success: { lat: 1, lon: 2 } });
    await requestGeolocation({ geolocation: g as never });
    expect(g.calls[0]).toBeTruthy();
    // 这一条是本次回归的根因锁
    expect(g.calls[0]!.enableHighAccuracy).toBe(true);
    expect(g.calls[0]!.maximumAge).toBe(0);
  });

  it('权限被拒 ⇒ 抛 code 1', async () => {
    const g = stub({ error: { code: GEO_PERMISSION_DENIED, message: 'denied' } });
    await expect(requestGeolocation({ geolocation: g as never })).rejects.toMatchObject({
      code: GEO_PERMISSION_DENIED,
    });
  });

  it('位置不可用 ⇒ 抛 code 2', async () => {
    const g = stub({ error: { code: GEO_POSITION_UNAVAILABLE } });
    await expect(requestGeolocation({ geolocation: g as never })).rejects.toMatchObject({
      code: GEO_POSITION_UNAVAILABLE,
    });
  });

  it('⭐ provider 挂起（回调不触发）⇒ 硬超时兜底，抛 code 3', async () => {
    // 这是用户看到的"点了没反应、也没有错误"的成因
    const g = stub({ silent: true });
    const promise = requestGeolocation({
      geolocation: g as never,
      hardTimeoutMs: 30,
      timeoutMs: 10,
    });
    await expect(promise).rejects.toMatchObject({ code: GEO_TIMEOUT });
  });

  it('不支持 geolocation ⇒ 抛 code 2 而不是永远挂起', async () => {
    await expect(
      requestGeolocation({ geolocation: undefined as never }),
    ).rejects.toMatchObject({ code: GEO_POSITION_UNAVAILABLE });
  });
});
