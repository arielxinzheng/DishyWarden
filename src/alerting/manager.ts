/**
 * 告警管理器
 * 整合告警检测、去重、通知
 */

import { EventEmitter } from 'events';
import { AlertDatabase, type AlertRecord } from './database';
import { Notifier, type NotificationConfig, type NotificationContext } from './notifier';
import { AlertDispatcher } from './dispatcher';
import { resolveNetworkPath, type NetworkPath } from './networkPath';
import { defaultAlertLabel } from './offlineQueue';
import type { TelemetryData } from '../core/dishClient';
import { hasAlert, readServiceState } from '../core/serviceState';
import type { AlertThresholds } from '../config/manager';

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  severity: 'critical' | 'warning' | 'info';
  condition: (telemetry: TelemetryData) => boolean;
  summary: (telemetry: TelemetryData) => string;
  description: (telemetry: TelemetryData) => string;
  evidence: (telemetry: TelemetryData) => Record<string, unknown>;
  recommendations: string[];
  /**
   * 这条规则的**生命周期由谁管理**。
   *
   * - `'telemetry'`(默认)—— 由 `checkTelemetry()` 负责:
   *   condition 为真则触发, 为假则自动 resolve。
   * - `'outages'` —— 由 `checkOutages()` 独立负责。
   *   `checkTelemetry()` **完全跳过**这条规则(不触发也不 resolve)。
   *
   * ## 为什么需要这个标记
   *
   * 遥测驱动的规则, condition 恒为 false 时走 else 分支自动 resolve ——
   * 这是合理的(条件不成立了嘛)。
   *
   * 但**非遥测驱动**的规则(如 `no_satellite_schedule`,
   * 它的数据源是 `dishGetHistory` 的 outages, 不是遥测样本)
   * 如果也走这条路径, 就会出现:
   *
   *   t+0ms   checkTelemetry  ⇒ condition=false ⇒ **resolve**
   *   t+2s    checkOutages    ⇒ 有 NO_SCHEDULE ⇒ **重新置回 ongoing**
   *
   * ⇒ 告警每 30 秒闪一下就消失, 历史记录里全是短命的告警。
   *
   * 这正是踩过的坑(见 DEVELOPMENT-STATUS.md 踩坑备忘)。
   */
  managedBy?: 'telemetry' | 'outages';
}

/**
 * Outage 告警的「新鲜度窗口」。
 *
 * `dishGetHistory` 返回的是**滑动窗口**里的历史中断（DishyMock 15 分钟，
 * 真实设备类似）。窗口里存在一条旧中断，不等于此刻仍在中断。
 *
 * 不筛新鲜度的后果：几分钟前就结束的一次调度失败会被反复读出来，
 * 用户看到的是「什么都没发生却冒出容量不足告警」，而对应的中断在
 * 设备侧早就翻篇了。
 *
 * 取 2 分钟 = 4 个采集周期（采集间隔 30s），足够容错又不至于翻旧账。
 */
const OUTAGE_FRESH_WINDOW_MS = 2 * 60_000;

/** 断线重连判定窗口：10 分钟内的时间窗 */
const LINK_FLIP_WINDOW_MS = 10 * 60_000;
/** 窗口内 ONLINE ↔ 非 ONLINE 翻转达到该次数 ⇒ 判为频繁断线重连 */
const LINK_FLIP_THRESHOLD = 3;
/** 连续卡在 SEARCHING 超过该时长 ⇒ 同样判为「持续搜星连不上」 */
const SEARCHING_STUCK_MS = 10 * 60_000;
/** 路由器数量变化的统计窗口 */
const ROUTER_FLAP_WINDOW_MS = 10 * 60_000;
/** 窗口内「已连接路由器数量」变化达到该次数 ⇒ 判为反复掉线 */
const ROUTER_FLAP_THRESHOLD = 3;
/** 静默期：稳定该时长后撤警（与 frequent_searching 同一思路） */
const ROUTER_FLAP_QUIET_MS = 5 * 60_000;
/**
 * 静默期：最后一次翻转之后稳定该时长，就认为「不再频繁重连」，告警应当恢复。
 *
 * 为什么不能只靠 10 分钟计数窗口：窗口内的翻转会一直留在数组里，
 * 于是链路稳定之后告警还要**挂满 10 分钟**才消失。用户看到的画面是
 * 「顶部状态已是 ONLINE、图表也平稳，但告警还在」—— 这和之前那个
 * 「设备恢复了告警不消失」的观感是同一类问题。
 * 所以判定 = 窗口内有足够翻转 **且** 最近一次翻转足够新。
 */
const LINK_FLIP_QUIET_MS = 5 * 60_000;

export class AlertManager extends EventEmitter {
  private db: AlertDatabase;
  /** 告警分发器（内网直发 / 公网预检 / 离线暂存 / 恢复补发） */
  private dispatcher: AlertDispatcher;
  /** 上一次判定的外网路径 —— 用来发现「无外网 → 有外网」的恢复瞬间 */
  private lastNetworkPath: NetworkPath = 'starlink';
  /** 星链终端当前是否在线（用于识别多 WAN / 5G 备线） */
  private starlinkOnline: boolean = true;
  private notifier: Notifier;
  private rules: Map<string, AlertRule> = new Map();
  private checkInterval?: NodeJS.Timeout;
  private heartbeatInterval?: NodeJS.Timeout;
  /** 离线队列定时清理（已冲刷记录的兜底回收） */
  private offlineQueueCleanupInterval?: NodeJS.Timeout;
  private thresholds: AlertThresholds;
  private lastCollectorSuccess: Date | null = null;
  private heartbeatStartTime: Date = new Date(); // 心跳检查启动时间
  // DNS 探针状态追踪（连续失败计数）
  private dnsProbeFailures: Map<string, number> = new Map();
  private dnsProbeLastResults: Map<string, any> = new Map();
  // 用于依赖压制判断的 ICMP 探针状态
  private icmpProbeStates: Map<string, { reachable: boolean; consecutiveFailures: number }> = new Map();

  /**
   * 连接状态历史 —— 供 `frequent_searching`（频繁断线重连）使用。
   *
   * 规则只能拿到**单帧** telemetry，而"频繁重连"本质是**跨帧**现象：
   * 一帧 SEARCHING 可能只是正常切换，十帧里反复 ONLINE→SEARCHING→ONLINE
   * 才是问题。所以计数必须由管理器自己维护，规则只做查询。
   */
  private lastLinkState: TelemetryData['state'] | null = null;
  /** 最近窗口内 ONLINE ↔ 非 ONLINE 的翻转时刻（epoch ms） */
  private linkFlips: number[] = [];
  /** 进入 SEARCHING 的时刻；null = 当前不在搜星 */
  private searchingSince: number | null = null;
  /** 「已连接路由器数量」的变化时刻（epoch ms），供 router_flapping 规则跨帧统计 */
  private routerCountChanges: number[] = [];
  private lastRouterCount: number | null = null;

  constructor(notificationConfig: NotificationConfig, thresholds: AlertThresholds, dbPath?: string) {
    super();
    this.db = new AlertDatabase(dbPath);

    // 启动自检：数据库连接刚建立，先清掉上次进程意外退出可能残留的
    // 已冲刷队列行（补发成功但没来得及清理的那些）。
    this.runOfflineQueueCleanup();

    this.notifier = new Notifier(notificationConfig);
    this.dispatcher = new AlertDispatcher({
      notifier: this.notifier,
      db: this.db,
      currentPath: () => this.currentNetworkPath(),
      labelOf: (alertType) => this.ruleTitleFor(alertType) ?? defaultAlertLabel(alertType),
    });
    this.thresholds = thresholds;
    this.initializeDefaultRules();
  }

