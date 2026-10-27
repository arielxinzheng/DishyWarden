/**
 * 服务卫星估算
 *
 * ## 为什么需要估算
 *
 * dish 的 gRPC 协议里**没有 `satelliteId` 字段**（DishyMock proto 明确注明
 * 「state 枚举被测方全程不读」，satelliteId 同理），所以拿不到设备上报的
 * 服务卫星 ID。
 *
 * 但 dish 给了**波束指向**：`boresightAzimuthDeg` / `boresightElevationDeg`。
 * 这正是 SatelliteTracker 一类工具反推服务卫星的依据 —— 把波束方向与
 * 候选卫星的观测角比对，取角距离最小者。
 *
 * ## 为什么不能只按仰角排
 *
 * 实测 (8604 颗种子, 北京, epoch 时刻):
 *   仰角第 1 名 67.63° / az 13.12°
 *   仰角第 3 名 65.00° / az 238.56°   ← 正南方, 与波束毫无关系
 *   仰角第 1 与第 10 名仰角仅差 14.42°, 角距离却有 59.1°
 *
 * Starlink 密度极高，仰角排序在这种情况下基本是噪声。
 *
 * ## 置信度怎么定
 *
 * Starlink 相邻卫星角间距中位数约 2.18°（实测），所以：
 *   - 最优与次优差距大 → 最优那颗很可能就是服务卫星
 *   - 差距小 → 多颗候选都可能是，结论不可靠
 *
 * 另外单帧不可靠，要靠**时间连续性**：dish 每 ~15s 交接一次卫星，
 * 服务卫星在交接之间位置连续。用 `previousSatelliteId` 做连续性加权。
 */

import {
  calculateAngularSeparation,
  type SatellitePosition,
} from './satelliteCalculator';

/** dish 报告的波束指向 */
export interface Boresight {
  azimuthDeg: number;
  elevationDeg: number;
}

/** 估算置信度 */
export type EstimateConfidence = 'high' | 'medium' | 'low' | 'none';

export interface ServingSatelliteEstimate {
  /** 估算出的服务卫星; confidence === 'none' 时为 null */
  satellite: SatellitePosition | null;
  confidence: EstimateConfidence;
  /** 与最优候选的角距离(度) */
  separationDeg: number;
  /** 与次优候选的角距离(度); 无次优时为 null */
  runnerUpSeparationDeg: number | null;
  /** 最优与次优的差距(度); 越大越可信 */
  marginDeg: number | null;
  /** 3° 内的候选数; 1 表示唯一解 */
  candidatesWithin3Deg: number;
  /** 人类可读的原因 */
  reason: string;
}

/**
 * 贴合度阈值: 最优候选离波束不超过这么多度就算"波束指着它"。
 *
 * 实测(星历准确时)该值为 0.000°；星历陈旧 50 天时约 1.7-2.2°。
 * 取 2.5° 覆盖陈旧误差，再由排他性与连续性进一步区分。
 */
const TIGHT_FIT_DEG = 2.5;
/**
 * 判为 high 的最小排他间隔。
 *
 * 实测 408 颗可见星时，真卫星当波束的次优间隔是 0.74°–6.72°，
 * 中位约 2.2°。所以 5° 是"明显领先"的分界 —— 远大于中位数，
 * 又不至于要求到几乎独占（真实场景下 6.7° 的次优也算合理领先）。
 */
const HIGH_MARGIN_DEG = 5;
/** 判为 medium 的最小排他间隔 */
const MEDIUM_MARGIN_DEG = 1.5;
/** 统计候选的角距阈值 */
const CANDIDATE_WINDOW_DEG = 3;
/**
 * 地面距离上限(km) —— 超过就不是 Starlink 了。
 *
 * 实测: 正常 Starlink 地面距离 440–2411km;
 * 星历陈旧时 SGP4 会算出 150636km / 20076020km 这种解轨残留。
 */
export const MAX_PLAUSIBLE_RANGE_KM = 3000;

/**
 * 估算当前服务卫星。
 *
 * @param visible    地平线以上的候选卫星
 * @param boresight  dish 报告的波束指向
 * @param previousId 上一帧的估算结果; 用于时间连续性判断
 */
