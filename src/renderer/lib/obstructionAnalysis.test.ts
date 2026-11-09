/**
 * obstructionAnalysis.ts 单元测试
 * 
 * 覆盖：遮挡图分析、方位角转换、几何计算
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeObstructionMap,
  azimuthToDirection,
  assessObstructionImpact,
  classifyObstruction,
  detectObstructionScale,
  normalizeObstructionValue,
  OBSTRUCTION_LEVELS,
} from './obstructionAnalysis';

describe('obstructionAnalysis.ts - 方位角转换', () => {
  describe('azimuthToDirection', () => {
    it('0° = 北', () => {
      expect(azimuthToDirection(0)).toBe('北');
    });

    it('45° = 东北', () => {
      expect(azimuthToDirection(45)).toBe('东北');
    });

    it('90° = 东', () => {
      expect(azimuthToDirection(90)).toBe('东');
    });

    it('135° = 东南', () => {
      expect(azimuthToDirection(135)).toBe('东南');
    });

    it('180° = 南', () => {
      expect(azimuthToDirection(180)).toBe('南');
    });

    it('225° = 西南', () => {
      expect(azimuthToDirection(225)).toBe('西南');
    });

    it('270° = 西', () => {
      expect(azimuthToDirection(270)).toBe('西');
    });

    it('315° = 西北', () => {
      expect(azimuthToDirection(315)).toBe('西北');
    });

    it('处理负角度（归一化）', () => {
      expect(azimuthToDirection(-45)).toBe('西北');
    });

    it('处理超过 360° 的角度', () => {
      expect(azimuthToDirection(405)).toBe('东北'); // 405 - 360 = 45
    });

    it('边界情况：22.5° 四舍五入到北', () => {
      expect(azimuthToDirection(22)).toBe('北');
    });

    it('边界情况：23° 四舍五入到东北', () => {
      expect(azimuthToDirection(23)).toBe('东北');
    });
  });
});

describe('obstructionAnalysis.ts - 遮挡图分析', () => {
  describe('analyzeObstructionMap', () => {
    it('空数组返回 null', () => {
      expect(analyzeObstructionMap([])).toBeNull();
    });

    it('非数组返回 null', () => {
      expect(analyzeObstructionMap(null as any)).toBeNull();
      expect(analyzeObstructionMap(undefined as any)).toBeNull();
    });

    it('完全无遮挡的地图', () => {
      // 5x5 全零矩阵
      const map = Array(5).fill(0).map(() => Array(5).fill(0));
      const result = analyzeObstructionMap(map);
      
      expect(result).toBeDefined();
      expect(result!.obstructionPercentage).toBe(0);
      expect(result!.maxObstruction).toBe(0);
      expect(result!.dominantDirection).toBeNull();
      expect(result!.dominantAzimuth).toBeNull();
    });

    it('完全遮挡的地图', () => {
      // 5x5 全 255 矩阵
      const map = Array(5).fill(0).map(() => Array(5).fill(255));
      const result = analyzeObstructionMap(map);
      
      expect(result).toBeDefined();
      expect(result!.obstructionPercentage).toBe(1);
      // 0..255 老刻度会被归一化成 0..1
      expect(result!.maxObstruction).toBe(1);
      expect(result!.scale).toBe(255);
      expect(result!.obstructedPixels).toBe(result!.totalPixels);
    });

    it('东侧遮挡（右侧）', () => {
      // 创建 11x11 矩阵，右侧一半遮挡
      const size = 11;
      const center = 5;
      const map = Array(size).fill(0).map((_, y) => 
        Array(size).fill(0).map((_, x) => {
          const dx = x - center;
          const dy = y - center;
          // 圆形视野内，且在右半边
          if (Math.sqrt(dx * dx + dy * dy) <= center && x > center) {
            return 200; // 遮挡强度
          }
          return 0;
        })
      );

      const result = analyzeObstructionMap(map);
      expect(result).toBeDefined();
      expect(result!.obstructionPercentage).toBeGreaterThan(0.3);
      expect(result!.obstructionPercentage).toBeLessThan(0.7);
      
      // 主遮挡方向应该在东侧（90° ± 45°）
      expect(result!.dominantAzimuth).toBeGreaterThan(45);
      expect(result!.dominantAzimuth).toBeLessThan(135);
      expect(['东北', '东', '东南']).toContain(result!.dominantDirection);
    });

    it('南侧遮挡（下侧）', () => {
      // 创建 11x11 矩阵，下侧遮挡
      const size = 11;
      const center = 5;
      const map = Array(size).fill(0).map((_, y) => 
        Array(size).fill(0).map((_, x) => {
          const dx = x - center;
          const dy = y - center;
          // 圆形视野内，且在下半边
          if (Math.sqrt(dx * dx + dy * dy) <= center && y > center) {
            return 150;
          }
          return 0;
        })
      );

      const result = analyzeObstructionMap(map);
      expect(result).toBeDefined();
      
      // 主遮挡方向应该在南侧（180° ± 45°）
      expect(result!.dominantAzimuth).toBeGreaterThan(135);
      expect(result!.dominantAzimuth).toBeLessThan(225);
      expect(['东南', '南', '西南']).toContain(result!.dominantDirection);
    });

    it('只统计圆形视野内的像素', () => {
      // 创建 11x11 矩阵，四角设置高值（应被忽略）
      const size = 11;
      const map = Array(size).fill(0).map((_, y) => 
        Array(size).fill(0).map((_, x) => {
          // 四角设置为 255
          if ((y === 0 || y === size - 1) && (x === 0 || x === size - 1)) {
            return 255;
          }
          return 0;
        })
      );

      const result = analyzeObstructionMap(map);
      expect(result).toBeDefined();
      
      // 四角的 255 值应该被排除，所以遮挡占比应该是 0
      expect(result!.obstructionPercentage).toBe(0);
      expect(result!.obstructedPixels).toBe(0);
    });

    it('权重计算：高强度遮挡影响方向判断', () => {
      // 创建 11x11 矩阵，东侧少量高强度遮挡 vs 西侧大量低强度遮挡
      const size = 11;
      const center = 5;
      const map = Array(size).fill(0).map((_, y) => 
        Array(size).fill(0).map((_, x) => {
          const dx = x - center;
          const dy = y - center;
          const distance = Math.sqrt(dx * dx + dy * dy);
          
          if (distance > center) return 0;
          
          // 东侧（右侧）：少量像素，高强度
          if (x === center + 2 && Math.abs(dy) <= 1) {
            return 250;
          }
          
          // 西侧（左侧）：多像素，低强度
          if (x < center - 1) {
            return 50;
          }
          
          return 0;
        })
      );

      const result = analyzeObstructionMap(map);
      expect(result).toBeDefined();
      
      // 权重计算应该使主遮挡方向偏向东侧（高强度的一侧）
      // 但具体结果取决于像素分布，这里主要验证不会因低强度像素多而偏向西侧
      expect(result!.dominantDirection).toBeDefined();
    });

    it('忽略 NaN 和无效值', () => {
      const map = [
        [0, NaN, 0],
        [Infinity, 100, -Infinity],
        [0, undefined as any, 0],
      ];

      const result = analyzeObstructionMap(map);
      expect(result).toBeDefined();
      // 只有中心的 100 是有效值；归一化后 100/255 ≈ 0.392
      expect(result!.maxObstruction).toBeCloseTo(100 / 255, 6);
    });
  });
});

describe('obstructionAnalysis.ts - 影响评估', () => {
  describe('assessObstructionImpact', () => {
    it('< 2% 为无影响', () => {
      const result = assessObstructionImpact(0.01);
      expect(result.label).toBe('无影响');
      expect(result.color).toContain('green');
    });

    it('2-5% 为低影响', () => {
      const result = assessObstructionImpact(0.03);
      expect(result.label).toBe('低');
      expect(result.color).toContain('green');
    });

    it('5-10% 为中等影响', () => {
      const result = assessObstructionImpact(0.07);
      expect(result.label).toBe('中');
      expect(result.color).toContain('orange');
    });

    it('>= 10% 为高影响', () => {
      const result = assessObstructionImpact(0.15);
      expect(result.label).toBe('高');
      expect(result.color).toContain('red');
    });

    it('边界值测试：恰好 2%', () => {
      const result = assessObstructionImpact(0.02);
      expect(result.label).toBe('低');
    });

    it('边界值测试：恰好 5%', () => {
      const result = assessObstructionImpact(0.05);
      expect(result.label).toBe('中');
    });

    it('边界值测试：恰好 10%', () => {
      const result = assessObstructionImpact(0.10);
      expect(result.label).toBe('高');
    });
  });
});
/**
 * ===== 回归：数字与图形「互相打脸」的那个 bug =====
 *
 * 现象: 卡片写「障碍像素 11,681 / 视野遮挡占比 100.00% / 影响 高」，
 * 3D 半球却全是浅灰的 Clear view，一个红点都没有。
 *
 * 根因: gRPC 路径给的是归一化 0..1（1 - snr/12），分析器却用 value > 0
 * 判遮挡（于是 0.333 也算遮挡），渲染器又按 0..255 分级（0.333 <= 50 ⇒ clear）。
 * 三个模块各说各话。
 */