  /**
   * 初始化默认告警规则
   */
  private initializeDefaultRules(): void {
    const rules: AlertRule[] = [
      // 设备离线
      {
        id: 'dish_offline',
        name: '天线设备离线',
        enabled: true,
        severity: 'critical',
        // ⚠️ 只认 OFFLINE。旧判据是 `state !== 'ONLINE'`，把 BOOTING(刚开机)
        // 和 SEARCHING(正在锁星) 也当成「天线未连接」并升级成 critical ——
        // 这两者都是正常过程；SEARCHING 另有 frequent_searching 规则负责，
        // 两条同时报等于同一件事报警两遍。
        condition: (data) => data.state === 'OFFLINE',
        summary: () => 'Starlink 天线未连接',
        description: (data) => `天线状态: ${data.state}，设备在线但未对外提供服务`,
        evidence: (data) => ({
          state: data.state,
          uptime_seconds: data.uptime || 0,
        }),
        recommendations: [
          '检查天线电源和网线连接',
          '确认 gRPC 端口 9200 可访问',
          '等待天线搜索卫星(正常需要 5-10 分钟)',
        ],
      },

      // 高延迟
      {
        id: 'high_latency',
        name: 'PoP 延迟过高',
        enabled: true,
        severity: 'warning',
        condition: (data) => (data.popPingLatencyMs || 0) > this.thresholds.highLatencyMs,
        summary: (data) => `PoP 延迟 ${data.popPingLatencyMs?.toFixed(1)}ms`,
        description: () => 'Starlink 骨干网络延迟异常',
        evidence: (data) => ({
          pop_latency_ms: data.popPingLatencyMs,
          pop_drop_rate: data.popPingDropRate,
        }),
        recommendations: [
          '持续监控,延迟可能随卫星切换恢复',
          '如持续高延迟,可能是区域网络拥塞',
        ],
      },

      // 高丢包
      {
        id: 'high_packet_loss',
        name: '严重丢包',
        enabled: true,
        severity: 'critical',
        condition: (data) => (data.popPingDropRate || 0) > this.thresholds.highPacketLoss,
        summary: (data) => `丢包率 ${((data.popPingDropRate || 0) * 100).toFixed(1)}%`,
        description: () => 'Starlink 网络丢包严重',
        evidence: (data) => ({
          pop_drop_rate: data.popPingDropRate,
          pop_latency_ms: data.popPingLatencyMs,
        }),
        recommendations: [
          '检查天线遮挡情况',
          '等待网络恢复或联系 Starlink 客服',
        ],
      },

      // 遮挡告警
      {
        id: 'obstruction_detected',
        name: '天线视野遮挡',
        enabled: true,
        severity: 'warning',
        condition: (data) => data.currentlyObstructed || false,
        summary: () => '检测到天线遮挡',
        description: (data) =>
          `累计遮挡率: ${((data.fractionObstructed || 0) * 100).toFixed(1)}%, 影响网络性能`,
        evidence: (data) => ({
          obstructed: data.currentlyObstructed,
          obstruction_percentage: data.fractionObstructed,
        }),
        recommendations: [
          '检查天线周围是否有新增遮挡物(树木、建筑)',
          '考虑调整天线安装位置或角度',
          '修剪遮挡的树枝',
        ],
      },

      // 热降频
      {
        id: 'thermal_throttle',
        name: '天线过热降频',
        enabled: true,
        severity: 'warning',
        condition: (data) => hasAlert(data, 'thermalThrottle') || false,
        summary: () => '天线温度过高,已启动降频保护',
        description: (data) => {
          const temp = data.dishTemperature?.toFixed(1) || 'N/A';
          return `当前温度: ${temp}°C, 高温导致性能下降`;
        },
        evidence: (data) => ({
          thermal_throttle: hasAlert(data, 'thermalThrottle'),
          dish_temperature: data.dishTemperature,
          psu_temperature: data.powerSupplyTemperature,
        }),
        recommendations: [
          '改善天线通风散热条件',
          '避免阳光直射',
          '检查天线安装环境温度',
          '降频保护会自动解除, 等待温度下降',
        ],
      },

      // 对准异常
      {
        id: 'alignment_issue',
        name: '天线对准异常',
        enabled: true,
        severity: 'warning',
        condition: (data) => {
          // 姿态估计状态不是已收敛
          const notConverged = data.attitudeEstimationState && 
            data.attitudeEstimationState !== 'FILTER_CONVERGED';
          // 或姿态不确定度过高 (>3度)
          const highUncertainty = (data.alignmentStats?.attitudeUncertaintyDeg || 0) > 3;
          return notConverged || highUncertainty;
        },
        summary: (data) => {
          const state = data.attitudeEstimationState || '未知';
          const uncertainty = data.alignmentStats?.attitudeUncertaintyDeg?.toFixed(1) || 'N/A';
          return `天线对准异常 (状态: ${state}, 不确定度: ${uncertainty}°)`;
        },
        description: (data) => {
          const azimuth = data.boresightAzimuthDeg?.toFixed(1) || 'N/A';
          const elevation = data.boresightElevationDeg?.toFixed(1) || 'N/A';
          // 期望朝向可能「设备没上报」（值为 undefined），不能只判断
          // alignmentStats 对象是否存在 —— 那会让文案变成「期望 undefined°」。
          const desiredAz = data.alignmentStats?.desiredBoresightAzimuthDeg;
          const desiredEl = data.alignmentStats?.desiredBoresightElevationDeg;
          const desired =
            desiredAz !== undefined || desiredEl !== undefined
              ? `期望 ${desiredAz?.toFixed(1) ?? 'N/A'}° / ${desiredEl?.toFixed(1) ?? 'N/A'}°`
              : '';
          return `当前指向: 方位角 ${azimuth}°, 仰角 ${elevation}° ${desired}`;
        },
        evidence: (data) => ({
          attitude_estimation_state: data.attitudeEstimationState,
          attitude_uncertainty_deg: data.alignmentStats?.attitudeUncertaintyDeg,
          boresight_azimuth: data.boresightAzimuthDeg,
          boresight_elevation: data.boresightElevationDeg,
          desired_azimuth: data.alignmentStats?.desiredBoresightAzimuthDeg,
          desired_elevation: data.alignmentStats?.desiredBoresightElevationDeg,
          tilt_angle: data.tiltAngleDeg,
        }),
        recommendations: [
          '检查天线是否被外力移动或倾斜',
          '确认安装底座稳固, 无松动',
          '等待系统自动重新校准 (通常 10-30 分钟)',
          '如持续无法收敛, 考虑重启设备',
        ],
      },

      // 电机卡死/收起
      {
        id: 'motors_stowed',
        name: '天线电机异常',
        enabled: true,
        severity: 'critical',
        condition: (data) => hasAlert(data, 'motorsStow') || false,
        summary: () => '天线电机收起或卡死',
        description: (data) => {
          const isHeating = hasAlert(data, 'isHeating');
          return isHeating 
            ? '检测到电机异常, 系统正在加热解冻' 
            : '天线电机无法正常工作, 可能被手动收起或因结冰卡死';
        },
        evidence: (data) => ({
          motors_stow: hasAlert(data, 'motorsStow'),
          is_heating: hasAlert(data, 'isHeating'),
          dish_temperature: data.dishTemperature,
          all_alerts: data.alerts,
        }),
        recommendations: [
          '检查是否手动收起了天线',
          '寒冷环境下可能因结冰卡死, 系统会自动加热',
          '等待加热完成 (通常 15-30 分钟)',
          '如非寒冷环境, 可能是电机硬件故障, 联系售后',
        ],
      },

      // GNSS 定位异常
      {
        id: 'gnss_positioning',
        name: 'GNSS 定位异常',
        enabled: true,
        severity: 'warning',
        condition: (data) => {
          // GPS 定位无效或可见卫星数量过少
          const noFix = data.gpsValid === false;
          const fewSats = (data.gpsSats ?? 0) < 4; // GPS 定位至少需要 4 颗卫星
          return noFix || fewSats;
        },
        summary: (data) => {
          const sats = data.gpsSats ?? 0;
          return `GNSS 定位异常 (${sats} 颗卫星, ${data.gpsValid ? '有效' : '无效'})`;
        },
        description: (data) => {
          const state = data.gpsConvergenceState || '未知';
          return `PNT 滤波器状态: ${state}, GPS 可能影响位置服务`;
        },
        evidence: (data) => ({
          gps_valid: data.gpsValid,
          gps_sats: data.gpsSats,
          convergence_state: data.gpsConvergenceState,
          satellite_id: data.satelliteId,
        }),
        recommendations: [
          '确认天线视野开阔, 无建筑物遮挡天顶',
          'GPS 需要看到天空, 室内或密闭环境无法定位',
          '初次启动或长时间断电后, GPS 冷启动需要 5-15 分钟',
          '如持续无法定位, 可能是 GPS 模块硬件故障',
        ],
      },

      // 结冰加热
      {
        id: 'dish_heating',
        name: '天线结冰加热中',
        enabled: true,
        severity: 'warning',
        condition: (data) => hasAlert(data, 'isHeating') || false,
        summary: () => '天线检测到结冰, 正在自动加热',
        description: (data) => `当前温度: ${data.dishTemperature?.toFixed(1)}°C, 系统正在除冰`,
        evidence: (data) => ({
          is_heating: hasAlert(data, 'isHeating'),
          dish_temperature: data.dishTemperature,
          motors_stow: hasAlert(data, 'motorsStow'),
        }),
        recommendations: [
          '系统自动加热除冰中, 通常 15-30 分钟内完成',
          '结冰期间可能影响连接质量',
          '如频繁结冰, 考虑改善安装位置或增加遮蔽',
        ],
      },

      // 以太网速率异常
      {
        id: 'slow_ethernet',
        name: '以太网速率异常',
        enabled: true,
        severity: 'warning',
        condition: (data) => {
          // 检测到 slowEthernetSpeeds 告警，或实测速率 < 500 Mbps
          const flagged = hasAlert(data, 'slowEthernetSpeeds');
          const lowSpeed = (data.ethSpeedMbps ?? 0) > 0 && (data.ethSpeedMbps ?? 0) < 500;
          return flagged || lowSpeed;
        },
        summary: (data) => {
          const speed = data.ethSpeedMbps;
          return speed ? `以太网协商速率 ${speed} Mbps` : '以太网速率异常';
        },
        description: (data) => {
          const duplex = data.ethDuplex || '未知';
          const downMbps = ((data.downlinkThroughputBps || 0) / 1024 / 1024).toFixed(1);
          return `双工模式: ${duplex}, 实际下行: ${downMbps} Mbps`;
        },
        evidence: (data) => ({
          eth_speed_mbps: data.ethSpeedMbps,
          eth_duplex: data.ethDuplex,
          downlink_mbps: (data.downlinkThroughputBps || 0) / 1024 / 1024,
          slow_ethernet_alert: hasAlert(data, 'slowEthernetSpeeds'),
        }),
        recommendations: [
          '检查网线是否为 Cat5e/Cat6 千兆网线',
          '确认路由器端口支持千兆速率',
          '尝试更换网线或网口',
          '检查网线是否过长或受损',
          '部分老旧设备可能只支持百兆',
        ],
      },

      // 线缆连接异常
      {
        id: 'cable_connectivity',
        name: '线缆连接异常',
        enabled: true,
        severity: 'critical',
        condition: (data) => hasAlert(data, 'connectivity') || false,
        summary: () => '天线到路由器链路不稳定',
        description: () => 'PoE 线缆连接异常，链路间歇中断',
        evidence: (data) => ({
          connectivity_alert: hasAlert(data, 'connectivity'),
          state: data.state,
          uptime_s: data.uptime,
          latency_ms: data.popPingLatencyMs,
        }),
        recommendations: [
          '检查 PoE 线缆是否松动或接触不良',
          '确认线缆两端插头是否牢固',
          '检查线缆是否有物理损坏（折断、破皮等）',
          '尝试更换 PoE 网线',
          '检查 PoE 供电设备是否正常',
          '线缆过长（>100米）可能导致信号衰减',
        ],
      },

      // DNS 解析异常（设备侧上报的 alerts.dns）
      {
        id: 'dns_resolution',
        name: 'DNS 解析异常',
        enabled: true,
        severity: 'warning',
        // 设备自己把 DNS 标志位置起来了。proto 里 `bool dns = 15` 是一等字段，
        // 但此前**没有任何规则消费它** —— 设备报了等于白报。
        // 归属说明：DNS 异常通常是「本机/路由器 DNS 配置」或「运营商 DNS 故障」，
        // 所以按 warning 而非 critical；真断网由 cable_connectivity / router_offline 负责。
        condition: (data) => hasAlert(data, 'dns') || false,
        summary: () => '设备报告 DNS 解析异常',
        description: (data) =>
          `天线侧 DNS 标志位已置起（alerts.dns），当前状态 ${data.state}，延迟 ${Math.round(data.popPingLatencyMs || 0)}ms`,
        evidence: (data) => ({
          dns_alert: hasAlert(data, 'dns'),
          state: data.state,
          latency_ms: data.popPingLatencyMs,
        }),
        recommendations: [
          '检查路由器 / 本机的 DNS 设置是否被改过或失效',
          '尝试把 DNS 手动改为 8.8.8.8 或 1.1.1.1',
          '确认代理 / VPN 客户端没有接管 DNS（fake-ip 模式下会出现解析异常）',
          '重启路由器与天线，排除缓存异常',
        ],
      },

      // 本地路由器反复掉线（跨帧判据）
      {
        id: 'router_flapping',
        name: '路由器反复掉线',
        enabled: true,
        severity: 'warning',
        // 「已连接路由器数量」在窗口内反复变化 ⇒ 有路由器（或下游设备）在
        // 反复上下线。`router_offline` 只看"数量为 0"那种彻底断开，抓不到
        // 这种"掉一下又回来"的抖动 —— 而它恰恰是网线/PoE/供电不稳的典型征兆。
        condition: () => {
          const now = Date.now();
          const changes = this.recentRouterCountChanges(now);
          if (changes.length < ROUTER_FLAP_THRESHOLD) return false;
          const last = changes[changes.length - 1]!;
          // 静默期：稳定一段时间就撤警，避免"已经好了但告警还挂着"
          return now - last <= ROUTER_FLAP_QUIET_MS;
        },
        summary: () => {
          const n = this.recentRouterCountChanges().length;
          return `本地路由器反复上下线（近 ${Math.round(ROUTER_FLAP_WINDOW_MS / 60000)} 分钟 ${n} 次）`;
        },
        description: () =>
          '已连接路由器数量反复变化，说明有路由器或下游设备在反复断开重连，通常指向网线 / PoE / 供电不稳',
        evidence: (data) => ({
          connected_router_count: data.connectedRouterCount,
          // 变化次数要进 evidence —— 渲染层要用它做插值（"变化 {{count}} 次"）
          change_count: this.recentRouterCountChanges().length,
          state: data.state,
          uptime_s: data.uptime,
        }),
        recommendations: [
          '检查天线到路由器之间的 PoE 网线是否松动',
          '确认路由器供电与 PoE 协商速率是否稳定',
          '检查路由器固件与过热情况',
          '若只有无线客户端在掉线，检查 WiFi 覆盖与漫游策略',
        ],
      },

      // 低吞吐量
      {
        id: 'low_throughput',
        name: '网络速率过低',
        enabled: true,
        severity: 'warning',
        condition: (data) => {
          // 服务受限 / 未激活 / 账号暂停时，低速率是**结果**不是**原因** ——
          // 交给各自的专属规则报，这里再报一次只是噪音。
          // 判据来自 readServiceState()，与专属规则共用同一份，避免
          // "一处排除、一处不认" 造成两边都不报的黑洞。
          if (readServiceState(data).limited) return false;

          // 在线状态下, 下行速率 < 5 Mbps 视为异常
          return data.state === 'ONLINE' && (data.downlinkThroughputBps || 0) < 5 * 1024 * 1024;
        },
        summary: (data) => {
          const downMbps = ((data.downlinkThroughputBps || 0) / 1024 / 1024).toFixed(1);
          return `下行速率仅 ${downMbps} Mbps`;
        },
        description: () => '网络吞吐量显著低于正常水平',
        evidence: (data) => ({
          downlink_mbps: (data.downlinkThroughputBps || 0) / 1024 / 1024,
          uplink_mbps: (data.uplinkThroughputBps || 0) / 1024 / 1024,
          pop_latency_ms: data.popPingLatencyMs,
          obstructed: data.currentlyObstructed,
          snr: data.snr,
        }),
        recommendations: [
          '检查是否有遮挡影响信号质量',
          '查看是否有设备占用大量带宽',
          '可能是区域性网络拥塞, 高峰时段常见',
          '检查天线指向是否偏移',
        ],
      },

      // SNR 过低
      {
        id: 'low_snr',
        name: '信噪比过低',
        enabled: true,
        severity: 'warning',
        condition: (data) => {
          // SNR < 5 dB 视为信号质量差
          return data.state === 'ONLINE' && (data.snr || 0) < 5;
        },
        summary: (data) => `信噪比 ${data.snr?.toFixed(1)} dB, 低于正常范围`,
        description: () => '卫星信号质量较差, 可能影响连接稳定性',
        evidence: (data) => ({
          snr: data.snr,
          satellite_id: data.satelliteId,
          pop_drop_rate: data.popPingDropRate,
          obstructed: data.currentlyObstructed,
          fraction_obstructed: data.fractionObstructed,
        }),
        recommendations: [
          '检查天线周围是否有新增遮挡',
          '恶劣天气(暴雨/暴雪)会影响信号',
          '等待卫星切换, SNR 可能自动改善',
          '如持续低 SNR, 考虑调整天线位置',
        ],
      },

      // 恶劣天气
      {
        id: 'severe_weather',
        name: '恶劣天气影响',
        enabled: true,
        severity: 'warning',
        condition: (data) => {
          // 排除明显的断连/启动状态 - 这些不是天气问题
          //
          // 这里只在 TelemetryData['state'] 实际可能的取值上判断。
          // 曾经的 `=== 'STOWED'` 是死条件（联合类型里没有 STOWED，TS 直接报
          // TS2367），而且也没必要：天线收起后没有下行链路，状态会先落到
          // SEARCHING/离线，末尾的 `data.state === 'ONLINE'` 已经把它挡在外面。
          if (data.state === 'SEARCHING' || 
              data.state === 'BOOTING' || 
              data.state === 'OFFLINE') {
            return false;
          }

          // 排除极端情况：100% 丢包通常是断线，不是天气
          // 天气影响一般是部分丢包（20-80%）
          const dropRate = data.popPingDropRate || 0;
          if (dropRate >= 0.95) {
            return false;
          }

          // 判断逻辑：中高丢包 + 低SNR + 无明显遮挡 = 很可能是天气因素
          const moderateDropRate = dropRate > 0.10 && dropRate < 0.95; // 10-95% 丢包
          const lowSnr = (data.snr || 0) < 15; // SNR < 15 dB（考虑遮挡图基线值）
          const notObstructed = !data.currentlyObstructed && (data.fractionObstructed || 0) < 0.05; // 遮挡率 < 5%
          
          // 同时满足三个条件才判定为天气影响
          return data.state === 'ONLINE' && moderateDropRate && lowSnr && notObstructed;
        },
        summary: (data) => {
          const dropRate = ((data.popPingDropRate || 0) * 100).toFixed(1);
          const snr = data.snr?.toFixed(1);
          return `恶劣天气影响信号 (丢包 ${dropRate}%, SNR ${snr} dB)`;
        },
        description: () => 
          '暴雨、暴雪等恶劣天气会严重衰减卫星信号, 这是正常的物理现象',
        evidence: (data) => ({
          pop_drop_rate: data.popPingDropRate,
          snr: data.snr,
          obstructed: data.currentlyObstructed,
          fraction_obstructed: data.fractionObstructed,
          pop_latency_ms: data.popPingLatencyMs,
          downlink_mbps: (data.downlinkThroughputBps || 0) / 1024 / 1024,
        }),
        recommendations: [
          '恶劣天气(暴雨/暴雪/雷暴)是造成信号衰减的主要原因',
          '这是正常现象, 天气好转后信号会自动恢复',
          '可以通过天气预报了解恢复时间',
          '如天气正常仍有此告警, 请检查天线安装位置',
        ],
      },

      // 设备高温
      {
        id: 'high_temperature',
        name: '设备温度过高',
        enabled: true,
        severity: 'warning',
        condition: (data) => {
          // 天线温度 > 70°C 或电源温度 > 80°C
          const highDishTemp = (data.dishTemperature || 0) > 70;
          const highPsuTemp = (data.powerSupplyTemperature || 0) > 80;
          return highDishTemp || highPsuTemp;
        },
        summary: (data) => {
          const dishTemp = data.dishTemperature?.toFixed(1);
          const psuTemp = data.powerSupplyTemperature?.toFixed(1);
          return `设备温度: 天线 ${dishTemp}°C, 电源 ${psuTemp}°C`;
        },
        description: () => '设备温度超出正常范围, 可能触发保护性降频',
        evidence: (data) => ({
          dish_temperature: data.dishTemperature,
          psu_temperature: data.powerSupplyTemperature,
          thermal_throttle: hasAlert(data, 'thermalThrottle'),
        }),
        recommendations: [
          '改善设备通风散热条件',
          '避免阳光直射',
          '检查安装环境温度',
          '如已触发热降频, 性能会下降直到温度降低',
        ],
      },

      // PoE/电源异常
      {
        id: 'poe_power',
        name: 'PoE/电源异常',
        enabled: true,
        severity: 'critical',
        condition: (data) => {
          // 检测设备异常重启：uptime < 60秒 且 state 为 ONLINE/SEARCHING
          // (排除正常的初次启动 BOOTING 状态)
          const suspiciousReboot = (data.uptime || 0) < 60 && 
            (data.state === 'ONLINE' || data.state === 'SEARCHING');
          return suspiciousReboot;
        },
        summary: (data) => `设备运行时间异常 (${data.uptime}秒)`,
        description: () => 
          'PoE 供电不稳定或电源异常，设备可能发生意外重启',
        evidence: (data) => ({
          uptime_seconds: data.uptime,
          state: data.state,
          dish_temperature: data.dishTemperature,
          psu_temperature: data.powerSupplyTemperature,
        }),
        recommendations: [
          '检查 PoE 线缆连接是否牢固',
          '确认 PoE 供电设备(交换机/注入器)工作正常',
          '检查电源电压是否稳定 (标准 48V PoE)',
          '排查是否有供电中断或电压波动',
          '检查线缆是否过长导致压降过大',
          '如频繁重启，考虑更换 PoE 供电设备',
        ],
      },

      // 路由器异常
      {
        id: 'router_offline',
        name: '路由器离线',
        enabled: true,
        severity: 'critical',
        condition: (data) => {
          // 检测路由器断开：已连接路由器数量为 0 且设备在线
          const noRouter = (data.connectedRouterCount ?? 0) === 0;
          const dishOnline = data.state === 'ONLINE' || data.state === 'SEARCHING';
          return noRouter && dishOnline;
        },
        summary: () => '路由器断开连接',
        description: (data) => 
          `天线正常工作，但未检测到已连接的路由器 (当前 ${data.connectedRouterCount ?? 0} 台)`,
        evidence: (data) => ({
          connected_router_count: data.connectedRouterCount,
          state: data.state,
          uptime_seconds: data.uptime,
          eth_speed_mbps: data.ethSpeedMbps,
        }),
        recommendations: [
          '检查路由器电源是否正常',
          '确认天线到路由器的网线连接牢固',
          '检查路由器是否重启或死机',
          '验证路由器 LAN 口是否工作正常',
          '尝试重启路由器',
          '检查路由器管理页面是否可访问',
        ],
      },

      // 频繁搜星 (通过 state 切换判断)
      {
        id: 'frequent_searching',
        name: '频繁断线重连',
        enabled: true,
        severity: 'warning',
        // 跨帧判据，数据来自 AlertManager 自己维护的状态历史：
        //   1) 10 分钟内 ONLINE ↔ 非 ONLINE 反复翻转 ≥3 次 ⇒ 断线重连
        //   2) 连续卡在 SEARCHING ≥10 分钟 ⇒ 一直连不上
        // 旧实现用 `state === 'SEARCHING' && uptime > 600` —— 那是"设备开机超过
        // 10 分钟"而不是"卡了 10 分钟"，刚开机正常锁星的用户会被误报；
        // 而且只看单帧，真正的频繁重连（帧与帧之间反复横跳）根本抓不到。
        condition: () => {
          const now = Date.now();

          // 判据一：窗口内翻转够多，且最近还在翻（稳定 LINK_FLIP_QUIET_MS 就撤）
          const flips = this.recentLinkFlips(now);
          const lastFlip = this.linkFlips.length > 0
            ? this.linkFlips[this.linkFlips.length - 1]
            : null;
          if (
            flips >= LINK_FLIP_THRESHOLD &&
            lastFlip !== null &&
            now - lastFlip <= LINK_FLIP_QUIET_MS
          ) {
            return true;
          }

          // 判据二：一直卡在搜星
          return this.searchingSince !== null && now - this.searchingSince >= SEARCHING_STUCK_MS;
        },
        summary: () => {
          const flips = this.recentLinkFlips();
          if (flips >= LINK_FLIP_THRESHOLD) return `近 10 分钟断线重连 ${flips} 次`;
          return '天线持续搜索卫星, 无法建立稳定连接';
        },
        description: () => {
          const flips = this.recentLinkFlips();
          if (flips >= LINK_FLIP_THRESHOLD) {
            return `近 10 分钟内连接状态在 ONLINE / 非 ONLINE 之间切换 ${flips} 次`;
          }
          return '已连续 10 分钟以上停留在搜索卫星状态, 未能建立稳定连接';
        },
        evidence: (data) => ({
          state: data.state,
          uptime_seconds: data.uptime,
          satellite_id: data.satelliteId,
          obstructed: data.currentlyObstructed,
          fraction_obstructed: data.fractionObstructed,
          // 翻转次数同理，供前端插值
          flip_count: this.recentLinkFlips(),
        }),
        recommendations: [
          '检查天线视野是否被严重遮挡',
          '确认天线安装位置符合要求',
          '检查天线指向是否正确',
          '可能是区域暂时无卫星覆盖',
          '尝试重启设备',
        ],
      },

      // WiFi 信号问题
      {
        id: 'wifi_signal',
        name: 'WiFi 信号问题',
        enabled: true,
        severity: 'warning',
        condition: (data) => {
          // 检测 WiFi 信号质量问题
          const lowRssi = (data.wifiRssi ?? 0) < -70; // RSSI < -70 dBm 视为信号弱
          const lowTxRate = (data.wifiTxRate ?? 0) > 0 && (data.wifiTxRate ?? 0) < 50; // 发送速率 < 50 Mbps
          const highRetransmit = (data.wifiRetransmitRate ?? 0) > 0.15; // 重传率 > 15%
          const highChannelUtil = (data.wifiChannelUtilization ?? 0) > 0.80; // 信道利用率 > 80%
          
          // 任意条件满足即触发告警
          return lowRssi || lowTxRate || highRetransmit || highChannelUtil;
        },
        summary: (data) => {
          const rssi = data.wifiRssi?.toFixed(0) ?? 'N/A';
          const txRate = data.wifiTxRate?.toFixed(0) ?? 'N/A';
          const retransmit = data.wifiRetransmitRate ? `${(data.wifiRetransmitRate * 100).toFixed(1)}%` : 'N/A';
          const channelUtil = data.wifiChannelUtilization ? `${(data.wifiChannelUtilization * 100).toFixed(0)}%` : 'N/A';
          
          if ((data.wifiRssi ?? 0) < -70) {
            return `WiFi 信号弱 (${rssi} dBm)`;
          } else if ((data.wifiRetransmitRate ?? 0) > 0.15) {
            return `WiFi 重传率高 (${retransmit})`;
          } else if ((data.wifiChannelUtilization ?? 0) > 0.80) {
            return `WiFi 信道拥堵 (${channelUtil})`;
          } else {
            return `WiFi 连接速率低 (${txRate} Mbps)`;
          }
        },
        description: (data) => {
          const issues = [];
          if ((data.wifiRssi ?? 0) < -70) {
            issues.push(`信号强度 ${data.wifiRssi?.toFixed(0)} dBm (弱)`);
          }
          if ((data.wifiTxRate ?? 0) > 0 && (data.wifiTxRate ?? 0) < 50) {
            issues.push(`发送速率 ${data.wifiTxRate?.toFixed(0)} Mbps (低)`);
          }
          if ((data.wifiRetransmitRate ?? 0) > 0.15) {
            issues.push(`重传率 ${((data.wifiRetransmitRate ?? 0) * 100).toFixed(1)}% (高)`);
          }
          if ((data.wifiChannelUtilization ?? 0) > 0.80) {
            issues.push(`信道利用率 ${((data.wifiChannelUtilization ?? 0) * 100).toFixed(0)}% (拥堵)`);
          }
          return `WiFi 质量异常: ${issues.join(', ')}`;
        },
        evidence: (data) => ({
          wifi_rssi: data.wifiRssi,
          wifi_tx_rate: data.wifiTxRate,
          wifi_rx_rate: data.wifiRxRate,
          wifi_retransmit_rate: data.wifiRetransmitRate,
          wifi_channel_utilization: data.wifiChannelUtilization,
          wifi_client_count: data.wifiClientCount,
        }),
        recommendations: [
          '移动设备靠近路由器以改善信号',
          '检查是否有物理障碍物（墙体、金属物）阻挡信号',
          '尝试切换到不拥堵的 WiFi 信道（2.4GHz 或 5GHz）',
          '减少连接设备数量或限制带宽占用',
          '考虑使用 Mesh 网络扩展覆盖范围',
          '检查路由器天线方向',
          '远离微波炉、蓝牙设备等干扰源',
        ],
      },

      // 采集器心跳失联
      {
        id: 'collector_heartbeat_lost',
        name: '数据采集器失联',
        enabled: true,
        severity: 'critical',
        condition: () => {
          // 此规则不通过遥测数据触发，由 checkCollectorHeartbeat() 独立检查
          return false;
        },
        summary: () => '采集器连续多次采样失败',
        description: () => '无法从 Starlink 设备获取遥测数据，可能是网络或 gRPC 服务异常',
        evidence: () => {
          // 参考时间点与 checkCollectorHeartbeat() 的超时判定保持一致:
          // 从未成功采样过时回退到"心跳检查启动时间"。
          //
          // ⚠️ 不能只在 lastCollectorSuccess 非空时才给 minutes_since_success ——
          //    "从未成功过"恰恰是最需要诊断信息的情况(刚启动就断了),
          //    那时告警详情里却显示 null, 什么线索都没有。
          const referenceTime = this.lastCollectorSuccess || this.heartbeatStartTime;
          return {
            last_success_time: this.lastCollectorSuccess?.toISOString() || null,
            minutes_since_success: Math.floor(
              (Date.now() - referenceTime.getTime()) / 60000
            ),
            never_succeeded: this.lastCollectorSuccess === null,
            collector_started_at: this.heartbeatStartTime.toISOString(),
          };
        },
        recommendations: [
          '检查 Starlink 设备是否开机、网线是否连接',
          '确认设备 IP 地址和 gRPC 端口 (默认 9200) 配置正确',
          '检查防火墙是否阻止 gRPC 连接',
          '查看采集器日志确认具体错误信息',
          '如果是 DishyMock 测试环境，确认 mock 进程正在运行',
        ],
      },

      // 服务受限（账户/区域限制）
      {
        id: 'service_restricted',
        name: '服务受限',
        enabled: true,
        severity: 'critical',
        managedBy: 'telemetry',
        // 判据来自 readServiceState()，与 low_throughput 的排除条件同源。
        condition: (telemetry: TelemetryData): boolean => readServiceState(telemetry).restricted,
        summary: (telemetry: TelemetryData) => {
          const state = readServiceState(telemetry);
          const reason = state.disablementCode ?? state.classOfService ?? '未知原因';
          return `服务受限 (${reason})`;
        },
        description: (telemetry: TelemetryData) => {
          const state = readServiceState(telemetry);
          const downMbps = ((telemetry.downlinkThroughputBps || 0) / 1_000_000).toFixed(2);
          return `当前下行仅 ${downMbps} Mbps：设备已连上卫星，但账户/区域策略限制了下发。` +
            `服务等级 ${state.classOfService ?? '未知'}，禁用代码 ${state.disablementCode ?? '未知'}`;
        },
        evidence: (telemetry: TelemetryData) => {
          const state = readServiceState(telemetry);
          return {
            class_of_service: state.classOfService,
            disablement_code: state.disablementCode,
            dish_issues: telemetry.dishIssues?.map((i) => i.type) || [],
            downlink_throughput_mbps: (telemetry.downlinkThroughputBps / 1_000_000).toFixed(2),
            uplink_throughput_mbps: (telemetry.uplinkThroughputBps / 1_000_000).toFixed(2),
          };
        },
        recommendations: [
          '检查 Starlink 账户状态和订阅计划',
          '确认当前区域是否有服务限制或政策变更',
          '查看账单支付状态',
          '检查是否超出数据配额或公平使用政策',
          '联系 Starlink 客服确认服务权限',
        ],
      },

      // 服务未激活
      {
        id: 'service_not_activated',
        name: '服务未激活',
        enabled: true,
        severity: 'critical',
        managedBy: 'telemetry',
        condition: (telemetry: TelemetryData): boolean => readServiceState(telemetry).notActivated,
        summary: () => '服务未激活，无法接入卫星网络',
        description: (telemetry: TelemetryData) => {
          const state = readServiceState(telemetry);
          return `设备已上电并连上卫星，但账户尚未激活。禁用代码 ${state.disablementCode ?? '未知'}`;
        },
        evidence: (telemetry: TelemetryData) => {
          const state = readServiceState(telemetry);
          return {
            disablement_code: state.disablementCode,
            install_pending: hasAlert(telemetry, 'installPending'),
            class_of_service: state.classOfService,
          };
        },
        recommendations: [
          '完成 Starlink 账户激活流程',
          '登录 Starlink 账户确认服务订阅状态',
          '确认设备已正确绑定到账户',
          '检查账户邮箱中的激活邮件',
          '联系 Starlink 客服完成激活',
        ],
      },

      // 位置异常/移动中
      {
        id: 'location_policy_violation',
        name: '位置异常',
        enabled: true,
        severity: 'warning',
        managedBy: 'telemetry',
        condition: (telemetry: TelemetryData): boolean =>
          readServiceState(telemetry).locationViolation,
        summary: (telemetry: TelemetryData) =>
          hasAlert(telemetry, 'movingFastInHelloMobile')
            ? '设备移动速度超出套餐限制'
            : '设备位置与服务区域不符',
        description: (telemetry: TelemetryData) => {
          const moving = hasAlert(telemetry, 'movingFastInHelloMobile');
          const wrongPlace = hasAlert(telemetry, 'unexpectedLocation');
          const reasons = [
            moving && '移动速度超限',
            wrongPlace && '位置与登记地不符',
          ].filter(Boolean);
          return `位置策略校验未通过: ${reasons.join(' / ') || '原因未知'}`;
        },
        evidence: (telemetry: TelemetryData) => ({
          moving_fast_in_hello_mobile: hasAlert(telemetry, 'movingFastInHelloMobile'),
          unexpected_location: hasAlert(telemetry, 'unexpectedLocation'),
          class_of_service: readServiceState(telemetry).classOfService,
        }),
        recommendations: [
          '确认设备是否在服务区域内使用',
          '检查是否超出移动服务的速度限制',
          '如果设备已固定，等待系统更新位置信息',
          '非移动套餐不支持在移动中使用',
          '联系 Starlink 客服确认服务区域',
        ],
      },

      // 账号异常/暂停
      {
        id: 'account_suspended',
        name: '账号异常',
        enabled: true,
        severity: 'critical',
        managedBy: 'telemetry',
        condition: (telemetry: TelemetryData): boolean => readServiceState(telemetry).suspended,
        summary: () => 'Starlink 账号已暂停服务',
        description: (telemetry: TelemetryData) => {
          const state = readServiceState(telemetry);
          return `账户被暂停，设备无法提供网络。禁用代码 ${state.disablementCode ?? '未知'}`;
        },
        evidence: (telemetry: TelemetryData) => {
          const state = readServiceState(telemetry);
          return {
            class_of_service: state.classOfService,
            disablement_code: state.disablementCode,
            downlink_throughput_mbps: (telemetry.downlinkThroughputBps / 1_000_000).toFixed(2),
            uplink_throughput_mbps: (telemetry.uplinkThroughputBps / 1_000_000).toFixed(2),
          };
        },
        recommendations: [
          '检查 Starlink 账户支付状态',
          '确认账单是否逾期未支付',
          '查看账户是否因违反服务条款被暂停',
          '登录 Starlink 账户查看详细信息',
          '联系 Starlink 客服恢复服务',
        ],
      },

      // 设备漫游中
      {
        id: 'roaming',
        name: '设备漫游中',
        enabled: true,
        severity: 'warning',
        managedBy: 'telemetry',
        condition: (telemetry: TelemetryData): boolean => hasAlert(telemetry, 'roaming'),
        summary: () => '设备正在漫游状态',
        description: () =>
          '设备已离开注册服务地址，正在使用漫游服务。漫游可能导致性能降级或产生额外费用。',
        evidence: (telemetry: TelemetryData) => ({
          roaming: hasAlert(telemetry, 'roaming'),
          class_of_service: telemetry.classOfService,
          downlink_mbps: (telemetry.downlinkThroughputBps / 1e6).toFixed(2),
          uplink_mbps: (telemetry.uplinkThroughputBps / 1e6).toFixed(2),
        }),
        recommendations: [
          '确认设备是否被授权移动（如房车、船舶移动套餐）',
          '检查账户套餐是否包含漫游服务',
          '如为固定部署设备，检查设备是否被移动或盗窃',
          '查看账单确认漫游费用',
          '如需固定服务，将设备移回注册地址',
        ],
      },

      // 卫星无调度/容量不足（NO_SCHEDULE outage）
      {
        id: 'no_satellite_schedule',
        name: '卫星无调度/容量不足',
        enabled: true,
        severity: 'warning',
        // ⚠️ 生命周期由 checkOutages() 独立管理, 不是遥测驱动的规则。
        //   不加这个标记的话, checkTelemetry() 会因为 condition() 恒为 false
        //   而在每轮采集里把它 resolve 掉, 2 秒后 checkOutages 又置回 ongoing
        //   ⇒ 告警在页面上"闪一下就消失"。
        managedBy: 'outages',
        condition: () => {
          // 此规则不通过遥测数据触发，由 checkOutages() 独立检查
          return false;
        },
        summary: () => '卫星网络容量不足，暂时无法分配调度',
        description: () => '区域卫星网络拥塞或容量受限，可能影响连接质量',
        evidence: () => ({}),
        recommendations: [
          '这是卫星网络容量受限的正常现象',
          '通常在用户密集区域的高峰时段发生',
          '等待网络负载降低，系统会自动恢复',
          '如频繁发生，可能是所在区域用户数超过容量',
          '考虑在非高峰时段使用以获得更好体验',
        ],
      },
    ];

    rules.forEach((rule) => {
      this.rules.set(rule.id, rule);
    });
  }

