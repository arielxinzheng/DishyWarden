/**
 * Starlink Outage 类型定义
 * 
 * 基于 sparky8512/starlink-grpc-tools 的 outage cause 分类
 * 参考: https://github.com/sparky8512/starlink-grpc-tools
 */

/**
 * Outage 原始数据结构（来自 dishGetHistory）
 */
export interface Outage {
  /** 中断开始时间戳（毫秒级 epoch） */
  startTimestamp: number;
  /** 中断持续时长（毫秒） */
  durationMs: number;
  /** 中断原因标识符（DishyMock 字段名为 triggered，真实设备可能为 cause） */
  triggered?: string;
  cause?: string;
  /**
   * 设备自报「这次中断期间发生了卫星切换」。
   *
   * ⚠️ 真机实测会带这个布尔字段（`"didSwitch":true`），比按持续时长猜可靠得多：
   * 切换和短时遮挡在时长上完全重叠，但设备自己知道到底换没换卫星。
   */
  didSwitch?: boolean;
}

/**
 * 规整 gRPC 传过来的 outage 数值字段。
 *
 * ## 为什么需要
 *
 * protobuf 的 `int64`/`uint64` 在 JSON 序列化后是**字符串** ——
 * DishyMock 实测 `startTimestamp: "1793671076044"`, `durationMs: "2109"`。
 * 而 `Outage` 类型把它们声明成 number, 于是：
 * - `sum + h.durationMs` 变成**字符串拼接** ⇒ 平均时长算出 `3.77e+222`
 * - `durationMs <= 10000` 的比较会因字符串参与而走出错结果
 *
 * ## 为什么还要认 `*Ns` 两个字段
 *
 * 真机（192.168.100.1，2026-11 实测）发的不是 `startTimestamp`，
 * 而是 **`startTimestampNs` / `durationNs`（纳秒，字符串）**：
 *
 * ```json
 * {"cause":"NO_DOWNLINK","startTimestampNs":"1479420720000261589",
 *  "durationNs":"560167119","didSwitch":true}
 * ```
 *
 * 只认 `startTimestamp` 时这两个字段全变 0 ⇒ 时间戳 0、时长 0 ⇒
 * 事件时间落在任何查询窗口之外，仪表盘的"卫星切换"永远 0 条。
 */
export type RawOutage = Omit<Outage, 'startTimestamp' | 'durationMs'> & {
  startTimestamp?: number | string;
  durationMs?: number | string;
  /** 真机字段：开始时间（纳秒） */
  startTimestampNs?: number | string;
  /** 真机字段：持续时长（纳秒） */
  durationNs?: number | string;
};

