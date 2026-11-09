import { Trans, useTranslation } from 'react-i18next';
import { useDish } from '../hooks/useDish';
import { AlignmentFlash } from '../components/Alignment/AlignmentFlash';
import { GaugeDial } from '../components/Alignment/GaugeDial';
import { describeAttitudeState, type AttitudeTone } from '../components/Alignment/attitudeState';
import {
  attitudeDetail,
  attitudeLabel,
  verdictDetail,
  verdictHeadline,
} from '../components/Alignment/guidanceText';
import {
  DEFAULT_TOLERANCE_DEG,
  elevationModel,
  judgeAlignment,
  rotationModel,
} from '../components/Alignment/alignmentGuidance';
import { formatDeg, formatSignedDeg } from '../components/Alignment/format';
import { LanguageSwitcher } from '../components/LanguageSwitcher';

/**
 * 校准页面。
 *
 * 这个组件只负责取数与排版，「差多少度 / 算不算对齐 / 该说什么话」全部
 * 委托给 Alignment/ 下的纯模块（attitudeState / alignmentGuidance）——
 * 前者只出语义码，guidanceText 负责把语义码翻成当前语言。
 * 之前这些判断直接写在 JSX 里，方位角和仰角各写一份，两盘能给出矛盾结论。
 */

const TONE_TEXT: Record<AttitudeTone, string> = {
  ok: 'text-green-500',
  warn: 'text-yellow-500',
  bad: 'text-red-500',
  unknown: 'text-gray-400',
};

const TONE_DOT: Record<AttitudeTone, string> = {
  ok: 'bg-green-500',
  warn: 'bg-yellow-500',
  bad: 'bg-red-500',
  unknown: 'bg-gray-500',
};