  /**
   * 检查遥测数据并触发告警
   */
  /**
   * 记录连接状态，并维护「翻转时刻」与「进入搜星的时刻」。
   *
   * 只统计 **ONLINE ↔ 非 ONLINE** 的跃迁：BOOTING→SEARCHING 这种开机过程中的
   * 正常演进不该算作"断线重连"。
   */
  private recordLinkState(state: TelemetryData['state'], now = Date.now()): void {
    if (this.lastLinkState !== null && this.lastLinkState !== state) {
      const wasOnline = this.lastLinkState === 'ONLINE';
      const isOnline = state === 'ONLINE';
      if (wasOnline !== isOnline) {
        this.linkFlips.push(now);
        const cutoff = now - LINK_FLIP_WINDOW_MS;
        this.linkFlips = this.linkFlips.filter((t) => t >= cutoff);
      }
    }

    this.lastLinkState = state;

    if (state === 'SEARCHING') {
      if (this.searchingSince === null) this.searchingSince = now;
    } else {
      this.searchingSince = null;
    }
  }

  /** 窗口内 ONLINE ↔ 非 ONLINE 的翻转次数 */
  private recentLinkFlips(now = Date.now()): number {
    const cutoff = now - LINK_FLIP_WINDOW_MS;
    return this.linkFlips.filter((t) => t >= cutoff).length;
  }

