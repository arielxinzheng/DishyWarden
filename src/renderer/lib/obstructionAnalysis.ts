/**
 * 遮挡图分析工具
 *
 * 从 123x123 的遮挡矩阵里算出用户真正关心的三件事:
 *   1. 视野遮挡占比 —— 多少比例的视野被挡住
 *   2. 主遮挡方向 —— 障碍集中在哪个方位(而不是硬编码"西南")
 *   3. 影响评估 —— 按视野遮挡占比给出定性结论
 *
 * 坐标系: 矩阵行=y(从上到下), 列=x(从左到右), 中心为天顶。
 * Starlink 的遮挡图以天线朝向为基准, 所以这里的方位是
 * "相对天线朝向的方位", 不是正北。
 */

export interface ObstructionStats {
  /** 遮挡像素占比 0..1 */
  obstructionPercentage: number;
  /** 主遮挡方向(8 方位中文), 无明显遮挡时为 null */
  dominantDirection: string | null;
  /** 主遮挡方向的方位角(度, 0=正北顺时针), 无则 null */
  dominantAzimuth: number | null;
  /** 最大遮挡值 0-255 */
  maxObstruction: number;
  /** 参与统计的像素数(只算圆形视野内的) */
  totalPixels: number;
  obstructedPixels: number;
}

const DIRECTIONS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

/** 方位角(度) → 8 方位中文名 */
export function azimuthToDirection(azimuthDeg: number): string {
  const idx = Math.round(((azimuthDeg % 360) + 360) % 360 / 45) % 8;
  return DIRECTIONS[idx];
}

/**
 * 分析遮挡图。
 *
 * 只统计圆形视野内的像素 —— 矩阵四角是"未映射"区域(值为 0),
 * 把它们算进去会稀释视野遮挡占比。
 */
export function analyzeObstructionMap(map: number[][]): ObstructionStats | null {
  if (!Array.isArray(map) || map.length === 0) return null;

  const size = map.length;
  const center = (size - 1) / 2;

  let totalPixels = 0;
  let obstructedPixels = 0;
  let maxObstruction = 0;
  let weightedX = 0;
  let weightedY = 0;
  let weightSum = 0;

  for (let y = 0; y < size; y++) {
    const row = map[y];
    if (!Array.isArray(row)) continue;

    for (let x = 0; x < size; x++) {
      const value = row[x];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;

      const dx = x - center;
      const dy = y - center;
      // 圆形视野外不统计
      if (Math.sqrt(dx * dx + dy * dy) > center) continue;

      totalPixels++;
      if (value > maxObstruction) maxObstruction = value;
      if (value > 0) {
        obstructedPixels++;
        // 用遮挡强度做权重, 找重心 —— 比"最多像素的方向"更稳
        weightedX += dx * value;
        weightedY += dy * value;
        weightSum += value;
      }
    }
  }

  if (totalPixels === 0) return null;

  let dominantAzimuth: number | null = null;
  let dominantDirection: string | null = null;

  if (weightSum > 0) {
    const cx = weightedX / weightSum;
    const cy = weightedY / weightSum;
    // 矩阵 y 向下增长, 取反得到"向上为正"; x 向右为正
    // 方位角: 0=北(上), 顺时针
    const angleRad = Math.atan2(cx, -cy);
    dominantAzimuth = ((angleRad * 180) / Math.PI + 360) % 360;
    dominantDirection = azimuthToDirection(dominantAzimuth);
  }

  return {
    obstructionPercentage: obstructedPixels / totalPixels,
    dominantDirection,
    dominantAzimuth,
    maxObstruction,
    totalPixels,
    obstructedPixels,
  };
}

/**
 * 按视野遮挡占比给出定性影响评估。
 * 阈值与 Dashboard 的 getSeverityInfo 保持一致。
 */
export function assessObstructionImpact(
  percentage: number
): { label: string; color: string } {
  if (percentage < 0.02) return { label: '无影响', color: 'text-accent-green' };
  if (percentage < 0.05) return { label: '低', color: 'text-accent-green' };
  if (percentage < 0.10) return { label: '中', color: 'text-warning-orange' };
  return { label: '高', color: 'text-danger-red' };
}

/** 把遮挡图的采集时刻格式化成一句人话 */
export function describeObstructionAge(timestamp: number, now = Date.now()): string {
  const mins = Math.round((now - timestamp) / 60000);
  if (!Number.isFinite(mins)) return '时间未知';
  if (mins < 1) return '刚刚采集';
  if (mins < 60) return `${mins} 分钟前采集`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前采集`;
  return `${Math.floor(hours / 24)} 天前采集`;
}