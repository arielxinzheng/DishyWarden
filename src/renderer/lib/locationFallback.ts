/**
 * 终端位置的取值链：星链终端 GPS → 浏览器定位 → 手动填写。
 *
 * ## 为什么要有这条链
 *
 * 用户反馈"获取不了位置"，实测下来两个来源都各有各的失败条件：
 *
 * * **星链终端 GPS**（`get_location`）：不依赖本机环境，但终端可能没开放
 *   本地网络访问（gRPC code 7），也可能这台固件压根没实现这个分支。
 * * **浏览器定位**（`navigator.geolocation`）：远程桌面会话里 Windows 的
 *   定位服务通常不可用 ⇒ 直接 `POSITION_UNAVAILABLE`。
 *
 * ⇒ 两条路都存在盲区 ⇒ **必须自动串联**：终端取不到就自动回落浏览器，
 * 用户只点一次按钮；两边都失败时，把**两条原因都带上**（用户最终只能手动填，
 * 得知道到底卡在哪一步）。
 *
 * 这个文件是纯函数，没有 React / Electron 依赖 ⇒ 可直接单测。
 */

/** 取值来源 */
export type LocationSource = 'dish' | 'browser' | 'manual';

export interface LocationSuccess {
  ok: true;
  lat: string;
  lon: string;
  source: LocationSource;
}

export interface LocationFailure {
  ok: false;
  /** 已尝试过的来源，按尝试顺序 */
  attempted: LocationSource[];
  /** 每个来源的失败原因（与 attempted 一一对应） */
  reasons: string[];
}

export interface LocationFallbackDeps {
  /** 从星链终端读位置；抛异常或返回 null 都视为失败 */
  fromDish: () => Promise<{ lat: number; lon: number } | null>;
  /** 浏览器定位；抛异常视为失败 */
  fromBrowser: () => Promise<{ lat: string; lon: string }>;
  /** 把终端侧的失败对象/异常格式化成一句话 */
  formatDishFailure: (error: unknown) => string;
  /** 把浏览器侧的失败格式化成一句话 */
  formatBrowserFailure: (error: unknown) => string;
}

/**
 * 按「浏览器 → 终端」的顺序尝试取值。
 *
 * ## 为什么浏览器在前
 *
 * 用户实测反馈：**星链终端的 GPS 接口在多数终端上已被封闭**
 * （`get_location` 分支不存在 ⇒ UNIMPLEMENTED；或终端不开放本地网络访问
 * ⇒ code 7）。把它当首选只会让人多点一次再失败。
 *
 * ⇒ 浏览器定位升为首选（本地桌面会话下最稳）；
 * ⇒ 终端 GPS 退为**自动回落**的第二步（少数开放该接口的终端能捡到）；
 * ⇒ 两者都失败 ⇒ 手动填写。
 */
export async function resolveLocation(
  deps: LocationFallbackDeps,
): Promise<LocationSuccess | LocationFailure> {
  const attempted: LocationSource[] = [];
  const reasons: string[] = [];

  // ── 1. 浏览器定位（首选）─────────────────────────────────────────
  attempted.push('browser');
  try {
    const fromBrowser = await deps.fromBrowser();
    return { ok: true, ...fromBrowser, source: 'browser' };
  } catch (err) {
    reasons.push(deps.formatBrowserFailure(err));
  }

  // ── 2. 星链终端 GPS（自动回落；多数终端已封闭该接口）──────────
  attempted.push('dish');
  try {
    const fromDish = await deps.fromDish();
    if (fromDish) {
      return {
        ok: true,
        lat: fromDish.lat.toFixed(6),
        lon: fromDish.lon.toFixed(6),
        source: 'dish',
      };
    }
    reasons.push(deps.formatDishFailure(null));
  } catch (err) {
    reasons.push(deps.formatDishFailure(err));
  }

  // ── 3. 都不行 ⇒ 交给用户手动填 ────────────────────────────────
  return { ok: false, attempted, reasons };
}
