import { useDish } from '../hooks/useDish';
import { useMemo } from 'react';
import { ObstructionHemisphere } from '../components/Dashboard/ObstructionHemisphere';
import {
  analyzeObstructionMap,
  assessObstructionImpact,
  describeObstructionAge,
} from '../lib/obstructionAnalysis';

/**
 * 障碍图页面
 * 显示星链天线视野中的障碍物分布
 * 123x123 网格，使用 Canvas 渲染热力图
 */
export default function ObstructionMap() {
  const { telemetry, isLoading, error, obstruction } = useDish();

  // 优先用主进程存的实测遮挡图, 拿不到才降级到遥测里带的
  // 注意: 两者都可能是模拟数据, 所以 source 必须跟着走 —— 不能假定是真实
  const mapData = obstruction?.data ?? telemetry?.obstructionMap ?? null;
  const isReal = obstruction?.source === 'real';
  // 遥测里带的图没有独立来源标记, 保守当作 mock
  const source: 'real' | 'mock' = obstruction ? (obstruction.source === 'real' ? 'real' : 'mock') : 'mock';

  // 计算障碍统计信息
  const stats = useMemo(() => {
    if (!mapData) return null;
    return analyzeObstructionMap(mapData);
  }, [mapData]);

  const impact = stats ? assessObstructionImpact(stats.obstructionPercentage) : null;
  const ageText = obstruction ? describeObstructionAge(obstruction.timestamp) : null;

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

  if (!mapData) {
    return (
      <div className="p-8">
        <div className="bg-yellow-900/20 border border-yellow-500 rounded-lg p-4">
          <p className="text-yellow-400">暂无障碍图数据</p>
          <p className="text-gray-400 text-sm mt-2">
            设备尚未返回视野遮挡图。恢复连接后会自动显示。
          </p>
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

      {/* 数据来源与新鲜度 —— 模拟图和实测图视觉几乎一样, 必须标出来 */}
      <div className={`rounded-lg border px-4 py-3 text-sm ${
        isReal
          ? 'border-green-500/40 bg-green-900/20 text-green-300'
          : 'border-yellow-500/40 bg-yellow-900/20 text-yellow-300'
      }`}>
        {source === 'real' ? (
          <>设备实测遮挡图{ageText ? ` · ${ageText}` : ''}</>
        ) : (
          <>当前显示模拟数据（非设备实测）。设备返回遮挡图后会自动切换。</>
        )}
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
            value={`${(stats.obstructionPercentage * 100).toFixed(2)}%`}
            color={stats.obstructionPercentage > 0.10 ? 'red' : 'green'}
          />
          <StatCard
            label="最大障碍值"
            value={stats.maxObstruction.toString()}
            color="purple"
          />
        </div>
      )}

      {/* 方向与影响 —— 只在真实数据上给 */}
      {stats && source === 'real' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <StatCard
            label="主遮挡方向"
            value={stats.dominantDirection ?? '无明显遮挡'}
            color="blue"
          />
          <StatCard
            label="影响评估"
            value={impact?.label ?? '—'}
            color={impact?.color === 'text-danger-red' ? 'red' : impact?.color === 'text-warning-orange' ? 'orange' : 'green'}
          />
        </div>
      )}

      {/* 障碍图可视化 */}
      <div className="bg-gray-800 rounded-lg overflow-hidden flex justify-center py-6">
        <ObstructionHemisphere
          data={mapData}
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