  /**
   * 记录「已连接路由器数量」的变化。
   *
   * 数量不变（绝大多数帧）不记账，只记变化时刻 —— 这样窗口内统计到的
   * 就是"抖了几次"，而不是"采了几帧"。
   */
  private recordRouterCount(count: number | undefined, now = Date.now()): void {
    if (count === undefined) return;
    if (this.lastRouterCount !== null && this.lastRouterCount !== count) {
      this.routerCountChanges.push(now);
      const cutoff = now - ROUTER_FLAP_WINDOW_MS;
      this.routerCountChanges = this.routerCountChanges.filter((t) => t >= cutoff);
    }
    this.lastRouterCount = count;
  }

  /** 窗口内「已连接路由器数量」的变化次数 */
  private recentRouterCountChanges(now = Date.now()): number[] {
    const cutoff = now - ROUTER_FLAP_WINDOW_MS;
    return this.routerCountChanges.filter((t) => t >= cutoff);
  }

  async checkTelemetry(telemetry: TelemetryData): Promise<void> {
    // 更新采集器心跳时间
    this.lastCollectorSuccess = new Date();

    // 星链是否在线 —— 用于区分「星链链路」与「多 WAN / 5G 备线」
    this.starlinkOnline = telemetry.state === 'ONLINE';
    void this.checkNetworkRecovery();

    // 先把本帧状态记进历史 —— frequent_searching 需要跨帧计数
    this.recordLinkState(telemetry.state);
    // 路由器数量同理 —— router_flapping 需要跨帧计数
    this.recordRouterCount(telemetry.connectedRouterCount);

    const now = new Date().toISOString();

    for (const [ruleId, rule] of this.rules.entries()) {
      if (!rule.enabled) continue;

      // ⚠️ **跳过由 checkOutages() 管理的规则** ——
      //   这些规则不是遥测驱动的(数据源是 dishGetHistory 的 outages),
      //   它们的 condition 恒为 false。若在这里也走 else 分支,
      //   每轮采集都会把 ongoing 的告警 resolve 掉,
      //   2 秒后 checkOutages 又置回 ongoing ⇒ 告警"闪一下就消失"。
      if (rule.managedBy === 'outages') continue;

      try {
        const shouldAlert = rule.condition(telemetry);
        const alertKey = `${ruleId}:starlink`;

        if (shouldAlert) {
          // 告警触发
          const alert: Omit<AlertRecord, 'id' | 'created_at' | 'updated_at'> = {
            alert_key: alertKey,
            alert_type: ruleId,
            severity: rule.severity,
            status: 'ongoing',
            first_seen: now,
            last_seen: now,
            occurrence_count: 1,
            last_notified_at: null,
            notification_count: 0,
            summary: rule.summary(telemetry),
            description: rule.description(telemetry),
            evidence: JSON.stringify(rule.evidence(telemetry)),
            recommendations: JSON.stringify(rule.recommendations),
          };

          const result = this.db.upsertAlert(alert);

          if (result === 'new') {
            // 新告警,立即通知
            const record = this.db.getAlertByKey(alertKey)!;
            await this.sendNotification({ type: 'new', alert: record });
            this.db.markNotified(alertKey);
            this.emit('alert:new', record);
          } else if (result === 'ongoing') {
            // 持续触发,检查是否需要更新通知
            this.emit('alert:update', { alertKey });
          }
        } else {
          // 检查是否需要标记为已恢复
          const existing = this.db.getAlertByKey(alertKey);
          if (existing && existing.status === 'ongoing') {
            const duration = this.calculateDuration(existing.first_seen, now);

            const stmt = this.db.upsertAlert({
              ...existing,
              status: 'resolved',
              last_seen: now,
            });

            if (stmt === 'resolved') {
              await this.sendNotification({
                type: 'resolved',
                alert: { ...existing, status: 'resolved', last_seen: now },
                duration,
              });
              this.emit('alert:resolved', existing);
            }
          }
        }
      } catch (error) {
        console.error(`Error checking rule ${ruleId}:`, error);
      }
    }
  }

