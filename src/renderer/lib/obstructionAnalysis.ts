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
 * ## 为什么这里不出现任何文案
 *
 * 本模块是**纯逻辑**：方位、分级、影响、检出时间一律返回语义码 / i18n 键，
 * 由视图层（页面、3D 图例）用 `t()` 翻译。单元测试因此只断言语义，
 * 不依赖用户当前语言 —— 翻译换语言时测试不该红。
 *
 * 坐标系: 矩阵行=y(从上到下), 列=x(从左到右), 中心为天顶。
 * Starlink 的遮挡图以天线朝向为基准, 所以这里的方位是
 * "相对天线朝向的方位", 不是正北。
 */

/** 8 方位语义码（罗盘方位，N = 正北 = 矩阵上方） */
export type CompassDirection = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

/** 8 方位码表，顺序即 0°/45°/90°/…（用于校验与遍历，不含任何文案） */
export const COMPASS_DIRECTIONS: readonly CompassDirection[] = [
  'N',
  'NE',
  'E',
  'SE',
  'S',
  'SW',
  'W',
  'NW',
] as const;

export interface ObstructionStats {
  /** 遮挡像素占比 0..1（只算"部分遮挡"及以上） */
  obstructionPercentage: number;
  /** 主遮挡方向(8 方位语义码), 遮挡分布没有明显偏向时为 null */
  dominantDirection: CompassDirection | null;
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

/**
 * 四色分级的唯一出处：3D 画布、卡点、图例都从这里取。
 *
 * 只保留「色值 + i18n 键」：原来的 `label`(英文) / `zh`(中文) 两套文案
 * 已收敛成一个键，按当前语言取一条 —— 中英混排的 `无遮挡 (Clear view)`
 * 也随之消失。
 */
export const OBSTRUCTION_LEVEL_COLORS: Record<
  ObstructionLevel,
  { canvas: string; dot: string; labelKey: string }
> = {
  unmapped: {
    canvas: 'rgba(107, 114, 128, 0.45)',
    dot: 'bg-gray-600',
    labelKey: 'obstruction:legend.unmapped',
  },
  clear: {
    canvas: 'rgba(209, 213, 219, 0.90)',
    dot: 'bg-gray-300',
    labelKey: 'obstruction:legend.clear',
  },
  partial: {
    canvas: 'rgba(194, 65, 12, 0.92)',
    dot: 'bg-orange-700',
    labelKey: 'obstruction:legend.partial',
  },
  blocked: {
    canvas: 'rgba(239, 68, 68, 0.95)',
    dot: 'bg-red-500',
    labelKey: 'obstruction:legend.blocked',
  },
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

/** 方位角(度) → 8 方位语义码 */
export function azimuthToDirection(azimuthDeg: number): CompassDirection {
  const idx = Math.round(((((azimuthDeg % 360) + 360) % 360) / 45)) % 8;
  return COMPASS_DIRECTIONS[idx]!;
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
  let dominantDirection: CompassDirection | null = null;

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

/** 影响评估的定性分级（语义码） */
export type ObstructionImpactLevel = 'none' | 'low' | 'medium' | 'high';

export interface ObstructionImpact {
  level: ObstructionImpactLevel;
  /** 文字颜色 class（纯样式，不是文案） */
  color: string;
  /** 文案键：视图层用 t(labelKey) 取当前语言 */
  labelKey: string;
}

/**
 * 按视野遮挡占比给出定性影响评估。
 * 阈值与 Dashboard 的 getSeverityInfo 保持一致。
 *
 * 返回的是语义码 + 文案键，**不再返回中文句子**。
 */
export function assessObstructionImpact(percentage: number): ObstructionImpact {
  if (percentage < 0.02) {
    return { level: 'none', color: 'text-accent-green', labelKey: 'obstruction:impact.none' };
  }
  if (percentage < 0.05) {
    return { level: 'low', color: 'text-accent-green', labelKey: 'obstruction:impact.low' };
  }
  if (percentage < 0.10) {
    return { level: 'medium', color: 'text-warning-orange', labelKey: 'obstruction:impact.medium' };
  }
  return { level: 'high', color: 'text-danger-red', labelKey: 'obstruction:impact.high' };
}

/** 遮挡图检出时间的语义描述单位 */
export type ObstructionAgeUnit = 'unknown' | 'just_now' | 'minutes' | 'hours' | 'days';

export interface ObstructionAge {
  unit: ObstructionAgeUnit;
  /** 只有 minutes/hours/days 时存在 */
  count?: number;
  /** 文案键：视图层用 t(labelKey, { count }) 取当前语言 */
  labelKey: string;
}

/**
 * 把遮挡图的采集时刻折算成「多久之前」的语义描述。
 *
 * 视图层拿到 unit + count 后自己挑文案（例如 `{{count}} 分钟前采集`），
 * 这里绝不拼中文 —— 否则切到英文时底部状态行会突然冒出中文。
 */
export function describeObstructionAge(timestamp: number, now = Date.now()): ObstructionAge {
  const mins = Math.round((now - timestamp) / 60000);
  if (!Number.isFinite(mins)) {
    return { unit: 'unknown', labelKey: 'obstruction:age.unknown' };
  }
  if (mins < 1) {
    return { unit: 'just_now', labelKey: 'obstruction:age.just_now' };
  }
  if (mins < 60) {
    return { unit: 'minutes', count: mins, labelKey: 'obstruction:age.minutes' };
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return { unit: 'hours', count: hours, labelKey: 'obstruction:age.hours' };
  }
  return { unit: 'days', count: Math.floor(hours / 24), labelKey: 'obstruction:age.days' };
}