/** 把 raw outage 规整成字段类型正确的 Outage */
export function normalizeOutage(raw: RawOutage): Outage {
  const num = (v: unknown): number => {
    if (v === undefined || v === null) return 0;
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  // 保留原始数量级（纳秒仍是纳秒），由上层 detectTimestampUnit 统一判单位
  return {
    ...raw,
    startTimestamp: num(raw.startTimestamp) || num(raw.startTimestampNs),
    durationMs: num(raw.durationMs) || num(raw.durationNs),
  };
}

/**
 * Outage 原因分类
 * 
 * 从 sparky8512 的实现中提取的主要 cause 类型：
 * - BOOTING: 启动中
 * - STOWED: 收纳状态
 * - THERMAL_SHUTDOWN: 过热关机
 * - NO_SCHEDULE: 无卫星调度
 * - NO_SATS: 无可见卫星
 * - OBSTRUCTED: 信号遮挡
 * - NO_DOWNLINK: 下行链路丢失
 * - NO_PINGS: ping 失败
 * - ACTUATOR_ACTIVITY: 电机调整中
 * - CABLE_UNPLUGGED: 电缆未插
 * - NOT_ENOUGH_POWER: 供电不足
 * - SOFTWARE_UPDATE: 软件更新中
 * - UNKNOWN: 未知原因
 */
export enum OutageCause {
  /**
   * 明确的卫星切换标识（DishyMock 发的是 HANDOFF / SWITCHING）。
   *
   * ⚠️ 之前这两个值不在枚举里 ⇒ `parseOutageCause('HANDOFF')` 落到 UNKNOWN,
   * 于是「明确切换」和「原因未知」在 UI 上无法区分。
   */
  HANDOFF = 'HANDOFF',
  SWITCHING = 'SWITCHING',
  BOOTING = 'BOOTING',
  STOWED = 'STOWED',
  THERMAL_SHUTDOWN = 'THERMAL_SHUTDOWN',
  NO_SCHEDULE = 'NO_SCHEDULE',
  NO_SATS = 'NO_SATS',
  OBSTRUCTED = 'OBSTRUCTED',
  NO_DOWNLINK = 'NO_DOWNLINK',
  NO_PINGS = 'NO_PINGS',
  ACTUATOR_ACTIVITY = 'ACTUATOR_ACTIVITY',
  CABLE_UNPLUGGED = 'CABLE_UNPLUGGED',
  NOT_ENOUGH_POWER = 'NOT_ENOUGH_POWER',
  SOFTWARE_UPDATE = 'SOFTWARE_UPDATE',
  UNKNOWN = 'UNKNOWN',
}

/**
 * 卫星切换相关的 outage cause 标识符
 * 
 * 真实设备中，卫星切换通常表现为短暂的服务中断，
 * 这些中断的 cause 字段可能包含以下特征：
 * 
 * 1. 明确标识：
 *    - "HANDOFF" / "SWITCHING" / "SATELLITE_CHANGE"
 * 
 * 2. 短时中断（< 10s）且无其他明显原因：
 *    - NO_DOWNLINK + 持续时间 2-8 秒
 *    - NO_SCHEDULE + 持续时间 < 5 秒
 *    - UNKNOWN + 持续时间 < 10 秒
 * 
 * 注：真实的 cause 字符串需要从实际设备日志中确认，
 * 这里提供启发式识别规则供初步实现。
 */
export const HANDOFF_INDICATORS = [
  'HANDOFF',
  'SWITCHING',
  'SATELLITE_CHANGE',
  'HANDOVER',
];

/**
 * 可能由卫星切换引起的隐式 cause
 */
export const IMPLICIT_HANDOFF_CAUSES = [
  OutageCause.NO_DOWNLINK,
  OutageCause.NO_SCHEDULE,
  OutageCause.UNKNOWN,
];

/**
 * 卫星切换的持续时长阈值（毫秒）
 * 
 * 根据 Starlink 用户报告，卫星切换通常在 2-8 秒内完成。
 * 超过此阈值的中断更可能是其他原因（如遮挡、无卫星覆盖）。
 */
export const HANDOFF_MAX_DURATION_MS = 10000; // 10 秒

/**
 * 判断 outage 是否为卫星切换
 * 
 * @param outage - 中断记录
 * @returns 是否为卫星切换
 */
export function isHandoffOutage(outage: Outage): boolean {
  const causeStr = outage.cause || outage.triggered || '';
  const { durationMs } = outage;

  // 0. 设备自己说这次中断换了卫星 —— 最可靠的判据，压过所有启发式
  if (outage.didSwitch === true) {
    return true;
  }

  // 1. 明确的切换标识符
  if (HANDOFF_INDICATORS.some(indicator => 
    causeStr.toUpperCase().includes(indicator)
  )) {
    return true;
  }
  
  // 2. 隐式识别：短时中断 + 可能的 cause
  if (durationMs <= HANDOFF_MAX_DURATION_MS) {
    const causeUpper = causeStr.toUpperCase();
    return IMPLICIT_HANDOFF_CAUSES.some(implicitCause => 
      causeUpper.includes(implicitCause)
    );
  }
  
  return false;
}

/**
 * 将原始 cause 字符串映射到 OutageCause 枚举
 * 
 * @param causeStr - 原始 cause 字符串
 * @returns OutageCause 枚举值
 */
export function parseOutageCause(causeStr: string): OutageCause {
  const upper = causeStr.toUpperCase();
  
  // 精确匹配
  if (upper in OutageCause) {
    return OutageCause[upper as keyof typeof OutageCause];
  }
  
  // 模糊匹配
  if (upper.includes('HANDOFF') || upper.includes('HANDOVER')) return OutageCause.HANDOFF;
  if (upper.includes('SWITCHING') || upper.includes('SATELLITE_CHANGE')) return OutageCause.SWITCHING;
  if (upper.includes('BOOT')) return OutageCause.BOOTING;
  if (upper.includes('STOW')) return OutageCause.STOWED;
  if (upper.includes('THERMAL') || upper.includes('OVERHEAT')) return OutageCause.THERMAL_SHUTDOWN;
  if (upper.includes('SCHEDULE')) return OutageCause.NO_SCHEDULE;
  if (upper.includes('SAT') && upper.includes('NO')) return OutageCause.NO_SATS;
  if (upper.includes('OBSTRUCT') || upper.includes('BLOCKED')) return OutageCause.OBSTRUCTED;
  if (upper.includes('DOWNLINK')) return OutageCause.NO_DOWNLINK;
  if (upper.includes('PING')) return OutageCause.NO_PINGS;
  if (upper.includes('ACTUATOR') || upper.includes('MOTOR')) return OutageCause.ACTUATOR_ACTIVITY;
  if (upper.includes('CABLE') || upper.includes('UNPLUG')) return OutageCause.CABLE_UNPLUGGED;
  if (upper.includes('POWER')) return OutageCause.NOT_ENOUGH_POWER;
  if (upper.includes('UPDATE') || upper.includes('UPGRADE')) return OutageCause.SOFTWARE_UPDATE;
  
  return OutageCause.UNKNOWN;
}