export default function AlignmentPage() {
  const { t } = useTranslation('alignment');
  const { telemetry, isLoading, error } = useDish();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-400">{t('alignment:page.loading')}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="bg-red-900/20 border border-red-500 rounded-lg p-4">
          <p className="text-red-400">{t('alignment:page.load_failed', { error })}</p>
        </div>
      </div>
    );
  }

  if (!telemetry) {
    return (
      <div className="p-8">
        <div className="bg-yellow-900/20 border border-yellow-500 rounded-lg p-4">
          <p className="text-yellow-400">{t('alignment:page.no_data')}</p>
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
  const attitudeView = describeAttitudeState(
    telemetry.attitudeEstimationState,
    stats?.attitudeUncertaintyDeg
  );
  const rotation = rotationModel(azimuth, desiredAzimuth);
  const tilt = elevationModel(elevation, desiredElevation);
  const verdict = judgeAlignment(attitudeView.converged, rotation, tilt);

  const attitudeText = attitudeLabel(attitudeView);
  const attitudeSubText = attitudeDetail(attitudeView);

  const tolerance = DEFAULT_TOLERANCE_DEG;
  // 设备没上报期望值时盘上没有带，说明文案也不能再承诺「扇带」
  const hasBand = rotation.hasBand || tilt.hasBand;
  const rotationBand =
    rotation.bandLowDeg === null || rotation.bandHighDeg === null
      ? '—'
      : `${formatDeg(rotation.bandLowDeg)}–${formatDeg(rotation.bandHighDeg)}`;
  const tiltBand =
    tilt.bandLowDeg === null || tilt.bandHighDeg === null
      ? '—'
      : `${formatDeg(tilt.bandLowDeg)}–${formatDeg(tilt.bandHighDeg)}`;

  return (
    <div className="p-8 space-y-6">
      {/* 标题 + 人话状态 + 「刚对齐」正反馈。Flash 是 flex 兄弟节点，
          摆在标题行右侧，不悬浮、不覆盖任何内容。 */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">{t('alignment:page.title')}</h1>
          <p className={`flex items-center gap-2 font-medium ${TONE_TEXT[attitudeView.tone]}`}>
            <span>{attitudeView.icon}</span>
            <span>{attitudeText}</span>
          </p>
          <p className="text-xs text-gray-500 mt-1">{attitudeSubText}</p>
        </div>
        <div className="flex items-center gap-3">
          {/* 全局语言切换（需求指定的「右上角」位置） */}
          <LanguageSwitcher variant="label" />
          <AlignmentFlash aligned={verdict.aligned} />
        </div>
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
          {verdictHeadline(verdict)}
        </div>
        <div className="text-sm text-gray-400 mt-1">{verdictDetail(verdict)}</div>
      </div>

      {/* 两个校准盘 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <DialCard
          title="ROTATION"
          subtitle={t('alignment:page.subtitle_rotation')}
          dotClass={rotation.inBand ? TONE_DOT.ok : TONE_DOT.warn}
          dial={
            <GaugeDial
              variant="compass"
              model={rotation}
              ariaLabel={t('alignment:page.aria_rotation_dial')}
            />
          }
        />
        <DialCard
          title="TILT"
          subtitle={t('alignment:page.subtitle_tilt')}
          dotClass={tilt.inBand ? TONE_DOT.ok : TONE_DOT.warn}
          dial={
            <GaugeDial
              variant="elevation"
              model={tilt}
              ariaLabel={t('alignment:page.aria_tilt_dial')}
            />
          }
        />
      </div>

      {/* 参数明细 —— 所有角度统一经过 formatDeg（一位小数） */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <ParamCard
          title="ROTATION"
          rows={[
            { label: t('alignment:param.current_azimuth'), value: formatDeg(azimuth) },
            { label: t('alignment:param.desired_azimuth'), value: formatDeg(desiredAzimuth) },
            {
              label: t('alignment:param.deviation'),
              value: formatSignedDeg(rotation.deltaDeg),
              tone: rotation.inBand ? 'good' : 'warn',
            },
            { label: t('alignment:param.recommended_range'), value: rotationBand },
          ]}
        />
        <ParamCard
          title="TILT"
          rows={[
            { label: t('alignment:param.current_elevation'), value: formatDeg(elevation) },
            { label: t('alignment:param.desired_elevation'), value: formatDeg(desiredElevation) },
            {
              label: t('alignment:param.deviation'),
              value: formatSignedDeg(tilt.deltaDeg),
              tone: tilt.inBand ? 'good' : 'warn',
            },
            { label: t('alignment:param.recommended_range'), value: tiltBand },
            { label: t('alignment:param.physical_tilt'), value: formatDeg(telemetry.tiltAngleDeg) },
          ]}
        />
      </div>

      {/* 使用说明 */}
      <div className="rounded-xl border border-gray-700/60 bg-gray-900/50 p-6 space-y-3">
        <h3 className="text-white font-bold">{t('alignment:usage.title')}</h3>

        <p className="text-sm text-gray-400 leading-relaxed">
          <Trans
            i18nKey="alignment:usage.band_desc"
            values={{ tol: formatDeg(tolerance), total: formatDeg(tolerance * 2) }}
            components={{
              arc: <strong className="text-gray-300" />,
              band: <strong className="text-gray-300" />,
            }}
          />
          {hasBand ? (
            t('alignment:usage.band_in_band')
          ) : (
            t('alignment:usage.band_no_band')
          )}
        </p>

        {/* 图例：光靠文字说「灰色/绿色」不如直接摆两个色块 */}
        <div className="flex flex-wrap items-center gap-5 pt-1">
          <LegendSwatch
            color="rgba(148, 163, 184, 0.22)"
            border="rgba(203, 213, 225, 0.55)"
            label={t('alignment:legend.out_of_band')}
          />
          <LegendSwatch
            color="rgba(34, 197, 94, 0.34)"
            border="rgba(74, 222, 128, 0.85)"
            label={t('alignment:legend.in_band')}
          />
          <LegendSwatch color="#f97316" label={t('alignment:legend.pointer')} />
        </div>

        <p className="text-sm text-gray-400 leading-relaxed">
          <Trans
            i18nKey="alignment:usage.pointer"
            components={{ strong: <strong className="text-gray-300" /> }}
          />
        </p>
        <p className="text-sm text-gray-400 leading-relaxed">
          <Trans
            i18nKey="alignment:usage.tilt"
            components={{ strong: <strong className="text-gray-300" /> }}
          />
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
