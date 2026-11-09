/**
 * 校准页的「语义码 → 人话」适配层。
 *
 * ## 为什么单独一层
 *
 * `alignmentGuidance.ts` / `attitudeState.ts` 是纯逻辑，只出语义码；
 * 文案必须集中在**唯一**的地方拼装，否则同一个「向东旋转 15°」会在
 * 圆心引导牌、综合结论、参数表里各写一遍，切语言时必然漏掉一处。
 *
 * 本模块是渲染层的一部分：直接取 i18n 实例的当前语言。
 * 由于调用它的组件（GaugeDial / AlignmentPage）都通过 useTranslation 订阅了
 * 语言变化，`languageChanged` 时它们会重渲染，从而这里取到新语言。
 */

import i18n from '../../i18n';
import { formatDeg } from './format';
import type {
  AlignmentVerdict,
  DialModel,
  GuidanceAction,
  GuidanceDirection,
} from './alignmentGuidance';
import type { AttitudeStateCode, AttitudeStateView } from './attitudeState';

/** 姿态状态的 label 文案键（静态写出，便于键校验测试扫到） */
const ATT_LABEL_KEYS: Record<AttitudeStateCode, string> = {
  converged: 'alignment:att.converged_label',
  convergence_warning: 'alignment:att.convergence_warning_label',
  initializing: 'alignment:att.initializing_label',
  reset: 'alignment:att.reset_label',
  invalid: 'alignment:att.invalid_label',
  unreported: 'alignment:att.unreported_label',
  unknown: 'alignment:att.unknown_label',
};

/** 姿态状态的 detail 文案键 */
const ATT_DETAIL_KEYS: Record<AttitudeStateCode, string> = {
  converged: 'alignment:att.converged_detail',
  convergence_warning: 'alignment:att.convergence_warning_detail',
  initializing: 'alignment:att.initializing_detail',
  reset: 'alignment:att.reset_detail',
  invalid: 'alignment:att.invalid_detail',
  unreported: 'alignment:att.unreported_detail',
  unknown: 'alignment:att.unknown_detail',
};

/** 综合结论的主文案键 */
const VERDICT_HEADLINE_KEYS: Record<AlignmentVerdict['code'], string> = {
  calibrating: 'alignment:verdict.calibrating',
  missing_expected: 'alignment:verdict.missing_expected',
  aligned: 'alignment:verdict.aligned',
  almost: 'alignment:verdict.almost',
};

/** 综合结论的副文案键（`almost` 由 pending 动作拼出来，不在表里） */
const VERDICT_DETAIL_KEYS: Record<AlignmentVerdict['code'], string> = {
  calibrating: 'alignment:verdict.calibrating_detail',
  missing_expected: 'alignment:verdict.missing_expected_detail',
  aligned: 'alignment:verdict.aligned_detail',
  almost: 'alignment:verdict.almost',
};

/**
 * 「要往哪转、转多少」→ 当前语言的短句。
 *
 * cw = 罗盘角增大 = 方位角上「向东」；ccw = 罗盘角减小 = 「向西」。
 * 仰角盘不区分东西，只说抬高/降低。
 */
export function moveText(
  action: GuidanceAction,
  direction: GuidanceDirection,
  adjustDeg: number | null
): string {
  const deg = formatDeg(adjustDeg ?? 0);
  switch (action) {
    case 'rotate':
      return i18n.t(
        direction === 'ccw' ? 'alignment:guidance.rotate_west' : 'alignment:guidance.rotate_east',
        { deg }
      );
    case 'raise':
      return i18n.t('alignment:guidance.raise', { deg });
    case 'lower':
      return i18n.t('alignment:guidance.lower', { deg });
    case 'aligned':
      return i18n.t('alignment:guidance.aligned');
    case 'no_expected':
      return i18n.t('alignment:guidance.no_expected');
  }
}

/** 圆心引导牌主文案：「向东旋转 15.0°」/「已对齐」/「无期望值」 */
export function dialHintMain(model: DialModel): string {
  return moveText(model.action, model.direction, model.adjustDeg);
}

/** 圆心引导牌副文案：「推荐 23.0°–33.0°」/ 没期望值时的原因 */
export function dialHintSub(model: DialModel): string {
  if (model.hasBand && model.bandLowDeg !== null && model.bandHighDeg !== null) {
    return i18n.t('alignment:guidance.recommended', {
      low: formatDeg(model.bandLowDeg),
      high: formatDeg(model.bandHighDeg),
    });
  }
  return i18n.t(
    model.kind === 'elevation'
      ? 'alignment:guidance.no_expected_band_tilt'
      : 'alignment:guidance.no_expected_band'
  );
}

/** 校准盘的无障碍描述：`方位角校准盘：向东旋转 20.0°，推荐 25.0°–35.0°` */
export function dialAriaLabel(name: string, model: DialModel): string {
  return i18n.t('alignment:dial.aria', {
    name,
    main: dialHintMain(model),
    sub: dialHintSub(model),
  });
}

/** 姿态状态主文案（含设备给出的精度括号，没给就不加） */
export function attitudeLabel(view: AttitudeStateView): string {
  const label = i18n.t(
    ATT_LABEL_KEYS[view.state],
    view.state === 'unknown' ? { state: view.rawState ?? '' } : undefined
  );
  if (view.uncertaintyDeg === undefined) return label;
  return label + i18n.t('alignment:att.precision_note', { deg: formatDeg(view.uncertaintyDeg) });
}

/** 姿态状态补充说明 */
export function attitudeDetail(view: AttitudeStateView): string {
  return i18n.t(ATT_DETAIL_KEYS[view.state]);
}

/** 顶部横幅主文案 */
export function verdictHeadline(verdict: AlignmentVerdict): string {
  return i18n.t(VERDICT_HEADLINE_KEYS[verdict.code]);
}

/** 顶部横幅副文案：`almost` 时把两个盘还差的动作拼起来（用 · 分隔） */
export function verdictDetail(verdict: AlignmentVerdict): string {
  if (verdict.code !== 'almost') return i18n.t(VERDICT_DETAIL_KEYS[verdict.code]);
  return verdict.pending
    .map((item) => moveText(item.action, item.direction, item.adjustDeg))
    .join(' · ');
}
