import { useDish } from '../hooks/useDish';
import { AlignmentFlash } from '../components/Alignment/AlignmentFlash';
import { GaugeDial } from '../components/Alignment/GaugeDial';
import { describeAttitudeState, type AttitudeTone } from '../components/Alignment/attitudeState';
import {
  DEFAULT_TOLERANCE_DEG,
  elevationModel,
  judgeAlignment,
  rotationModel,
} from '../components/Alignment/alignmentGuidance';
import { formatDeg, formatSignedDeg, normalizeAzimuth } from '../components/Alignment/format';

/**
 * 校准页面。
 *
 * 这个组件只负责取数与排版，「差多少度 / 算不算对齐 / 该说什么话」全部
 * 委托给 Alignment/ 下的三个纯模块（attitudeState / alignmentGuidance / format）。
 * 之前这些判断直接写在 JSX 里，方位角和仰角各写一份，两盘能给出矛盾结论。
 */

const TONE_TEXT: Record<AttitudeTone, string> = {
  ok: 'text-green-500',
  warn: 'text-yellow-500',
  bad: 'text-red-500',
  neutral: 'text-gray-400',
};

const TONE_DOT: Record<AttitudeTone, string> = {
  ok: 'bg-green-500',
  warn: 'bg-yellow-500',
  bad: 'bg-red-500',
  neutral: 'bg-gray-500',
};

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

  const stats = telemetry.alignmentStats;
  const azimuth = telemetry.boresightAzimuthDeg;
  const elevation = telemetry.boresightElevationDeg;
  const desiredAzimuth = stats?.desiredBoresightAzimuthDeg;
  const desiredElevation = stats?.desiredBoresightElevationDeg;

  // 三个纯函数决定页面上所有结论，视图不再自己判读
  const attitude = describeAttitudeState(telemetry.attitudeEstimationState, stats?.attitudeUncertaintyDeg);
  const rotation = rotationModel(azimuth, desiredAzimuth);
  const tilt = elevationModel(elevation, desiredElevation);
  const verdict = judgeAlignment(attitude.converged, rotation, tilt);

  const tolerance = DEFAULT_TOLERANCE_DEG;
  // 设备没上报期望值时盘上没有带，说明文案也不能再承诺「扇带」
  const hasBand = rotation.hasBand || tilt.hasBand;
  const rotationBand =
    desiredAzimuth === undefined
      ? '—'
      : `${formatDeg(normalizeAzimuth(desiredAzimuth - tolerance))}–${formatDeg(
          normalizeAzimuth(desiredAzimuth + tolerance)
        )}`;
  const tiltBand =
    desiredElevation === undefined
      ? '—'
      : `${formatDeg(desiredElevation - tolerance)}–${formatDeg(desiredElevation + tolerance)}`;

  return (
    <div className="p-8 space-y-6">
      {/* 标题 + 人话状态 + 「刚对齐」正反馈。Flash 是 flex 兄弟节点，
          摆在标题行右侧，不悬浮、不覆盖任何内容。 */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Alignment / 校准</h1>
          <p className={`flex items-center gap-2 font-medium ${TONE_TEXT[attitude.tone]}`}>
            <span>{attitude.icon}</span>
            <span>{attitude.label}</span>
          </p>
          <p className="text-xs text-gray-500 mt-1">{attitude.detail}</p>
        </div>
        <AlignmentFlash aligned={verdict.aligned} />
      </div>

      {/* 综合结论 */}
      <div
        className={`rounded-xl border p-5 transition-colors duration-300 ${
          verdict.aligned
            ? 'border-green-500/60 bg-green-500/10'
            : 'border-gray-700/60 bg-gray-900/60'
        }`}
      >
        <div
          className={`text-xl font-bold ${
            verdict.aligned ? 'text-green-400' : 'text-gray-100'
          }`}
        >
          {verdict.headline}
        </div>
        <div className="text-sm text-gray-400 mt-1">{verdict.detail}</div>
      </div>

      {/* 两个校准盘 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <DialCard
          title="ROTATION"
          subtitle="方位角"
          dotClass={rotation.inBand ? TONE_DOT.ok : TONE_DOT.warn}
          dial={<GaugeDial variant="compass" model={rotation} ariaLabel="方位角校准盘" />}
        />
        <DialCard
          title="TILT"
          subtitle="仰角"
          dotClass={tilt.inBand ? TONE_DOT.ok : TONE_DOT.warn}
          dial={<GaugeDial variant="elevation" model={tilt} ariaLabel="仰角校准盘" />}
        />
      </div>

      {/* 参数明细 —— 所有角度统一经过 formatDeg（一位小数） */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <ParamCard
          title="ROTATION"
          rows={[
            { label: '当前方位角', value: formatDeg(azimuth) },
            { label: '期望方位角', value: formatDeg(desiredAzimuth) },
            { label: '偏差', value: formatSignedDeg(rotation.deltaDeg), tone: rotation.inBand ? 'good' : 'warn' },
            { label: '推荐范围', value: rotationBand },
          ]}
        />
        <ParamCard
          title="TILT"
          rows={[
            { label: '当前仰角', value: formatDeg(elevation) },
            { label: '期望仰角', value: formatDeg(desiredElevation) },
            { label: '偏差', value: formatSignedDeg(tilt.deltaDeg), tone: tilt.inBand ? 'good' : 'warn' },
            { label: '推荐范围', value: tiltBand },
            { label: '终端物理倾斜角', value: formatDeg(telemetry.tiltAngleDeg) },
          ]}
        />
      </div>

      {/* 使用说明 */}
      <div className="rounded-xl border border-gray-700/60 bg-gray-900/50 p-6 space-y-3">
        <h3 className="text-white font-bold">如何读取此图</h3>

        <p className="text-sm text-gray-400 leading-relaxed">
          <strong className="text-gray-300">外圈亮弧</strong>标出推荐范围的位置（推荐 = 期望值 ±{' '}
          {formatDeg(tolerance)}，即总共 {formatDeg(tolerance * 2)} 宽）。
          <strong className="text-gray-300">内圈扇带</strong>就是推荐范围本身：
          {hasBand ? (
            <>
              灰色表示还没进带，<span className="text-green-400">绿色</span>表示已进带。
            </>
          ) : (
            <>设备未上报期望值，本页不画推荐范围。</>
          )}
        </p>

        {/* 图例：光靠文字说「灰色/绿色」不如直接摆两个色块 */}
        <div className="flex flex-wrap items-center gap-5 pt-1">
          <LegendSwatch color="rgba(148, 163, 184, 0.22)" border="rgba(203, 213, 225, 0.55)" label="还没进带" />
          <LegendSwatch color="rgba(34, 197, 94, 0.34)" border="rgba(74, 222, 128, 0.85)" label="已进带" />
          <LegendSwatch color="#f97316" label="橙色指针 = 当前实际指向" />
        </div>

        <p className="text-sm text-gray-400 leading-relaxed">
          <strong className="text-gray-300">橙色指针</strong>是设备当前实际指向。
          进带后指针变绿，盘心会直接告诉你「还需向东旋转多少度」「还需抬高多少度」；
          环外的小三角指示转动方向。
        </p>
        <p className="text-sm text-gray-400 leading-relaxed">
          <strong className="text-gray-300">TILT 盘的指针取波束仰角</strong>，与设备给出的期望仰角同坐标系；
          底部「终端物理倾斜角」是另一个量，两者相差一个固定安装偏移，仅供参考。
        </p>
      </div>
    </div>
  );
}

// ====== 排版零件 ======

interface DialCardProps {
  title: string;
  subtitle: string;
  dotClass: string;
  dial: React.ReactNode;
}

function DialCard({ title, subtitle, dotClass, dial }: DialCardProps) {
  return (
    <div className="bg-gray-900 rounded-xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <span className={`w-2 h-2 rounded-full ${dotClass}`}></span>
        <span className="text-xs tracking-[0.22em] text-gray-400 font-semibold">{title}</span>
        <span className="text-xs text-gray-600">{subtitle}</span>
      </div>
      <div className="flex justify-center">{dial}</div>
    </div>
  );
}

interface ParamRow {
  label: string;
  value: string;
  tone?: 'good' | 'warn';
}

function ParamCard({ title, rows }: { title: string; rows: ParamRow[] }) {
  return (
    <div className="bg-gray-800 rounded-xl p-6">
      <div className="text-xs tracking-[0.18em] text-gray-500 font-semibold mb-4">{title}</div>
      <div className="space-y-3">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between py-2 border-b border-gray-700/60 text-sm"
          >
            <span className="text-gray-400">{row.label}</span>
            <span
              className={`font-mono ${
                row.tone === 'good'
                  ? 'text-green-500'
                  : row.tone === 'warn'
                    ? 'text-yellow-500'
                    : 'text-gray-200'
              }`}
            >
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 图例色块。
 *
 * 为什么要有图例：盘面上的扇带只有 10° 宽，文字描述「灰色 / 绿色」对
 * 第一次打开这页的人几乎没有指向性 —— 直接把两种颜色摆出来更直观。
 */
function LegendSwatch({
  color,
  border,
  label,
}: {
  color: string;
  border?: string;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-gray-400">
      <span
        className="inline-block w-5 h-3 rounded-sm"
        style={{ background: color, border: border ? `1px solid ${border}` : undefined }}
      />
      {label}
    </span>
  );
}