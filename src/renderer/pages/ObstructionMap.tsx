import { useDish } from '../hooks/useDish';
import { useMemo } from 'react';
import { ObstructionHemisphere } from '../components/Dashboard/ObstructionHemisphere';

/**
 * 障碍图页面
 * 显示星链天线视野中的障碍物分布
 * 123x123 网格，使用 Canvas 渲染热力图
 */
export default function ObstructionMap() {
  const { telemetry, isLoading, error } = useDish();

  // 计算障碍统计信息
  const stats = useMemo(() => {
    if (!telemetry?.obstructionMap) return null;

    const map = telemetry.obstructionMap;
    let totalPixels = 0;
    let obstructedPixels = 0;
    let maxObstruction = 0;

    for (const row of map) {
      for (const value of row) {
        totalPixels++;
        if (value > 50) obstructedPixels++; // 阈值: 50
        maxObstruction = Math.max(maxObstruction, value);
      }
    }

    const obstructionPercentage = (obstructedPixels / totalPixels) * 100;

    return {
      totalPixels,
      obstructedPixels,
      obstructionPercentage,
      maxObstruction,
    };
  }, [telemetry?.obstructionMap]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-400">加载障碍图数据...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="bg-red-900/20 border border-red-500 rounded-lg p-4">
          <p className="text-red-400">加载失败: {error}</p>
        </div>
      </div>
    );
  }

  if (!telemetry?.obstructionMap) {
    return (
      <div className="p-8">
        <div className="bg-yellow-900/20 border border-yellow-500 rounded-lg p-4">
          <p className="text-yellow-400">暂无障碍图数据</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      {/* 页面标题 */}
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">Obstructions</h1>
        <p className="text-gray-400">
          3D 半球形透视投影 - 中心为天顶，边缘为地平线
        </p>
      </div>

      {/* 统计卡片 */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <StatCard
            label="总像素数"
            value={stats.totalPixels.toLocaleString()}
            color="blue"
          />
          <StatCard
            label="障碍像素"
            value={stats.obstructedPixels.toLocaleString()}
            color="orange"
          />
          <StatCard
            label="障碍率"
            value={`${stats.obstructionPercentage.toFixed(2)}%`}
            color={stats.obstructionPercentage > 10 ? 'red' : 'green'}
          />
          <StatCard
            label="最大障碍值"
            value={stats.maxObstruction.toString()}
            color="purple"
          />
        </div>
      )}

      {/* 障碍图可视化 */}
      <div className="bg-gray-800 rounded-lg overflow-hidden flex justify-center py-6">
        <ObstructionHemisphere 
          data={telemetry.obstructionMap}
          width={700}
          height={550}
          showLegend={true}
        />
      </div>

      {/* 图例 */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-white mb-4">数据说明</h3>
        <p className="text-gray-400 text-sm">
          此视图使用 3D 半球形透视投影显示天线视野。中心代表天顶（正上方），边缘代表地平线。
          颜色分类对应不同的信号质量：浅灰色表示无遮挡，红色表示障碍物。
        </p>
      </div>
    </div>
  );
}

// 统计卡片组件
interface StatCardProps {
  label: string;
  value: string;
  color: 'blue' | 'green' | 'orange' | 'red' | 'purple';
}

function StatCard({ label, value, color }: StatCardProps) {
  const colorClasses = {
    blue: 'bg-blue-900/20 border-blue-500 text-blue-400',
    green: 'bg-green-900/20 border-green-500 text-green-400',
    orange: 'bg-orange-900/20 border-orange-500 text-orange-400',
    red: 'bg-red-900/20 border-red-500 text-red-400',
    purple: 'bg-purple-900/20 border-purple-500 text-purple-400',
  };

  return (
    <div className={`rounded-lg border p-4 ${colorClasses[color]}`}>
      <p className="text-sm opacity-80 mb-1">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}