  /**
   * 启动定期检查需要更新通知的告警
   */
  startUpdateNotificationCheck(intervalMs = 60000): void {
    this.checkInterval = setInterval(() => {
      const alerts = this.db.getAlertsNeedingUpdate();

      alerts.forEach(async (alert) => {
        try {
          await this.sendNotification({ type: 'update', alert });
          this.db.markNotified(alert.alert_key);
        } catch (error) {
          console.error(`Failed to send update notification for ${alert.alert_key}:`, error);
        }
      });
    }, intervalMs);
  }

  /**
   * 启动采集器心跳检查
   * @param timeoutMinutes 超时分钟数，默认 3 分钟
   * @param checkIntervalMs 检查间隔，默认 30 秒
   */
  startHeartbeatCheck(timeoutMinutes = 3, checkIntervalMs = 30000): void {
    this.heartbeatInterval = setInterval(async () => {
      await this.checkCollectorHeartbeat(timeoutMinutes);
    }, checkIntervalMs);
  }

  /**
   * 启动离线队列的定时清理。
   *
   * 即时 GC（冲刷后立刻回收）只覆盖"正常补发"的路径；进程被强杀、
   * 补发中途崩溃等情况下仍可能留下已冲刷的行 —— 这条兜底保证长连接
   * 运行下存储收敛，而不是只增不减。
   *
   * @param intervalMs 清理间隔，默认 24 小时
   */
  startOfflineQueueCleanup(intervalMs = 86400000): void {
    this.offlineQueueCleanupInterval = setInterval(() => {
      this.runOfflineQueueCleanup();
    }, intervalMs);
  }

