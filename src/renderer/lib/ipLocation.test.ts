import { describe, it, expect } from 'vitest';
import { requestIpLocation } from './ipLocation';

function fakeFetch(payload: unknown, ok = true, status = 200) {
  return (async () => ({
    ok,
    status,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

describe('requestIpLocation', () => {
  it('解析 geojs 返回的字符串经纬度', async () => {
    const out = await requestIpLocation({
      fetchImpl: fakeFetch({ latitude: '39.9042', longitude: '116.4074', city: 'Beijing' }),
    });
    expect(out.lat).toBeCloseTo(39.9042);
    expect(out.lon).toBeCloseTo(116.4074);
    expect(out.city).toBe('Beijing');
  });

  it('HTTP 失败 ⇒ 抛错', async () => {
    await expect(
      requestIpLocation({ fetchImpl: fakeFetch({}, false, 502) }),
    ).rejects.toThrow(/502/);
  });

  it('字段缺失（NaN）⇒ 抛错而不是返回 NaN 坐标', async () => {
    await expect(
      requestIpLocation({ fetchImpl: fakeFetch({ city: 'Nowhere' }) }),
    ).rejects.toThrow(/坐标无效/);
  });

  it('坐标越界 ⇒ 抛错', async () => {
    await expect(
      requestIpLocation({ fetchImpl: fakeFetch({ latitude: '999', longitude: '0' }) }),
    ).rejects.toThrow(/超出范围/);
  });
});
