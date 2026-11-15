/**
 * 浏览器定位（`navigator.geolocation`）调用封装。
 *
 * ## 为什么必须 `enableHighAccuracy: true`
 *
 * Chromium 的定位有两条 provider 链路：
 *
 * | 链路 | 依赖 | Electron 里能不能用 |
 * |---|---|---|
 * | **网络定位**（Google `geolocation/v1/geolocate`） | 需要 `GOOGLE_API_KEY` | ❌ **不能** —— Electron 不自带 key（Chrome/Edge 自带） |
 * | **平台 provider**（Windows `Geolocation.PublicIpAddressGeolocator` / macOS CoreLocation） | 操作系统 | ✅ 能 |
 *
 * `enableHighAccuracy: false` 会让 Chromium 优先走**网络定位** ⇒ 在 Electron 里
 * 永远拿不到位置（还会**静默挂起**，表现为"点了没反应、也没错误"）。
 * `true` 才会走**平台 provider** ⇒ 这才是 Electron 唯一可用的路径。
 *
 * ⚠️ 这不是我们拍脑袋：`enableHighAccuracy` 从 `true` 改成 `false` 的那一次提交，
 * 直接让本地 Electron 的定位从"能拿到"变成"拿不到"。
 * （dishylink 用 `false` 是因为它是浏览器扩展，Chrome/Edge 自带 API key。）
 *
 * ## 为什么还要自己加硬超时
 *
 * Chromium 自带的 `timeout` 只覆盖"等待位置"，**不覆盖权限询问与 provider 挂起**
 * ⇒ 极端情况下两个回调都不触发 ⇒ Promise 永远挂着 ⇒ 界面上的"获取中"转圈
 * 到天荒地老。所以我们**自己**加一个硬超时，保证界面一定给出结论。
 */

export interface GeoCoords {
  lat: number;
  lon: number;
}

/** 与 W3C `GeolocationPositionError` 同构的错误（code: 1/2/3） */
export interface GeoPositionError {
  code: number;
  message?: string;
}

export interface RequestGeolocationOptions {
  /** 传给 Chromium 的超时（毫秒），默认 15000 */
  timeoutMs?: number;
  /**
   * 我们自己的硬超时（毫秒），默认 20000。
   * 到点就以 code 3（TIMEOUT）失败 ⇒ 界面永远有结论。
   */
  hardTimeoutMs?: number;
  /** 定位实现，便于测试注入 */
  geolocation?: Pick<Geolocation, 'getCurrentPosition'>;
}

/** W3C 错误码 */
export const GEO_PERMISSION_DENIED = 1;
export const GEO_POSITION_UNAVAILABLE = 2;
export const GEO_TIMEOUT = 3;

/**
 * 请求一次浏览器定位。
 *
 * 成功返回经纬度；失败抛出带 `code` 的错误（1 权限被拒 / 2 位置不可用 / 3 超时）。
 */
export function requestGeolocation(
  options: RequestGeolocationOptions = {},
): Promise<GeoCoords> {
  const {
    timeoutMs = 15000,
    hardTimeoutMs = 20000,
    geolocation = typeof navigator !== 'undefined' ? navigator.geolocation : undefined,
  } = options;

  return new Promise<GeoCoords>((resolve, reject) => {
    if (!geolocation) {
      reject({ code: GEO_POSITION_UNAVAILABLE, message: 'geolocation unsupported' });
      return;
    }

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      fn();
    };

    // ⭐ 硬超时：Chromium 的回调不触发时我们自己兜底 ⇒ 界面永远有结论
    const hardTimer = setTimeout(() => {
      finish(() =>
        reject({
          code: GEO_TIMEOUT,
          message: `定位请求超时 (${hardTimeoutMs}ms)：系统未返回位置`,
        } satisfies GeoPositionError),
      );
    }, hardTimeoutMs);

    geolocation.getCurrentPosition(
      (position) => {
        finish(() =>
          resolve({
            lat: position.coords.latitude,
            lon: position.coords.longitude,
          }),
        );
      },
      (error) => {
        finish(() =>
          reject({ code: error.code, message: error.message } satisfies GeoPositionError),
        );
      },
      // ⚠️ enableHighAccuracy 必须是 true ⇒ 走平台 provider（详见文件头注释）
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}