  /** 执行一次离线队列清理（已冲刷的记录立即回收） */
  private runOfflineQueueCleanup(): void {
    try {
      const removed = this.db.cleanupFlushedOfflineAlerts();
      if (removed > 0) {
        console.log(`[AlertManager] 清理已冲刷的离线队列记录：${removed} 条`);
      }
    } catch (error) {
      console.error('[AlertManager] 清理离线队列失败:', error);
    }
  }

  /**
   * 检查采集器心跳
   */
  private async checkCollectorHeartbeat(timeoutMinutes: number): Promise<void> {
    const now = new Date();
    const alertKey = 'collector_heartbeat_lost:starlink';

    // 计算距离上次成功的时间，如果从未成功则计算距离启动的时间
    const referenceTime = this.lastCollectorSuccess || this.heartbeatStartTime;
    const minutesSinceSuccess = (now.getTime() - referenceTime.getTime()) / 60000;
    const isTimeout = minutesSinceSuccess >= timeoutMinutes;

    if (isTimeout) {
      // 触发心跳失联告警
      const rule = this.rules.get('collector_heartbeat_lost');
      if (!rule || !rule.enabled) return;

      const alert: Omit<AlertRecord, 'id' | 'created_at' | 'updated_at'> = {
        alert_key: alertKey,
        alert_type: 'collector_heartbeat_lost',
        severity: 'critical',
        status: 'ongoing',
        first_seen: now.toISOString(),
        last_seen: now.toISOString(),
        occurrence_count: 1,
        last_notified_at: null,
        notification_count: 0,
        summary: rule.summary({} as TelemetryData),
        description: rule.description({} as TelemetryData),
        evidence: JSON.stringify(rule.evidence({} as TelemetryData)),
        recommendations: JSON.stringify(rule.recommendations),
      };

      const result = this.db.upsertAlert(alert);

      if (result === 'new') {
        const record = this.db.getAlertByKey(alertKey)!;
        await this.sendNotification({ type: 'new', alert: record });
        this.db.markNotified(alertKey);
        this.emit('alert:new', record);
        console.log(`[AlertManager] Collector heartbeat lost: ${minutesSinceSuccess.toFixed(1)} minutes since last success`);
      }
    } else {
      // 检查是否需要解除告警
      const existing = this.db.getAlertByKey(alertKey);
      if (existing && existing.status === 'ongoing') {
        const duration = this.calculateDuration(existing.first_seen, now.toISOString());

        this.db.upsertAlert({
          ...existing,
          status: 'resolved',
          last_seen: now.toISOString(),
        });

        await this.sendNotification({
          type: 'resolved',
          alert: { ...existing, status: 'resolved', last_seen: now.toISOString() },
          duration,
        });
        this.emit('alert:resolved', existing);
        console.log(`[AlertManager] Collector heartbeat restored`);
      }
    }
  }

  /**
   * 检查 outage 事件并触发相应告警
   * 
   * @param outages - 从 dishGetHistory 获取的非切换类 outage 事件
   */
  async checkOutages(outages: Array<{ 
    startTimestamp: number; 
    durationMs: number; 
    cause?: string;
    triggered?: string;
  }>): Promise<void> {
    const now = new Date().toISOString();
    const nowMs = Date.now();

    // 检查 NO_SCHEDULE outage
    //
    // ⚠️ 必须按「结束时刻」筛新鲜度，不能只看 cause ——
    //   数据源是滑动窗口里的历史中断，窗口里存在 ≠ 此刻仍在发生。
    //   判据用 `startTimestamp + durationMs`：一条仍在进行中的 45 秒
    //   NO_SCHEDULE，它的 end 在未来，天然满足；已经结束的旧事件被排除。
    const noScheduleOutages = outages.filter(o => {
      const causeStr = (o.cause || o.triggered || '').toUpperCase();
      if (!causeStr.includes('NO_SCHEDULE') && !causeStr.includes('SCHEDULE')) {
        return false;
      }
      const startMs = Number(o.startTimestamp) || 0;
      const durationMs = Number(o.durationMs) || 0;
      return startMs + durationMs >= nowMs - OUTAGE_FRESH_WINDOW_MS;
    });

    if (noScheduleOutages.length > 0) {
      const rule = this.rules.get('no_satellite_schedule');
      if (!rule || !rule.enabled) return;

      const alertKey = 'no_satellite_schedule:starlink';

      // 计算总持续时长
      const totalDurationMs = noScheduleOutages.reduce((sum, o) => sum + o.durationMs, 0);
      const avgDurationMs = totalDurationMs / noScheduleOutages.length;

      // ⚠️ **保留首次出现的时间** ——
      //   原来每次都写 `first_seen: now`, 于是告警的"持续时长"永远从
      //   上一轮开始算, 抖动巨大。首次出现的时间应该延续。
      const existing = this.db.getAlertByKey(alertKey);
      const firstSeen = existing && existing.status === 'ongoing'
        ? existing.first_seen
        : now;

      const alert: Omit<AlertRecord, 'id' | 'created_at' | 'updated_at'> = {
        alert_key: alertKey,
        alert_type: 'no_satellite_schedule',
        severity: 'warning',
        status: 'ongoing',
        first_seen: firstSeen,
        last_seen: now,
        occurrence_count: noScheduleOutages.length,
        last_notified_at: null,
        notification_count: 0,
        summary: rule.summary({} as TelemetryData),
        description: rule.description({} as TelemetryData),
        evidence: JSON.stringify({
          outage_count: noScheduleOutages.length,
          total_duration_ms: totalDurationMs,
          avg_duration_ms: avgDurationMs,
          latest_timestamp: Math.max(...noScheduleOutages.map(o => o.startTimestamp)),
        }),
        recommendations: JSON.stringify(rule.recommendations),
      };

      const result = this.db.upsertAlert(alert);

      if (result === 'new') {
        const record = this.db.getAlertByKey(alertKey)!;
        await this.sendNotification({ type: 'new', alert: record });
        this.db.markNotified(alertKey);
        this.emit('alert:new', record);
        console.log(`[AlertManager] NO_SCHEDULE 告警: ${noScheduleOutages.length} 次, 平均 ${avgDurationMs.toFixed(0)}ms`);
      } else if (result === 'ongoing') {
        this.emit('alert:update', { alertKey });
      }
    } else {
      // 检查是否需要解除告警
      const alertKey = 'no_satellite_schedule:starlink';
      const existing = this.db.getAlertByKey(alertKey);
      if (existing && existing.status === 'ongoing') {
        const duration = this.calculateDuration(existing.first_seen, now);

        this.db.upsertAlert({
          ...existing,
          status: 'resolved',
          last_seen: now,
        });

        await this.sendNotification({
          type: 'resolved',
          alert: { ...existing, status: 'resolved', last_seen: now },
          duration,
        });
        this.emit('alert:resolved', existing);
        console.log(`[AlertManager] NO_SCHEDULE 告警已恢复`);
      }
    }
  }

