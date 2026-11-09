/**
 * 服务状态判定 —— **单一事实来源**
 *
 * ## 为什么单独成模块
 *
 * 「服务受限 / 未激活 / 账号暂停 / 位置异常」这几种状态被两处使用，
 * 而且两处的判据**必须严格一致**:
 *
 *   1. 各自的专属规则 (service_restricted / service_not_activated / …)
 *      → 条件成立就触发告警
 *   2. low_throughput 规则
 *      → 要**排除**这些状态，否则会把「账户被停」误报成「网速慢」
 *
 * 判据散落在两处时会出现经典黑洞: 一处认、另一处不认 ⇒
 * 既不出「服务受限」告警，也不出「速率低」告警，页面一片安静。
 * 这正是实际踩到的坑——low_throughput 的排除列表里写了
 * SERVICE_RESTRICTED，但 service_restricted 规则只看 classOfService。
 *
 * ## 字段契约
 *
 * 实测 DishyMock 的 `service_restriction` 场景，dishGetStatus 返回:
 *
 *   disablementCode: 'SERVICE_RESTRICTED'
 *   classOfService:  'RESTRICTED'
 *   alerts:          {}                 ← 空对象，不能靠它判
 *   downlinkThroughputBps: 5000000      ← 卡在 5 Mbps 阈值上
 *
 * 真实固件 / 其他 mock 可能只给其中一个字段，所以判据要覆盖全部来源。
 */

import type { TelemetryData } from './dishClient';

/**
 * `dishGetStatus.alerts` 里的布尔标志。
 *
 * ⚠️ 注意这里用的是 dish 原始字段名（camelCase 的 alert 名），
 *    不是 alert_type。历史上有过 string[] 形态，见 `hasAlert()`。
 */
export type DishAlertFlag =
  | 'thermalThrottle'
  | 'motorsStow'
  | 'isHeating'
  | 'slowEthernetSpeeds'
  | 'connectivity'
  /** 设备侧 DNS 异常（proto: `bool dns = 15`）。此前无规则消费，等于静默丢弃。 */
  | 'dns'
  | 'installPending'
  | 'movingFastInHelloMobile'
  | 'unexpectedLocation'
  | 'roaming';

/**
 * 读取 `alerts` 里的布尔标志。
 *
 * 同时兼容两种历史形态:
 *   - `{ thermalThrottle: true }`  —— dishGetStatus.alerts 对象（当前）
 *   - `['thermalThrottle']`        —— 早期 mock 的字符串数组（遗留）
 *
 * 不兼容旧形态的代价是静默失效: `alerts.includes` 在对象上是 undefined，
 * 调用即抛 TypeError，被 checkTelemetry 的 catch 吞掉，规则再也不报警。
 */
export function hasAlert(
  telemetry: Pick<TelemetryData, 'alerts'>,
  flag: DishAlertFlag
): boolean {
  const alerts = telemetry.alerts as unknown;

  if (Array.isArray(alerts)) return alerts.includes(flag);

  if (alerts && typeof alerts === 'object') {
    return (alerts as Record<string, unknown>)[flag] === true;
  }

  return false;
}

/**
 * 当前有多少条 alerts 标志为真。
 *
 * 单独抽出来的理由和 `hasAlert()` 一样：`alerts` 有对象和字符串数组两种历史形态，
 * 任何「数一数」的地方都得同时兼容。Prometheus 的 `starlink_alerts_total`
 * 之前直接写 `telemetry.alerts.length`，对象形态下是 `undefined` ⇒ 指标变 NaN。
 */
export function countActiveAlerts(telemetry: Pick<TelemetryData, 'alerts'>): number {
  const alerts = telemetry.alerts as unknown;

  if (Array.isArray(alerts)) return alerts.length;

  if (alerts && typeof alerts === 'object') {
    return Object.values(alerts as Record<string, unknown>).filter((v) => v === true).length;
  }

  return 0;
}

/** 归一化后的服务状态快照 */
export interface ServiceState {
  /** 原始字段，便于放进 evidence 供排查 */
  classOfService?: string;
  disablementCode?: string;

  /** 服务受限: 区域/套餐限制 */
  restricted: boolean;
  /** 服务未激活 */
  notActivated: boolean;
  /** 账号被暂停(欠费/违规) */
  suspended: boolean;
  /** 位置策略违规: 移动过快 / 位置与登记地不符 */
  locationViolation: boolean;

  /**
   * 任一种非正常服务状态。
   * low_throughput 用它做排除：这些状态下低速率是**结果**不是**原因**。
   */
  limited: boolean;
}

/**
 * 把一份遥测归一化成服务状态。
 *
 * 纯函数，不读时间、不读环境 —— 同一条遥测永远得到同一个结果，
 * 这样规则测试里可以直接断言。
 */
export function readServiceState(telemetry: TelemetryData): ServiceState {
  const { classOfService, disablementCode, dishIssues } = telemetry;

  const restricted =
    classOfService === 'RESTRICTED' ||
    disablementCode === 'SERVICE_RESTRICTED' ||
    (dishIssues?.some((issue) => issue.type === 'SERVICE_RESTRICTION') ?? false);

  const notActivated =
    disablementCode === 'NOT_ACTIVATED' || hasAlert(telemetry, 'installPending');

  const suspended =
    classOfService === 'SUSPENDED' || disablementCode === 'ACCOUNT_SUSPENDED';

  const locationViolation =
    hasAlert(telemetry, 'movingFastInHelloMobile') ||
    hasAlert(telemetry, 'unexpectedLocation');

  return {
    classOfService,
    disablementCode,
    restricted,
    notActivated,
    suspended,
    locationViolation,
    limited: restricted || notActivated || suspended,
  };
}