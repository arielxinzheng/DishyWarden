/**
 * 3D半球形遮挡视图组件
 * 用于仪表盘的遮挡概览卡片和障碍图页面
 * 使用统一的3D半球形透视投影算法
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  OBSTRUCTION_LEVEL_COLORS,
  classifyObstruction,
  detectObstructionScale,
  normalizeObstructionValue,
} from '../../lib/obstructionAnalysis';

export interface ObstructionHighlight {
  /** 主遮挡方位角（度，0=北，顺时针） */
  azimuth: number;
  /**
   * 方位语义码（`N`/`NE`/…，来自 `obstructionAnalysis` 的 CompassDirection）。
   * 本组件只用 azimuth 选最近的罗盘标签，文本由调用方自行本地化。
   */
  text: string;
}

interface ObstructionHemisphereProps {
  data: number[][];
  width?: number;
  height?: number;
  showLegend?: boolean;
  /** 主遮挡方向：高亮罗盘标签并在边缘画出指示箭头 */
  highlight?: ObstructionHighlight | null;
}

export function ObstructionHemisphere({ 
  data, 
  width = 360, 
  height = 280,
  showLegend = false,
  highlight = null,
}: ObstructionHemisphereProps) {
  const { t } = useTranslation();
  const canvasDataUrl = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // 深色背景渐变
    const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
    bgGradient.addColorStop(0, width > 400 ? '#0a0a0a' : 'rgba(10, 10, 10, 0.3)');
    bgGradient.addColorStop(1, width > 400 ? '#2a3540' : 'rgba(42, 53, 64, 0.5)');
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, width, height);

    // 3D 半球参数 - 根据尺寸自适应
    const centerX = width / 2;
    const centerY = height * 0.58; // 稍微偏下以显示 3D 透视
    const baseRadiusX = width * (width > 400 ? 0.343 : 0.34); // 椭圆 X 半径（宽度）
    const baseRadiusY = height * (width > 400 ? 0.364 : 0.36); // 椭圆 Y 半径（高度，形成 3D 透视）
    const gridSize = data.length; // 通常是 123
    const gridCenter = (gridSize - 1) / 2;
    // 刻度只在这里判一次，保证与分析卡片的占比口径完全一致
    const scale = detectObstructionScale(data);

    // 先绘制地平线轮廓椭圆（作为背景）
    ctx.strokeStyle = width > 400 ? 'rgba(100, 116, 139, 0.4)' : 'rgba(100, 116, 139, 0.3)';
    ctx.lineWidth = width > 400 ? 2 : 1.5;
    ctx.beginPath();
    ctx.ellipse(centerX, centerY, baseRadiusX, baseRadiusY * 0.35, 0, 0, Math.PI * 2);
    ctx.stroke();

    // 收集所有点数据并按 z 深度排序（从后往前绘制）
    const points: Array<{
      x: number;
      y: number;
      z: number;
      color: string;
      size: number;
    }> = [];

    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const value = data[gy][gx];
        
        // 计算相对于网格中心的位置
        const dx = gx - gridCenter;
        const dy = gy - gridCenter;
        
        // 转换为极坐标
        const distance = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);
        
        // 归一化距离 (0 = 天顶, 1 = 地平线)
        const normalizedDist = distance / gridCenter;
        if (normalizedDist > 1) continue;
        
        // 3D 半球投影：
        // - 中心点在顶部（z 最大）
        // - 边缘点在底部椭圆上（z = 0）
        // 半球公式: z = sqrt(1 - r^2)
        const elevation = Math.sqrt(1 - normalizedDist * normalizedDist);
        
        // 将 3D 坐标投影到 2D
        // x, y 在椭圆平面上，z 决定垂直位置
        const projectedRadius = normalizedDist;
        const x = centerX + projectedRadius * baseRadiusX * Math.cos(angle);
        const y = centerY - elevation * baseRadiusY * 1.4 + projectedRadius * baseRadiusY * 0.35 * Math.sin(angle);
        
        // 获取颜色（四色分类）—— 分类器与分析卡片的占比统计是同一个函数，
        // 因此"红色面积"与"视野遮挡占比"不可能再对不上
        const level = classifyObstruction(normalizeObstructionValue(value, scale));
        const color = OBSTRUCTION_LEVEL_COLORS[level].canvas;
        
        // 点大小：远处（中心）小，近处（边缘）大，增强透视感
        const baseSize = width > 400 ? 2.2 : 1.4;
        const perspectiveSize = baseSize * (0.6 + 0.4 * normalizedDist);
        
        points.push({
          x,
          y,
          z: elevation,
          color,
          size: perspectiveSize,
        });
      }
    }

    // 按 z 深度排序（从后往前）
    points.sort((a, b) => a.z - b.z);

    // 绘制所有点
    points.forEach(point => {
      ctx.fillStyle = point.color;
      ctx.beginPath();
      ctx.arc(point.x, point.y, point.size, 0, Math.PI * 2);
      ctx.fill();
    });

    // 绘制简洁的罗盘标记（仅四个主方向）
    ctx.fillStyle = width > 400 ? 'rgba(148, 163, 184, 0.7)' : 'rgba(148, 163, 184, 0.6)';
    ctx.font = width > 400 ? '16px sans-serif' : '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    const compassRadius = baseRadiusX + (width > 400 ? 30 : 20);
    // 罗盘标签用国际通用字母（N/E/S/W），所有语言一致，无需翻译
    const directions = [
      { angle: -90, label: 'N' },  // 北（上）
      { angle: 0, label: 'E' },    // 东（右）
      { angle: 90, label: 'S' },   // 南（下）
      { angle: 180, label: 'W' },  // 西（左）
    ];

    // 主遮挡方向最接近哪个罗盘标签（8 方位名 → 最近的 4 向标签）
    const highlightLabel = highlight
      ? (() => {
          const az = ((highlight.azimuth % 360) + 360) % 360;
          // 45° 一档，四舍五入到最近的 90° 轴
          const idx = Math.round(az / 90) % 4;
          return ['N', 'E', 'S', 'W'][idx];
        })()
      : null;

    directions.forEach(({ angle, label }) => {
      const rad = (angle * Math.PI) / 180;
      const x = centerX + compassRadius * Math.cos(rad);
      const y = centerY + (baseRadiusY * 0.35) * Math.sin(rad);
      const isHighlight = highlightLabel === label;

      ctx.fillStyle = isHighlight ? 'rgba(251, 191, 36, 0.95)' : (width > 400 ? 'rgba(148, 163, 184, 0.7)' : 'rgba(148, 163, 184, 0.6)');
      ctx.font = isHighlight
        ? (width > 400 ? 'bold 18px sans-serif' : 'bold 12px sans-serif')
        : (width > 400 ? '16px sans-serif' : '11px sans-serif');
      ctx.fillText(label, x, y);
    });

    // 主方向箭头：贴着地平线椭圆，指向障碍所在方位
    if (highlight) {
      const azRad = ((highlight.azimuth - 90) * Math.PI) / 180;
      const arrowRadiusX = baseRadiusX + 6;
      const arrowRadiusY = baseRadiusY * 0.35 + 6;
      const ax = centerX + arrowRadiusX * Math.cos(azRad);
      const ay = centerY + arrowRadiusY * Math.sin(azRad);

      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(azRad);
      ctx.fillStyle = 'rgba(251, 191, 36, 0.95)';
      ctx.beginPath();
      ctx.moveTo(9, 0);
      ctx.lineTo(-5, 5);
      ctx.lineTo(-5, -5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    return canvas.toDataURL();
  }, [data, width, height, highlight]);

  if (!canvasDataUrl) {
    return (
      <div 
        className="flex items-center justify-center text-slate-500"
        style={{ width, height }}
      >
        {t('common:loading')}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center">
      <img 
        src={canvasDataUrl} 
        alt="3D Hemisphere Obstruction View"
        className="w-full h-auto"
        style={{ maxWidth: width, maxHeight: height }}
      />
      
      {/* Dishylink 风格图例 - 可选 */}
      {showLegend && (
        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mt-6 text-sm">
          {(['unmapped', 'clear', 'partial', 'blocked'] as const).map((level) => (
            <div key={level} className="flex items-center gap-2">
              <div className={`w-3 h-3 rounded-full ${OBSTRUCTION_LEVEL_COLORS[level].dot}`} />
              <span className="text-gray-300">
                {t(OBSTRUCTION_LEVEL_COLORS[level].labelKey)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 颜色映射已统一到 lib/obstructionAnalysis 的 OBSTRUCTION_LEVEL_COLORS ——
// 曾经这里有一套 0..255 阈值，而实测数据是 0..1，导致图形与数字互相矛盾。