import { useDish } from '../hooks/useDish';

/**
 * 校准页面 - 显示天线 Rotation（旋转）和 Tilt（倾斜）状态
 * 使用 SVG 绘制罗盘式校准图，展示当前对齐情况
 */
export default function AlignmentPage() {
  const { telemetry, isLoading, error } = useDish();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-400">加载校准数据...</p>
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

  if (!telemetry) {
    return (
      <div className="p-8">
        <div className="bg-yellow-900/20 border border-yellow-500 rounded-lg p-4">
          <p className="text-yellow-400">暂无校准数据</p>
        </div>
      </div>
    );
  }

  // 从 telemetry 提取校准数据
  const azimuth = telemetry.boresightAzimuthDeg ?? 28.3;
  const elevation = telemetry.boresightElevationDeg ?? 76.2;
  const tiltAngle = telemetry.tiltAngleDeg ?? 76;
  const attitudeState = telemetry.attitudeEstimationState ?? 'VALID';
  const attitudeUncertainty = telemetry.alignmentStats?.attitudeUncertaintyDeg ?? 0.4;
  const isAligned = attitudeState === 'VALID' && attitudeUncertainty < 1.0;

  const rotationParams = [
    { key: 'azimuth', label: '方位角', value: `${azimuth.toFixed(1)}°`, good: true },
    { key: 'deviation', label: '偏差', value: `${attitudeUncertainty.toFixed(1)}°`, good: attitudeUncertainty < 1.0 },
    { key: 'recommended', label: '推荐范围', value: `0–40°`, good: false },
    { key: 'status', label: '状态', value: isAligned ? '已对齐' : '未对齐', good: isAligned },
  ];

  const tiltParams = [
    { key: 'elevation', label: '仰角', value: `${elevation.toFixed(1)}°`, good: true },
    { key: 'tilt', label: '倾斜角', value: `${tiltAngle.toFixed(1)}°`, good: true },
    { key: 'recommended', label: '推荐范围', value: `70–85°`, good: false },
    { key: 'status', label: '状态', value: isAligned ? '已对齐' : '未对齐', good: isAligned },
  ];

  return (
    <div className="p-8 space-y-6">
      {/* 页面标题 */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Alignment / 校准</h1>
          <p className={`flex items-center gap-2 ${isAligned ? 'text-accent' : 'text-yellow-500'}`}>
            <i className={`fa-solid ${isAligned ? 'fa-circle-check' : 'fa-triangle-exclamation'}`}></i>
            <span>
              {isAligned 
                ? '天线已正确对齐，信号质量良好' 
                : `姿态估计: ${attitudeState}, 不确定度: ${attitudeUncertainty.toFixed(1)}°`}
            </span>
          </p>
        </div>
      </div>

      {/* 两个校准圆盘 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* ROTATION 旋转 */}
        <div className="bg-gray-900 rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <span className={`w-2 h-2 rounded-full ${isAligned ? 'bg-green-500' : 'bg-yellow-500'}`}></span>
            <span className="text-xs tracking-[0.22em] text-gray-400 font-semibold">ROTATION</span>
          </div>
          <div className="flex justify-center">
            <RotationDial 
              currentAngle={azimuth}
              recommendedRange={[0, 40]}
            />
          </div>
        </div>

        {/* TILT 倾斜 */}
        <div className="bg-gray-900 rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <span className={`w-2 h-2 rounded-full ${isAligned ? 'bg-green-500' : 'bg-yellow-500'}`}></span>
            <span className="text-xs tracking-[0.22em] text-gray-400 font-semibold">TILT</span>
          </div>
          <div className="flex justify-center">
            <TiltDial 
              currentAngle={tiltAngle}
              recommendedRange={[70, 85]}
            />
          </div>
        </div>
      </div>

      {/* 参数详情 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* ROTATION 参数 */}
        <div className="bg-gray-800 rounded-xl p-6">
          <div className="text-xs tracking-[0.18em] text-gray-500 font-semibold mb-4">ROTATION</div>
          <div className="space-y-3">
            {rotationParams.map((param) => (
              <div 
                key={param.key}
                className="flex items-center justify-between py-2 border-b border-gray-700/60 text-sm"
              >
                <span className="text-gray-400 flex items-center gap-1.5">
                  {param.label}
                  <i className="fa-regular fa-circle-question text-gray-600 text-xs"></i>
                </span>
                <span 
                  className={`font-mono ${param.good ? 'text-green-500' : 'text-gray-200'}`}
                >
                  {param.value}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* TILT 参数 */}
        <div className="bg-gray-800 rounded-xl p-6">
          <div className="text-xs tracking-[0.18em] text-gray-500 font-semibold mb-4">TILT</div>
          <div className="space-y-3">
            {tiltParams.map((param) => (
              <div 
                key={param.key}
                className="flex items-center justify-between py-2 border-b border-gray-700/60 text-sm"
              >
                <span className="text-gray-400 flex items-center gap-1.5">
                  {param.label}
                  <i className="fa-regular fa-circle-question text-gray-600 text-xs"></i>
                </span>
                <span 
                  className={`font-mono ${param.good ? 'text-green-500' : 'text-gray-200'}`}
                >
                  {param.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 使用说明 */}
      <div className="rounded-xl border border-gray-700/60 bg-gray-900/50 p-6">
        <h3 className="text-white font-bold mb-2">如何读取此图</h3>
        <p className="text-sm text-gray-400 leading-relaxed">
          <strong>ROTATION（旋转）：</strong>橙色指针指向当前方位角。推荐将天线朝北（N）对齐，偏差在 ±20° 以内为最佳。
          浅色扇形区域表示推荐范围。
        </p>
        <p className="text-sm text-gray-400 leading-relaxed mt-2">
          <strong>TILT（倾斜）：</strong>橙色指针显示当前仰角。推荐仰角为 70–85°，以确保最佳卫星可见性和信号强度。
          浅色扇形区域表示推荐倾斜范围。
        </p>
      </div>
    </div>
  );
}

// ====== ROTATION 旋转罗盘 ======
interface RotationDialProps {
  currentAngle: number;
  recommendedRange: [number, number];
}

function RotationDial({ currentAngle, recommendedRange }: RotationDialProps) {
  return (
    <svg viewBox="0 0 200 200" className="w-full max-w-[280px]">
      {/* 点状刻度圆环（72 个点，每 5 度一个） */}
      {Array.from({ length: 72 }).map((_, i) => {
        const deg = i * 5;
        const rad = ((deg - 90) * Math.PI) / 180;
        const x = 100 + 78 * Math.cos(rad);
        const y = 100 + 78 * Math.sin(rad);
        return <circle key={i} cx={x} cy={y} r={1} fill="white" fillOpacity={0.5} />;
      })}

      {/* 推荐范围扇形（浅色半透明） */}
      <path
        d={`M100,100 L${100 + 86 * Math.cos(((recommendedRange[0] - 90) * Math.PI) / 180)},${
          100 + 86 * Math.sin(((recommendedRange[0] - 90) * Math.PI) / 180)
        } A86,86 0 0 1 ${100 + 86 * Math.cos(((recommendedRange[1] - 90) * Math.PI) / 180)},${
          100 + 86 * Math.sin(((recommendedRange[1] - 90) * Math.PI) / 180)
        } Z`}
        fill="white"
        fillOpacity={0.06}
      />

      {/* 罗盘方向标签 */}
      <text x="100" y="12" fill="#94a3b8" fontSize="11" textAnchor="middle" fontFamily="monospace">
        N
      </text>
      <text x="192" y="104" fill="#94a3b8" fontSize="11" textAnchor="middle" fontFamily="monospace">
        E
      </text>
      <text x="100" y="197" fill="#94a3b8" fontSize="11" textAnchor="middle" fontFamily="monospace">
        S
      </text>
      <text x="8" y="104" fill="#94a3b8" fontSize="11" textAnchor="middle" fontFamily="monospace">
        W
      </text>

      {/* 天线底座（中心偏下） */}
      <g transform="translate(100,118) rotate(-4)">
        <rect x="-26" y="-8" width="52" height="16" rx="3" fill="#e5e7eb" />
      </g>

      {/* 橙色指针（指向当前角度） */}
      <line
        x1="100"
        y1="118"
        x2={100 + 88 * Math.cos(((currentAngle - 90) * Math.PI) / 180)}
        y2={118 + 88 * Math.sin(((currentAngle - 90) * Math.PI) / 180)}
        stroke="#f97316"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle
        cx={100 + 88 * Math.cos(((currentAngle - 90) * Math.PI) / 180)}
        cy={118 + 88 * Math.sin(((currentAngle - 90) * Math.PI) / 180)}
        r="3"
        fill="#f97316"
      />
    </svg>
  );
}

// ====== TILT 倾斜罗盘 ======
interface TiltDialProps {
  currentAngle: number;
  recommendedRange: [number, number];
}

function TiltDial({ currentAngle, recommendedRange }: TiltDialProps) {
  // 倾斜角度转换为弧度（从底部水平线向上）
  const angleToArc = (angle: number) => {
    const normalized = 90 - angle; // 90度是水平，0度是垂直
    return (normalized * Math.PI) / 180;
  };

  return (
    <svg viewBox="0 0 200 200" className="w-full max-w-[280px]">
      {/* 点状弧形刻度（右侧，0-90度） */}
      {Array.from({ length: 40 }).map((_, i) => {
        const angle = -i * 2.2;
        const rad = (angle * Math.PI) / 180;
        const x = 40 + 130 * Math.cos(rad);
        const y = 170 + 130 * Math.sin(rad);
        return <circle key={i} cx={x} cy={y} r={1} fill="white" fillOpacity={0.5} />;
      })}

      {/* 推荐倾斜范围扇形 */}
      <path
        d={`M40,170 L${40 + 130 * Math.cos(angleToArc(recommendedRange[1]))},${
          170 + 130 * Math.sin(angleToArc(recommendedRange[1]))
        } A130,130 0 0 0 ${40 + 130 * Math.cos(angleToArc(recommendedRange[0]))},${
          170 + 130 * Math.sin(angleToArc(recommendedRange[0]))
        } Z`}
        fill="white"
        fillOpacity={0.06}
      />

      {/* 天线底座（左下角） */}
      <rect x="20" y="164" width="46" height="12" rx="2" fill="#e5e7eb" />

      {/* 橙色倾斜指针 */}
      <line
        x1="43"
        y1="170"
        x2={43 + 130 * Math.cos(angleToArc(currentAngle))}
        y2={170 + 130 * Math.sin(angleToArc(currentAngle))}
        stroke="#f97316"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle
        cx={43 + 130 * Math.cos(angleToArc(currentAngle))}
        cy={170 + 130 * Math.sin(angleToArc(currentAngle))}
        r="3"
        fill="#f97316"
      />

      {/* 角度标注 */}
      <text x="150" y="150" fill="#94a3b8" fontSize="10" textAnchor="middle" fontFamily="monospace">
        {currentAngle}°
      </text>
    </svg>
  );
}