  /**
   * 检查 DNS 探针状态并触发告警
   *
   * 从 ProbeRunner 接收探针结果，维护连续失败计数，
   * 根据「连续 3 次失败」触发告警，并实施依赖压制逻辑。
   */
  async checkDnsProbe(probeResult: any): Promise<void> {
    // 只处理 dns_dual 类型探针
    if (!probeResult.dualDns) return;

    const nodeId = probeResult.nodeId;
    const now = new Date().toISOString();

    // 存储最新探针结果（用于告警详情）
    this.dnsProbeLastResults.set(nodeId, probeResult);

    // 更新连续失败计数
    if (!probeResult.ok) {
      const failures = (this.dnsProbeFailures.get(nodeId) || 0) + 1;
      this.dnsProbeFailures.set(nodeId, failures);

      // 连续 3 次失败触发告警
      if (failures >= 3) {
        // 依赖抑制：连 DNS 服务器都连不上 ⇒ 是【数据源不可用】，不是【域名解析失败】。
        // 这两种情况混在一起会误诊 —— 用户会以为自己的 DNS 配置坏了，
        // 实际上挂掉的是被测数据源（本地 mock / 探针目标）。
        if (probeResult.failureMode === 'unreachable') {
          await this.triggerProbeSourceAlert(nodeId, probeResult, now);
          // 之前那条"域名解析失败"如果还挂着，要撤掉：它描述的条件已经不成立了
          this.resolveDnsAlert(nodeId, now);
        } else {
          this.triggerDnsAlert(nodeId, probeResult, now);
        }
      }
    } else {
      // 探测成功，重置计数并尝试解除告警
      this.dnsProbeFailures.set(nodeId, 0);
      this.resolveDnsAlert(nodeId, now);
      this.resolveProbeSourceAlert(nodeId, now);
    }
  }

  /**
   * 更新 ICMP 探针状态（供依赖压制逻辑使用）
   */
  updateIcmpProbeState(nodeId: string, reachable: boolean, consecutiveFailures: number): void {
    this.icmpProbeStates.set(nodeId, { reachable, consecutiveFailures });
    // 公网恢复的瞬间 ⇒ 冲刷离线队列（后台做，不阻塞探针回调）
    if (nodeId === 'public-ping') {
      void this.checkNetworkRecovery();
    }
  }

  /**
   * 触发 DNS 告警（带依赖压制逻辑）
   */
  private triggerDnsAlert(nodeId: string, probeResult: any, now: string): void {
    // 依赖压制：检查底层 ICMP 是否已断开
    const publicPingState = this.icmpProbeStates.get('public-ping');
    const localGatewayState = this.icmpProbeStates.get('local-gateway');

    // 如果公网 Ping 或本地网关彻底断开（连续失败 >= 3），压制 DNS 告警
    if (
      (publicPingState && publicPingState.consecutiveFailures >= 3) ||
      (localGatewayState && localGatewayState.consecutiveFailures >= 3)
    ) {
      console.log(`[AlertManager] DNS 告警被压制：底层网络已断开 (${nodeId})`);
      return;
    }

    const alertKey = `dns_failure:${nodeId}`;
    const { dualDns } = probeResult;
    const userOk = dualDns.user.ok;
    const baselineOk = dualDns.baseline.ok;

    // 归因分析
    let summary = '⚠️ 网页无法加载 (域名解析失败)';
    let description = '';
    const recommendations: string[] = [];

    if (!userOk && baselineOk) {
      // 场景 1：用户 DNS 故障，基准 DNS 正常
      description = '诊断结果：基础网络畅通，但您的当前域名服务器无响应。';
      recommendations.push(
        '建议您在 WiFi 路由器或设备设置中，将 DNS 手动修改为 8.8.8.8 或 1.1.1.1',
        '如果问题持续，请联系您的网络服务提供商'
      );
    } else if (!userOk && !baselineOk) {
      // 场景 2：双轨探测均失败
      if (localGatewayState && !localGatewayState.reachable) {
        description = '诊断结果：检测到本地局域网严重拥堵导致解析请求被丢弃。';
        recommendations.push(
          '请检查当前是否有设备正在进行大规模下载、云盘上传或测速',
          '尝试重启路由器以释放网络资源'
        );
      } else {
        description = '诊断结果：网络层故障或目标域名不存在。';
        recommendations.push(
          '检查设备的网络连接状态',
          '确认 Starlink 天线状态正常',
          '等待片刻后重试'
        );
      }
    }

    const existing = this.db.getAlertByKey(alertKey);
    const firstSeen = existing && existing.status === 'ongoing' ? existing.first_seen : now;

    const alert: Omit<AlertRecord, 'id' | 'created_at' | 'updated_at'> = {
      alert_key: alertKey,
      alert_type: 'dns_failure',
      severity: 'warning',
      status: 'ongoing',
      first_seen: firstSeen,
      last_seen: now,
      occurrence_count: this.dnsProbeFailures.get(nodeId) || 3,
      last_notified_at: null,
      notification_count: 0,
      summary,
      description,
      evidence: JSON.stringify({
        node_id: nodeId,
        consecutive_failures: this.dnsProbeFailures.get(nodeId),
        user_dns: {
          ok: dualDns.user.ok,
          rtt_ms: dualDns.user.rttMs,
          error: dualDns.user.error,
          resolved_ip: dualDns.user.resolvedIp,
        },
        baseline_dns: {
          ok: dualDns.baseline.ok,
          rtt_ms: dualDns.baseline.rttMs,
          error: dualDns.baseline.error,
          resolved_ip: dualDns.baseline.resolvedIp,
        },
      }),
      recommendations: JSON.stringify(recommendations),
    };

    const result = this.db.upsertAlert(alert);

    if (result === 'new') {
      const record = this.db.getAlertByKey(alertKey)!;
      void this.sendNotification({ type: 'new', alert: record });
      this.db.markNotified(alertKey);
      this.emit('alert:new', record);
      console.log(`[AlertManager] DNS 告警触发: ${nodeId}, 连续失败 ${this.dnsProbeFailures.get(nodeId)} 次`);
    } else if (result === 'ongoing') {
      this.emit('alert:update', { alertKey });
    }
  }

  /**
   * 解除 DNS 告警
   */
  /**
   * 触发「数据源不可用」告警。
   *
   * 触发条件：DNS 探针**连不上目标服务器**（ECONNREFUSED / 主机不可达 …）。
   * 这说明被测的数据源本身下线了，而不是"用户域名解析失败"。
   *
   * 与 `dns_failure` 的分工：
   * - `dns_failure` —— 服务器答了但解析不出域名 ⇒ 真的是 DNS 问题
   * - `probe_source_unavailable` —— 服务器都联系不上 ⇒ 依赖挂了，别误诊成 DNS 问题
   */
  private async triggerProbeSourceAlert(nodeId: string, probeResult: any, now: string): Promise<void> {
    const alertKey = `probe_source_unavailable:${nodeId}`;
    const { dualDns } = probeResult;
    const userErr = dualDns?.user?.error ?? probeResult.error ?? 'unknown';
    const baselineErr = dualDns?.baseline?.error ?? 'unknown';

    const existing = this.db.getAlertByKey(alertKey);
    const firstSeen = existing && existing.status === 'ongoing' ? existing.first_seen : now;

    const alert: Omit<AlertRecord, 'id' | 'created_at' | 'updated_at'> = {
      alert_key: alertKey,
      alert_type: 'probe_source_unavailable',
      severity: 'warning',
      status: 'ongoing',
      first_seen: firstSeen,
      last_seen: now,
      occurrence_count: this.dnsProbeFailures.get(nodeId) || 3,
      last_notified_at: null,
      notification_count: 0,
      summary: '数据源不可用（探针目标不可达）',
      description:
        `探针 ${nodeId} 连不上目标 DNS 服务器（用户态 ${userErr} / 基准态 ${baselineErr}）。` +
        `这属于依赖不可用，不是域名解析失败 —— 相应的「DNS 解析失败」告警已抑制，避免误诊。`,
      evidence: JSON.stringify({
        node_id: nodeId,
        failure_mode: 'unreachable',
        error: userErr,
        user_dns: {
          ok: dualDns?.user?.ok ?? false,
          rtt_ms: dualDns?.user?.rttMs ?? null,
          error: userErr,
        },
        baseline_dns: {
          ok: dualDns?.baseline?.ok ?? false,
          rtt_ms: dualDns?.baseline?.rttMs ?? null,
          error: baselineErr,
        },
      }),
      recommendations: JSON.stringify([
        '确认被测数据源是否在运行（本地 mock / 探针目标服务）',
        '数据源恢复后本告警会自动解除',
      ]),
    };

    const result = this.db.upsertAlert(alert);
    console.log(`[AlertManager] 数据源不可用告警触发: ${nodeId} (${userErr})`);

    if (result === 'new') {
      const record = this.db.getAlertByKey(alertKey)!;
      await this.sendNotification({ type: 'new', alert: record });
      this.db.markNotified(alertKey);
      this.emit('alert:new', record);
    } else if (result === 'ongoing') {
      this.emit('alert:update', { alertKey });
    }
  }