export function estimateServingSatellite(
  visible: SatellitePosition[],
  boresight: Boresight | null,
  previousId?: string | null
): ServingSatelliteEstimate {
  if (!boresight || visible.length === 0) {
    return {
      satellite: null,
      confidence: 'none',
      separationDeg: Number.NaN,
      runnerUpSeparationDeg: null,
      marginDeg: null,
      candidatesWithin3Deg: 0,
      reason: !boresight
        ? '设备未上报波束指向，无法估算服务卫星'
        : '当前视野内没有可见卫星',
    };
  }

  // **剔除传播异常值**。
  //
  // 星历陈旧时 SGP4 会算出荒谬的距离（实测见过 150636 km、20076020 km，
  // 而 Starlink 地面距离正常是 440–2411 km）。这些是轨道已经解体的残留，
  // 不是真实卫星 —— 而且因为仰角算得"正常"，有可能被选成服务卫星。
  //
  // 判据: 地面距离 > 3000km 的不是 Starlink。
  const candidates = visible.filter((s) => s.range <= MAX_PLAUSIBLE_RANGE_KM);
  if (candidates.length === 0) {
    return {
      satellite: null,
      confidence: 'none',
      separationDeg: Number.NaN,
      runnerUpSeparationDeg: null,
      marginDeg: null,
      candidatesWithin3Deg: 0,
      reason: '所有候选卫星的轨道距离异常，可能是星历数据有问题',
    };
  }

  // 把波束当成一颗"虚拟卫星"参与角距离计算
  const boresightAsSatellite: SatellitePosition = {
    name: '__boresight__',
    noradId: '__boresight__',
    azimuth: boresight.azimuthDeg,
    elevation: boresight.elevationDeg,
    range: 0,
    velocity: 0,
    latitude: 0,
    longitude: 0,
    altitude: 0,
  };

  const ranked = candidates
    .map((sat) => ({
      sat,
      sep: calculateAngularSeparation(sat, boresightAsSatellite),
    }))
    .sort((a, b) => a.sep - b.sep);

  const best = ranked[0];
  const runnerUp = ranked[1] ?? null;
  const margin = runnerUp ? runnerUp.sep - best.sep : null;
  const candidatesWithin3 = ranked.filter((r) => r.sep <= CANDIDATE_WINDOW_DEG).length;

  // 时间连续性: 上一帧的估算还在候选里, 说明波束没跳变, 结论更稳
  const continuous = previousId
    ? ranked.some((r) => r.sat.noradId === previousId && r.sep <= CANDIDATE_WINDOW_DEG)
    : false;

  let confidence: EstimateConfidence;
  let reason: string;

  // **贴合度**与**排他性**是两件事:
  //   贴合度 = 最优候选离波束多近（波束基本指着它 → 贴合度高）
  //   排他性 = 其它候选离得多远（次优离得远 → 排他性强）
  //
  // 次优紧贴最优不代表估算错 —— Starlink 密度高时两颗星可以挨得很近。
  // 但那意味着**单帧无法区分**，此时靠时间连续性判断。
  const tightFit = best.sep <= TIGHT_FIT_DEG;

  if (tightFit && (margin === null || margin >= HIGH_MARGIN_DEG)) {
    // 波束明确指着某颗，且没有同样贴近的竞争者
    confidence = 'high';
    reason = margin === null
      ? `波束指向与该候选相差 ${best.sep.toFixed(2)}°，且无其他竞争者`
      : `波束指向与该候选相差 ${best.sep.toFixed(2)}°，次优落后 ${margin.toFixed(1)}°`;
  } else if (tightFit && continuous) {
    // 贴合但有竞争者 —— 位置连续性提供额外支撑
    confidence = 'medium';
    reason = `波束指向与该候选相差 ${best.sep.toFixed(2)}°，虽有相邻候选（差 ${margin?.toFixed(1) ?? '0'}°），但与上一帧一致`;
  } else if (tightFit) {
    confidence = 'medium';
    reason = `波束指向与该候选相差 ${best.sep.toFixed(2)}°，但相邻候选仅差 ${margin?.toFixed(1) ?? '0'}°，单帧无法区分`;
  } else if (margin !== null && margin >= HIGH_MARGIN_DEG) {
    // 不贴近但排他性强 —— 通常意味着星历陈旧导致整体偏移
    confidence = 'low';
    reason = `最优候选领先次优 ${margin.toFixed(1)}°，但与波束相差 ${best.sep.toFixed(2)}°，疑似星历陈旧`;
  } else if (margin !== null && margin >= MEDIUM_MARGIN_DEG) {
    confidence = 'low';
    reason = `最优候选领先次优 ${margin.toFixed(1)}°，但与波束相差 ${best.sep.toFixed(2)}°，存在偏差`;
  } else if (continuous) {
    confidence = 'low';
    reason = `相邻候选间隔小（${margin?.toFixed(1) ?? '0'}°），且与波束相差 ${best.sep.toFixed(2)}°，无法可靠区分`;
  } else {
    confidence = 'low';
    reason = `相邻候选间隔仅 ${margin?.toFixed(1) ?? '0'}°，无法可靠区分`;
  }

  if (candidatesWithin3 === 0) {
    // 波束指向 3° 内没有卫星 —— 星历陈旧或位置设置有误。
    // 说明里带上实际最近距离, 否则「3° 内没有卫星」听起来像"差很远",
    // 而实际可能只差 3.06°。
    confidence = 'low';
    reason =
      `波束指向 ${boresight.azimuthDeg.toFixed(1)}°/${boresight.elevationDeg.toFixed(1)}° ` +
      `最近的候选在 ${best.sep.toFixed(2)}° 外（超出 3° 匹配窗口），` +
      `可能是星历陈旧或位置设置有误`;
  }

  return {
    satellite: best.sat,
    confidence,
    separationDeg: best.sep,
    runnerUpSeparationDeg: runnerUp ? runnerUp.sep : null,
    marginDeg: margin,
    candidatesWithin3Deg: candidatesWithin3,
    reason,
  };
}

