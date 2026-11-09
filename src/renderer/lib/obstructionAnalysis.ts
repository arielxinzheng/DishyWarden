/**
 * 遮挡图分析工具
 *
 * 从 123x123 的遮挡矩阵里算出用户真正关心的三件事:
 *   1. 视野遮挡占比 —— 多少比例的视野被挡住
 *   2. 主遮挡方向 —— 障碍集中在哪个方位
 *   3. 影响评估 —— 按视野遮挡占比给出定性结论
 *
 * ## 为什么这里要负责「量纲归一化」
 *
 * 历史上有两套刻度同时存在，而且**没有任何一层把它们对齐**：
 *
 *   - gRPC 实测路径: `1 - snr/12`，结果是 **0..1 的归一化遮挡度**
 *     （见 `core/dishGrpc.getObstructionMap`）
 *   - 本地 mock 与早期数据: **0..255 的整数**（越高越挡）
 *
 * 渲染器当初按 0..255 写了分级阈值（0 / 1-50 / 51-200 / 201+），
 * 分析器却用 `value > 0` 判遮挡。于是同一张图会同时得到
 * 「100.00% 视野遮挡占比」和「全是浅灰 Clear view」——
 * 数据和图形互相打脸，用户没法判断该信哪个。
 *
 * ⇒ 现在所有下游（分析、3D 渲染、图例）**只认这里的分类器**，
 *   刻度归一化也只在这里做一次，两边不可能再分叉。
 *
 * 坐标系: 矩阵行=y(从上到下), 列=x(从左到右), 中心为天顶。
 * Starlink 的遮挡图以天线朝向为基准, 所以这里的方位是
 * "相对天线朝向的方位", 不是正北。
 */

export interface ObstructionStats {
  /** 遮挡像素占比 0..1（只算"部分遮挡"及以上） */
  obstructionPercentage: number;
  /** 主遮挡方向(8 方位中文), 遮挡分布没有明显偏向时为 null */
  dominantDirection: string | null;
  /** 主遮挡方向的方位角(度, 0=正北顺时针), 无则 null */
  dominantAzimuth: number | null;
  /** 最大遮挡度（**归一化后** 0..1，不是原始的 0..255） */
  maxObstruction: number;
  /** 参与统计的像素数(只算圆形视野内的) */
  totalPixels: number;
  /** 判为"部分遮挡 + 完全遮挡"的像素数 */
  obstructedPixels: number;
  /** 分级明细，供图例/调试对照 */
  levelCounts: Record<ObstructionLevel, number>;
  /** 识别出的原始刻度: 1 = 已是 0..1, 255 = 原始是 0..255 */
  scale: 1 | 255;
}

export type ObstructionLevel = 'unmapped' | 'clear' | 'partial' | 'blocked';

/**
 * 分级阈值（**归一化后** 0..1）。
 *
 * 依据: 归一化值 = 1 - snr/12，所以
 *   0.40 ≈ snr 7.2 dB —— 低于这个 SNR 才开始算"影响通信"
 *   0.65 ≈ snr 4.2 dB —— 低于这个 SNR 基本就是有东西挡着
 *
 * 实测校准: DishyMock 基线整图 snr=8（归一化 0.333）代表晴朗天空，
 * 设备同时上报 `fractionObstructed: 0`。所以 0.333 **必须判成 clear**，
 * 否则会把"无遮挡"报成 100% 遮挡 —— 这正是本次修的 bug。
 */
export const OBSTRUCTION_LEVELS = {
  /** <= 该值算无遮挡 */
  clearMax: 0.40,
  /** <= 该值算部分遮挡；超过则算完全遮挡 */
  partialMax: 0.65,
} as const;

/** 四色分级的唯一出处：3D 画布、卡点、图例都从这里取 */
export const OBSTRUCTION_LEVEL_COLORS: Record<
  ObstructionLevel,
  { canvas: string; dot: string; label: string; zh: string }
> = {
  unmapped: { canvas: 'rgba(107, 114, 128, 0.45)', dot: 'bg-gray-600', label: 'Unmapped', zh: '未扫描' },
  clear: { canvas: 'rgba(209, 213, 219, 0.90)', dot: 'bg-gray-300', label: 'Clear view', zh: '无遮挡' },
  partial: { canvas: 'rgba(194, 65, 12, 0.92)', dot: 'bg-orange-700', label: 'Partial', zh: '部分遮挡' },
  blocked: { canvas: 'rgba(239, 68, 68, 0.95)', dot: 'bg-red-500', label: 'Obstructions', zh: '完全遮挡' },
};

