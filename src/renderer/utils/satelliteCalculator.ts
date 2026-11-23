/**
 * 卫星轨道计算工具
 * 使用 SGP4 算法从 TLE 数据计算卫星位置
 */

// 用 shim 而不是直接 import 'satellite.js' —— 根入口会拉进 wasm runtime,
// 那会让 Vite 的生产构建因 top-level await 而失败。详见 satelliteShim.ts。
import * as satellite from './satelliteShim';

export interface TLEData {
  name: string;
  line1: string;
  line2: string;
}

export interface SatellitePosition {
  name: string;
  noradId: string;
  azimuth: number; // 方位角 0-360° (北=0°, 东=90°)
  elevation: number; // 仰角 0-90° (地平线=0°, 天顶=90°)
  range: number; // 距离 (km)
  velocity: number; // 速度 (km/s)
  latitude: number; // 卫星纬度
  longitude: number; // 卫星经度
  altitude: number; // 卫星高度 (km)
}

export interface ObserverLocation {
  latitude: number; // 观测者纬度 (度)
  longitude: number; // 观测者经度 (度)
  altitude: number; // 观测者海拔 (km, 默认 0)
}

/**
 * 从 localStorage 读取观测者位置
 */
export function getObserverLocation(): ObserverLocation | null {
  try {
    const lat = localStorage.getItem('terminal_latitude');
    const lon = localStorage.getItem('terminal_longitude');
    
    if (!lat || !lon) {
      return null;
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);

    // 验证有效性
    if (isNaN(latitude) || isNaN(longitude)) {
      return null;
    }

    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return null;
    }

    return {
      latitude,
      longitude,
      altitude: 0, // 默认海拔 0km
    };
  } catch (error) {
    console.error('Error reading observer location:', error);
    return null;
  }
}

/**
 * 将角度转换为弧度
 */
function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * 将弧度转换为角度
 */
function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

/**
 * 从 TLE 计算卫星在指定时间和观测者位置的可见性信息
 */
export function calculateSatellitePosition(
  tle: TLEData,
  observer: ObserverLocation,
  date: Date = new Date()
): SatellitePosition | null {
  try {
    // 解析 TLE
    const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
    
    // 计算卫星位置和速度 (ECI 坐标系)
    const positionAndVelocity = satellite.propagate(satrec, date);

    // propagate 可能返回 null, 也可能带 error 码 (2=decayed, 6=below horizon)
    if (!positionAndVelocity || !positionAndVelocity.position ||
        typeof positionAndVelocity.position === 'boolean') {
      return null;
    }

    const positionEci = positionAndVelocity.position as { x: number; y: number; z: number };
    const velocityEci = positionAndVelocity.velocity;

    // 将 ECI 转换为地理坐标
    const gmst = satellite.gstime(date);
    const positionGd = satellite.eciToGeodetic(positionEci, gmst);

    // 观测者位置 (地理坐标)
    const observerGd = {
      latitude: degreesToRadians(observer.latitude),
      longitude: degreesToRadians(observer.longitude),
      height: observer.altitude,
    };

    // 计算观测角度 (方位角、仰角、距离)
    //
    // satellite.js v7: ecfToLookAngles(observerGeodetic, satelliteEcf)
    // 第二个参数是 ECF 坐标 (见 node_modules/satellite.js/dist/transforms.js:136),
    // 注意不是 satGeodetic —— 传成地理坐标会静默返回 elevation: NaN。
    const positionEcf = satellite.eciToEcf(positionEci, gmst);
    const lookAngles = satellite.ecfToLookAngles(observerGd, positionEcf);

    // NaN 兜底: elevation 一旦是 NaN, filterVisibleSatellites 的 > 0 判定
    // 会把整页卫星全部滤掉, 表现为「一颗都看不到」。宁可不显示也不要静默清零。
    if (typeof lookAngles.elevation !== 'number' || Number.isNaN(lookAngles.elevation)) {
      return null;
    }

    // 提取 NORAD ID
    const noradId = tle.line1.substring(2, 7).trim();

    // 计算速度大小
    let velocityMagnitude = 0;
    if (velocityEci && typeof velocityEci !== 'boolean') {
      velocityMagnitude = Math.sqrt(
        velocityEci.x * velocityEci.x +
        velocityEci.y * velocityEci.y +
        velocityEci.z * velocityEci.z
      );
    }

    return {
      name: tle.name,
      noradId,
      azimuth: normalizeAzimuth(radiansToDegrees(lookAngles.azimuth)),
      elevation: radiansToDegrees(lookAngles.elevation),
      range: lookAngles.rangeSat,
      velocity: velocityMagnitude,
      latitude: radiansToDegrees(positionGd.latitude),
      longitude: radiansToDegrees(positionGd.longitude),
      altitude: positionGd.height,
    };
  } catch (error) {
    console.error(`Error calculating position for ${tle.name}:`, error);
    return null;
  }
}

/**
 * 把任意角度归一化到 [0, 360)。
 *
 * ⚠️ 必须做这一步：`satellite.js` 的 lookAngles.azimuth 是 **-π..π**，
 * 转成度数是 **-180..180**；而方位角（罗盘方位）的语义是 0..360。
 * 天空视图的极坐标角度轴是固定区间 `0..360`，负数会**落在轴范围外被静默丢弃** ——
 * 表现为「一半卫星不显示」「设备波束十字和当前服务卫星怎么都不出现」，
 * 因为服务/候选/波束往往都在同一个负方位角附近。
 */
export function normalizeAzimuth(degrees: number): number {
  if (!Number.isFinite(degrees)) return degrees;
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * 批量计算多个卫星的位置
 */
export function calculateMultipleSatellites(
  tles: TLEData[],
  observer: ObserverLocation,
  date: Date = new Date()
): SatellitePosition[] {
  return tles
    .map((tle) => calculateSatellitePosition(tle, observer, date))
    .filter((pos): pos is SatellitePosition => pos !== null);
}

/**
 * 过滤出地平线以上的卫星 (elevation > 0°)
 */
export function filterVisibleSatellites(
  positions: SatellitePosition[],
  minElevation: number = 0
): SatellitePosition[] {
  return positions.filter((pos) => pos.elevation > minElevation);
}

/**
 * 计算两个卫星之间的角距离
 */
export function calculateAngularSeparation(
  sat1: SatellitePosition,
  sat2: SatellitePosition
): number {
  const az1 = degreesToRadians(sat1.azimuth);
  const el1 = degreesToRadians(sat1.elevation);
  const az2 = degreesToRadians(sat2.azimuth);
  const el2 = degreesToRadians(sat2.elevation);

  // 转换为单位向量
  const x1 = Math.cos(el1) * Math.cos(az1);
  const y1 = Math.cos(el1) * Math.sin(az1);
  const z1 = Math.sin(el1);

  const x2 = Math.cos(el2) * Math.cos(az2);
  const y2 = Math.cos(el2) * Math.sin(az2);
  const z2 = Math.sin(el2);

  // 点积
  const dotProduct = x1 * x2 + y1 * y2 + z1 * z2;
  
  // 角距离
  const separation = Math.acos(Math.max(-1, Math.min(1, dotProduct)));
  
  return radiansToDegrees(separation);
}