/**
 * 是否是 DTC(Direct-to-Cell) 卫星。
 *
 * DTC 是给**手机直连**用的，不承载固定宽带终端的连接 —— 估算服务卫星时
 * 必须排除，否则会选到一颗根本不可能服务 dish 的星。
 *
 * 判据（按可靠性排序）:
 *   1. CelesTrak 的名称标记 `STARLINK-XXXXX [DTC]` —— 最直接
 *   2. 轨道高度 —— DTC 用 v2 mini 壳层，约 360km，与正常 Starlink 的
 *      500-550km 分离干净（实测 DTC 群 350-375km，正常星 >=406km）
 *
 * 注意: **倾角不能用来区分** —— DTC 的 53°/43° 与普通 Starlink 完全重叠。
 */
export function isDirectToCellSatellite(tle: { name: string; line1: string; line2: string }): boolean {
  // 1. 名称标记
  if (/\[DTC\]/i.test(tle.name)) return true;

  // 2. 高度判据 —— 从 line2 解析
  //    line2 布局: cols 8-16 倾角, 52-63 平运动 (no_kozai)
  const noStr = tle.line2?.slice(52, 63);
  if (!noStr) return false;
  const no = Number(noStr);
  if (!Number.isFinite(no) || no <= 0) return false;

  // 半长轴 a = (mu / n^2)^(1/3),  n = no * 2pi / 86400
  const n = no * (2 * Math.PI) / 86400.0;
  const a = Math.pow(398600.4418 / (n * n), 1 / 3);
  const altitudeKm = a - 6371.0;

  // DTC 壳层在 350-375km；用 400km 阈值留出余量
  // (实测高轨组最低 406km，误判率 0%)
  return altitudeKm < 400;
}

/** 过滤掉 DTC 卫星 */
export function excludeDirectToCellSatellites<T extends { name: string; line1: string; line2: string }>(
  tles: T[]
): T[] {
  return tles.filter((tle) => !isDirectToCellSatellite(tle));
}