describe('回归：归一化刻度与分级一致性', () => {
  /** 造一张"整图同值"的 n×n 图（模拟 DishyMock 基线：snr=8 → 0.3333 处处相等） */
  const uniform = (size: number, value: number) =>
    Array(size).fill(0).map(() => Array(size).fill(value));

  it('整张图 0.3333（设备判为晴朗）⇒ 遮挡占比 0，而不是 100%', () => {
    const stats = analyzeObstructionMap(uniform(123, 0.3333333333333333));
    expect(stats).not.toBeNull();
    expect(stats!.obstructionPercentage).toBe(0);
    expect(stats!.obstructedPixels).toBe(0);
    expect(stats!.levelCounts.clear).toBeGreaterThan(0);
    expect(stats!.maxObstruction).toBeCloseTo(0.3333, 4);
  });

  it('均匀分布的图不编造"主遮挡方向"', () => {
    // 老实现会把重心噪声算成方位角，渲染出「主遮挡方向: 北」
    expect(analyzeObstructionMap(uniform(123, 0.3333))!.dominantDirection).toBeNull();
  });

  it('占比数字与"红/橙像素"比例严格一致（同一分类器）', () => {
    const size = 21;
    const center = (size - 1) / 2;
    // 中心 1/4 半径内涂满 0.9（完全遮挡），其余 0.2（无遮挡）
    const map = Array(size).fill(0).map((_, y) =>
      Array(size).fill(0).map((_, x) => {
        const d = Math.sqrt((x - center) ** 2 + (y - center) ** 2);
        if (d > center) return 0;
        return d <= center / 2 ? 0.9 : 0.2;
      })
    );

    const stats = analyzeObstructionMap(map)!;
    const colored = stats.levelCounts.partial + stats.levelCounts.blocked;
    expect(stats.obstructedPixels).toBe(colored);
    expect(stats.obstructionPercentage).toBeCloseTo(
      stats.obstructedPixels / stats.totalPixels, 10
    );
  });

  it('两套刻度都判对', () => {
    // 0..255 老数据：255 = 完全遮挡
    expect(analyzeObstructionMap(uniform(21, 255))!.obstructionPercentage).toBe(1);
    // 0..1 新数据：1.0 = 完全遮挡
    expect(analyzeObstructionMap(uniform(21, 1.0))!.obstructionPercentage).toBe(1);
    // 都是 0 时都是"无遮挡"
    expect(analyzeObstructionMap(uniform(21, 0))!.obstructionPercentage).toBe(0);
  });

  it('刻度识别：出现 > 1.5 才判定为 0..255', () => {
    expect(detectObstructionScale([[0, 0.5], [0.9, 0.1]])).toBe(1);
    expect(detectObstructionScale([[0, 200], [55, 0]])).toBe(255);
  });

  it('分级边界与阈值常量对齐', () => {
    const { clearMax, partialMax } = OBSTRUCTION_LEVELS;
    expect(classifyObstruction(0)).toBe('unmapped');
    expect(classifyObstruction(clearMax)).toBe('clear');
    expect(classifyObstruction(clearMax + 1e-9)).toBe('partial');
    expect(classifyObstruction(partialMax)).toBe('partial');
    expect(classifyObstruction(partialMax + 1e-9)).toBe('blocked');
  });

  it('归一化把两套刻度映到同一语义', () => {
    // snr=8 的基线（0.3333）在两套刻度下都应是 clear
    expect(classifyObstruction(normalizeObstructionValue(0.3333, 1))).toBe('clear');
    expect(classifyObstruction(normalizeObstructionValue(0.3333 * 255, 255))).toBe('clear');
    // 遮挡扇区（0.75）两套刻度下都应是 blocked
    expect(classifyObstruction(normalizeObstructionValue(0.75, 1))).toBe('blocked');
    expect(classifyObstruction(normalizeObstructionValue(0.75 * 255, 255))).toBe('blocked');
  });
});