/**
 * 识别整张图用的是哪套刻度。
 *
 * 判据: 只要出现 > 1.5 的值，就只可能是 0..255 的老刻度
 * （归一化路径由 `Math.min(1, ...)` 保证不会超过 1）。
 */
export function detectObstructionScale(map: number[][]): 1 | 255 {
  for (const row of map) {
    if (!Array.isArray(row)) continue;
    for (const v of row) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 1.5) return 255;
    }
  }
  return 1;
}

/** 原始值 → 归一化遮挡度 0..1 */
export function normalizeObstructionValue(raw: number, scale: 1 | 255): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return scale === 255 ? Math.min(1, raw / 255) : Math.min(1, raw);
}

/**
 * 归一化遮挡度 → 四色分级。
 *
 * ⚠️ 传进来的必须是**归一化后**的值；原始值请先过 `normalizeObstructionValue`。
 */
export function classifyObstruction(normalized: number): ObstructionLevel {
  if (!Number.isFinite(normalized) || normalized <= 0) return 'unmapped';
  if (normalized <= OBSTRUCTION_LEVELS.clearMax) return 'clear';
  if (normalized <= OBSTRUCTION_LEVELS.partialMax) return 'partial';
  return 'blocked';
}

/** 某等级是否算"被遮挡"（占比统计用的口径） */
export function isObstructedLevel(level: ObstructionLevel): boolean {
  return level === 'partial' || level === 'blocked';
}

const DIRECTIONS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

/** 方位角(度) → 8 方位中文名 */
export function azimuthToDirection(azimuthDeg: number): string {
  const idx = Math.round(((((azimuthDeg % 360) + 360) % 360) / 45)) % 8;
  return DIRECTIONS[idx];
}

/**
 * 主方向的最小声称度。
 *
 * 遮挡在视野里均匀分布时（典型: 整图同一个值），加权重心就在圆心附近，
 * 此时算出来的方位是**纯噪声** —— 老版本会把它渲染成"主遮挡方向: 北"，
 * 一个完全是编造的结论。低于该阈值一律返回 null（"无明显遮挡"）。
 */
const MIN_DIRECTION_ASYMMETRY = 0.15;

/**
 * 分析遮挡图。
 *
 * 只统计圆形视野内的像素 —— 矩阵四角是"未映射"区域，算进去会稀释占比。
 */
export function analyzeObstructionMap(map: number[][]): ObstructionStats | null {
  if (!Array.isArray(map) || map.length === 0) return null;

  const size = map.length;
  const center = (size - 1) / 2;
  const scale = detectObstructionScale(map);

  let totalPixels = 0;
  let obstructedPixels = 0;
  let maxObstruction = 0;
  let weightedX = 0;
  let weightedY = 0;
  let weightSum = 0;

  const levelCounts: Record<ObstructionLevel, number> = {
    unmapped: 0,
    clear: 0,
    partial: 0,
    blocked: 0,
  };

  for (let y = 0; y < size; y++) {
    const row = map[y];
    if (!Array.isArray(row)) continue;

    for (let x = 0; x < size; x++) {
      const raw = row[x];
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;

      const dx = x - center;
      const dy = y - center;
      // 圆形视野外不统计
      if (Math.sqrt(dx * dx + dy * dy) > center) continue;

      totalPixels++;

      const value = normalizeObstructionValue(raw, scale);
      if (value > maxObstruction) maxObstruction = value;

      const level = classifyObstruction(value);
      levelCounts[level]++;

      if (isObstructedLevel(level)) {
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

  if (weightSum > 0 && center > 0) {
    const cx = weightedX / weightSum;
    const cy = weightedY / weightSum;
    // 重心偏离圆心的程度（0 = 完全均匀, 1 = 全挤在边缘一点）
    const asymmetry = Math.sqrt(cx * cx + cy * cy) / center;

    if (asymmetry >= MIN_DIRECTION_ASYMMETRY) {
      // 矩阵 y 向下增长, 取反得到"向上为正"
      const angleRad = Math.atan2(cx, -cy);
      dominantAzimuth = ((angleRad * 180) / Math.PI + 360) % 360;
      dominantDirection = azimuthToDirection(dominantAzimuth);
    }
  }

  return {
    obstructionPercentage: obstructedPixels / totalPixels,
    dominantDirection,
    dominantAzimuth,
    maxObstruction,
    totalPixels,
    obstructedPixels,
    levelCounts,
    scale,
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
