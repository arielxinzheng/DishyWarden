/**
 * 3D半球形遮挡视图组件
 * 用于仪表盘的遮挡概览卡片和障碍图页面
 * 使用统一的3D半球形透视投影算法
 */

import { useMemo } from 'react';

interface ObstructionHemisphereProps {
  data: number[][];
  width?: number;
  height?: number;
  showLegend?: boolean;
}

export function ObstructionHemisphere({ 
  data, 
  width = 360, 
  height = 280,
  showLegend = false 
}: ObstructionHemisphereProps) {
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
        
        // 获取颜色（四色分类：Unmapped/Clear/Partial/Obstruction）
        const color = getDishylinkColor(value);
        
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
    const directions = [
      { angle: -90, label: 'N' },  // 北（上）
      { angle: 0, label: 'E' },    // 东（右）
      { angle: 90, label: 'S' },   // 南（下）
      { angle: 180, label: 'W' },  // 西（左）
    ];
    
    directions.forEach(({ angle, label }) => {
      const rad = (angle * Math.PI) / 180;
      const x = centerX + compassRadius * Math.cos(rad);
      const y = centerY + (baseRadiusY * 0.35) * Math.sin(rad);
      ctx.fillText(label, x, y);
    });

    return canvas.toDataURL();
  }, [data, width, height]);

  if (!canvasDataUrl) {
    return (
      <div 
        className="flex items-center justify-center text-slate-500"
        style={{ width, height }}
      >
        加载中...
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
        <div className="flex items-center justify-center gap-6 mt-6 text-sm">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-gray-500"></div>
            <span className="text-gray-400">Unmapped</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-gray-300"></div>
            <span className="text-gray-300">Clear view</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-red-800"></div>
            <span className="text-red-400">Partial</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-red-500"></div>
            <span className="text-red-500">Obstructions</span>
          </div>
        </div>
      )}
    </div>
  );
}

// 障碍值到颜色的映射 (Dishylink 四色分类)
function getDishylinkColor(value: number): string {
  // Dishylink 使用四色分类而非渐变
  // 基于真实 Starlink 数据：0 = unmapped, 1-50 = clear, 51-200 = partial, 201+ = obstruction
  
  if (value === 0) {
    // Unmapped - 深灰色
    return 'rgba(107, 114, 128, 0.5)';
  } else if (value <= 50) {
    // Clear view - 浅灰白色
    return 'rgba(209, 213, 219, 0.9)';
  } else if (value <= 200) {
    // Partial obstruction - 暗红色
    return 'rgba(153, 27, 27, 0.85)';
  } else {
    // Obstructions - 亮红色
    return 'rgba(239, 68, 68, 0.9)';
  }
}