  /** 数据源恢复后解除「数据源不可用」告警 */
  private resolveProbeSourceAlert(nodeId: string, now: string): void {
    const alertKey = `probe_source_unavailable:${nodeId}`;
    const existing = this.db.getAlertByKey(alertKey);
    if (!existing || existing.status !== 'ongoing') return;

    const duration = this.calculateDuration(existing.first_seen, now);
    this.db.upsertAlert({
      alert_key: alertKey,
      alert_type: 'probe_source_unavailable',
      severity: 'warning',
      status: 'resolved',
      first_seen: existing.first_seen,
      last_seen: now,
      occurrence_count: existing.occurrence_count,
      last_notified_at: existing.last_notified_at,
      notification_count: existing.notification_count,
      summary: existing.summary,
      description: '探针目标已恢复可达',
      evidence: existing.evidence,
      recommendations: existing.recommendations,
    });

    void this.sendNotification({
      type: 'resolved',
      alert: { ...existing, status: 'resolved', last_seen: now },
      duration,
    });
    console.log(`[AlertManager] 数据源不可用告警已恢复: ${nodeId}`);
  }

  private resolveDnsAlert(nodeId: string, now: string): void {
    const alertKey = `dns_failure:${nodeId}`;
    const existing = this.db.getAlertByKey(alertKey);

    if (existing && existing.status === 'ongoing') {
      const duration = this.calculateDuration(existing.first_seen, now);
      
      // 使用 upsertAlert 标记为 resolved
      this.db.upsertAlert({
        alert_key: alertKey,
        alert_type: 'dns_failure',
        severity: 'warning',
        status: 'resolved',
        first_seen: existing.first_seen,
        last_seen: now,
        occurrence_count: existing.occurrence_count,
        last_notified_at: existing.last_notified_at,
        notification_count: existing.notification_count,
        summary: existing.summary,
        description: 'DNS 解析已恢复正常',
        evidence: existing.evidence,
        recommendations: existing.recommendations,
      });

      void this.sendNotification({
        type: 'resolved',
        alert: { ...existing, status: 'resolved', last_seen: now },
        duration,
      });
      this.emit('alert:resolved', existing);
      console.log(`[AlertManager] DNS 告警已恢复: ${nodeId}`);
    }
  }

  /**
   * 发送通知
   */
  private async sendNotification(context: NotificationContext): Promise<void> {
    try {
      // 统一在这里补上告警标题：规则的中文名（如「恶劣天气影响」）。
      // webhook 模板里的 {{alert_title}} 用它 —— 没有对应规则时
      // （如 dns_failure / probe_source_unavailable）留空，由通知层回退成 alert_type。
      //
      // ⚠️ 走分发器而不是 notifier.notify()：内网目标要立刻发（不等公网连通性），
      // 公网目标在无外网时要进离线队列而不是干等。
      const result = await this.dispatcher.dispatch({
        ...context,
        title: context.title ?? this.ruleTitleFor(context.alert.alert_type),
      });
      if (result.queued.length > 0) {
        this.emit('notification:queued', {
          channels: result.queued.map((q) => q.channel),
          pending: this.dispatcher.pendingCount(),
        });
      }
    } catch (error) {
      console.error('Failed to send notification:', error);
      this.emit('notification:error', { context, error });
    }
  }

  /**
   * 当前外网路径。
   *
   * - 公网可达性 ← `public-ping` 探针（还没跑过时乐观当作可达：
   *   最坏结果只是发一次失败然后入队，不会丢消息）；
   * - 星链是否在线 ← 采集到的终端状态。
   */
  private currentNetworkPath(): NetworkPath {
    const publicState = this.icmpProbeStates.get('public-ping');
    const publicReachable = publicState ? publicState.reachable : true;
    return resolveNetworkPath({
      publicReachable,
      starlinkOnline: this.starlinkOnline,
    });
  }

  /**
   * 发现「无外网 → 有外网」的恢复瞬间 ⇒ 冲刷离线队列（聚合补发）。
   *
   * 不抛异常：补发失败只是队列还在，不该影响别的流程。
   */
  private async checkNetworkRecovery(): Promise<void> {
    const path = this.currentNetworkPath();
    const previous = this.lastNetworkPath;
    this.lastNetworkPath = path;
    if (previous === 'none' && path !== 'none') {
      try {
        await this.dispatcher.flushIfRecovered();
      } catch (error) {
        console.error('[AlertManager] 离线队列冲刷失败:', error);
      }
    }
  }

  /** 取告警类型对应的规则中文名；没有对应规则时返回 undefined */
  private ruleTitleFor(alertType: string): string | undefined {
    return this.rules.get(alertType)?.name;
  }

  /**
   * 计算持续时长
   */
  private calculateDuration(start: string, end: string): string {
    const diffMs = new Date(end).getTime() - new Date(start).getTime();
    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}小时${minutes % 60}分钟`;
    } else if (minutes > 0) {
      return `${minutes}分钟${seconds % 60}秒`;
    } else {
      return `${seconds}秒`;
    }
  }

  /**
   * 获取活跃告警
   */
  getActiveAlerts(): AlertRecord[] {
    return this.db.getActiveAlerts();
  }

  /**
   * 忽略告警
   * @param alertKey 告警唯一标识
   * @param snoozeType 忽略类型
   * @param durationMs 忽略时长(毫秒), 仅 temporary 类型需要
   */
  snoozeAlert(alertKey: string, snoozeType: 'temporary' | 'until_resolved', durationMs?: number): void {
    this.db.snoozeAlert(alertKey, snoozeType, durationMs);
    console.log(`[AlertManager] 告警已忽略: ${alertKey}, 类型: ${snoozeType}, 时长: ${durationMs ? `${durationMs / 1000}s` : 'N/A'}`);
  }

  /**
   * 取消忽略告警
   */
  unsnoozeAlert(alertKey: string): void {
    this.db.unsnoozeAlert(alertKey);
    console.log(`[AlertManager] 取消忽略告警: ${alertKey}`);
  }

  /**
   * 标记告警为误报
   *
   * 语义：用户否认该事件真实发生过。告警立即终结、移入历史，
   * 终态为 false_positive 而非 resolved，并从此刻起冻结快照。
   */
  markFalsePositive(alertKey: string, deviceId?: string): void {
    this.db.markFalsePositive(alertKey);
    // 打点日志(未来可上报到服务端)
    console.log(`[AlertManager] 用户标记误报: ${JSON.stringify({
      alertKey,
      deviceId: deviceId || 'unknown',
      timestamp: new Date().toISOString(),
      tag: 'User_Marked_False_Positive',
    })}`);
  }

  /**
   * 撤销误报，把告警退回活跃列表
   */
  unmarkFalsePositive(alertKey: string): void {
    this.db.unmarkFalsePositive(alertKey);
    console.log(`[AlertManager] 撤销误报标记: ${alertKey}`);
  }

  /**
   * 获取告警历史（包括已恢复）
   *
   * 主入口是 queryHistory —— 它一次返回列表和总数，且支持时间范围。
   * 这个方法只为既有调用方保留位置参数形态。
   */
  getAlertHistory(
    limit = 100,
    offset = 0,
    severityFilter?: import('./database').Severity,
    statusFilter?: import('./database').Status
  ): AlertRecord[] {
    return this.db.getAlertHistory(limit, offset, severityFilter, statusFilter);
  }

  /**
   * 获取告警总数（用于分页）
   */
  getAlertCount(
    severityFilter?: import('./database').Severity,
    statusFilter?: import('./database').Status
  ): number {
    return this.db.getAlertCount(severityFilter, statusFilter);
  }

  /**
   * 历史查询：分页 + 严重度/状态/时间范围筛选的唯一入口。
   * IPC 层直接透传契约对象，不再拆成两个方法各拼一遍条件。
   */
  queryHistory(
    query: import('./database').AlertHistoryQuery = {}
  ): { alerts: AlertRecord[]; total: number } {
    return this.db.queryHistory(query);
  }

  /**
   * 添加自定义规则
   */
  addRule(rule: AlertRule): void {
    this.rules.set(rule.id, rule);
  }

  /**
   * 禁用规则
   */
  disableRule(ruleId: string): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.enabled = false;
    }
  }

  /**
   * 启用规则
   */
  enableRule(ruleId: string): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.enabled = true;
    }
  }

  /**
   * 清理历史告警
   */
  cleanup(daysToKeep = 30): number {
    return this.db.cleanupResolvedAlerts(daysToKeep);
  }

  /**
   * 更新告警阈值并重新初始化规则
   */
  updateThresholds(thresholds: AlertThresholds): void {
    this.thresholds = thresholds;
    this.initializeDefaultRules(); // 重新初始化规则以应用新阈值
  }

  /**
   * 关闭告警管理器
   */
  close(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.offlineQueueCleanupInterval) {
      clearInterval(this.offlineQueueCleanupInterval);
    }
    this.db.close();
  }
}