/**
 * IP 粗略定位（城市级）—— dishylink 同款兜底。
 *
 * ## 为什么要它
 *
 * 浏览器定位依赖**操作系统的定位 provider**：
 * * macOS → CoreLocation
 * * Windows → WinRT `Geolocation.PublicIpAddressGeolocator`（公网 IP 定位）
 *
 * 在**远程桌面 / 虚拟化 / 精简系统**里，这套 provider 经常不可用或不被授权
 * ⇒ 拿不到任何坐标 ⇒ 界面只能让人手填。
 *
 * 而**只要能出网**，按出口 IP 查一个公开的地理服务就能拿到**城市级**坐标。
 * dishylink 就是这么做的（`src/lib/observerLocation.ts` 的 `requestIpLocation`）。
 *
 * ## 精度与定位
 *
 * * 城市级：误差可达**几百公里**（Starlink 场景下会偏向你的 PoP，而不是终端位置）。
 * * **不适合**算卫星仰角（仰角需要公里级精度）。
 * * ⇒ 界面上必须标注"粗略估算"，并保留手动精修入口。
 *
 * ## 隐私
 *
 * 这个请求会把**出口 IP** 交给第三方 ⇒ 所以它是**一个独立按钮**，
 * 用户点下去才发出请求；**绝不在后台自动调用**，也绝不与其他请求一起捎带。
 */

const IP_LOCATION_ENDPOINT = 'https://get.geojs.io/v1/ip/geo.json';
const DEFAULT_TIMEOUT_MS = 8000;

export interface IpLocation {
  lat: number;
  lon: number;
  /** 服务返回的城市/地区名（可能为空） */
  city?: string;
}

export interface IpLocationOptions {
  timeoutMs?: number;
  /** 便于测试注入 */
  fetchImpl?: typeof fetch;
}

/**
 * 按出口 IP 查询粗略位置。
 *
 * 失败时抛出带说明的 Error；调用方负责把它翻译成用户看得懂的文案。
 */
export async function requestIpLocation(options: IpLocationOptions = {}): Promise<IpLocation> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = typeof fetch !== 'undefined' ? fetch : undefined,
  } = options;

  if (!fetchImpl) {
    throw new Error('当前环境不支持网络请求');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(IP_LOCATION_ENDPOINT, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const raw = (await res.json()) as {
      latitude?: string | number;
      longitude?: string | number;
      city?: string;
    };

    // geojs 的经纬度是**字符串**；字段缺失会变成 NaN，必须显式判
    const lat = Number(raw.latitude);
    const lon = Number(raw.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error('服务返回的坐标无效');
    }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new Error('服务返回的坐标超出范围');
    }
    return { lat, lon, city: raw.city };
  } finally {
    clearTimeout(timer);
  }
}
