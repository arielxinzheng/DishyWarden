/**
 * SL Cloud 上报客户端（主进程侧）
 *
 * 把「告警误报负样本」「升级生命周期事件」匿名上报到 SL Cloud。
 * 设计依据：CloudServer/DESIGN.md §5.3（字段白名单）/ §6（隐私口径）
 *
 * ## 三条铁律
 *
 * 1. **绝不抛错** —— 上报失败绝不能影响监控主职（7×24 无人值守是产品底线）
 * 2. **绝不阻塞** —— 超时即放弃；离线直接丢弃（升级事件本就需要联网，补发无意义）
 * 3. **只发白名单字段** —— 通知配置 token、文件路径、主机名等一律不发
 *
 * 注意：这里只做「客户端侧白名单」，服务端还会再过滤一遍（DESIGN §4.3），
 * 双层过滤是刻意的 —— 任何一层单独失效都不会导致敏感信息外泄。
 */

import type { AppConfig } from '../config/manager';

export interface CloudFeedbackRecord {
  type: 'alert_false_positive' | 'general';
  /** 告警规则 key，如 high_latency —— 阈值调优的第一维度 */
  alert_key?: string;
  severity?: string;
  title?: string;
  /** 触发瞬间的遥测快照（可含坐标，用户已授权） */
  evidence?: unknown;
  note?: string;
}

export interface CloudUpgradeRecord {
  type: 'upgrade_check' | 'upgrade_download' | 'upgrade_install' | 'upgrade_heartbeat';
  result?: 'no_update' | 'available' | 'error';
  latest_version?: string;
  ok?: boolean;
  error?: string;
  to_version?: string;
}

export type CloudRecord = CloudFeedbackRecord | CloudUpgradeRecord;

export interface CloudClientOptions {
  /** 每次调用时读取配置 —— 用户改了地址立刻生效，不用重启 */
  getConfig: () => AppConfig;
  getAppVersion: () => string;
  getPlatform?: () => string;
  /** 单次请求超时（毫秒） */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;

/** 反馈类型白名单（服务端同款，见 DESIGN §4.3） */
const FEEDBACK_FIELDS = ['alert_key', 'severity', 'title', 'evidence', 'note'] as const;
/** 升级事件类型白名单 */
const UPGRADE_FIELDS = ['result', 'latest_version', 'ok', 'error', 'to_version'] as const;

export class CloudClient {
  private readonly options: CloudClientOptions;

  constructor(options: CloudClientOptions) {
    this.options = options;
  }

  /** 是否配置了云端地址 —— 没配就完全不发 */
  get enabled(): boolean {
    return this.endpoint().length > 0;
  }

  private endpoint(): string {
    const raw = this.options.getConfig()?.cloud?.endpoint ?? '';
    return raw.trim().replace(/\/+$/, '');
  }

  private clientId(): string {
    return this.options.getConfig()?.cloud?.clientId ?? '';
  }
  /**
   * 上报一条记录。
   *
   * @returns 是否成功送达（失败不抛错，只返回 false）
   */
  async report(record: CloudRecord): Promise<boolean> {
    const endpoint = this.endpoint();
    if (!endpoint) return false;

    // 误报反馈受开关控制；升级事件只要配了地址就发（它是链路健康度数据）
    if (record.type === 'alert_false_positive' && !this.options.getConfig()?.cloud?.feedbackEnabled) {
      return false;
    }
    const payload = this.buildPayload(record);
    if (!payload) return false;

    const url = `${endpoint}/api/feedback`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      // 204 是成功；4xx/5xx 都算失败，但都不该重试（重试会放大负载）
      return res.status === 204;
    } catch {
      // 网络不可达 / 超时 / DNS 失败 —— 静默丢弃，绝不外抛
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 组装上报载荷：只保留白名单字段 + 服务端注入位由服务端补。
   */
  private buildPayload(record: CloudRecord): Record<string, unknown> | null {
    const clientId = this.clientId();
    if (!clientId) return null; // 没有 client_id 就不上报（服务端会拒）

    const payload: Record<string, unknown> = {
      type: record.type,
      client_id: clientId,
      app_version: this.options.getAppVersion(),
      platform: this.options.getPlatform?.() ?? 'unknown',
    };

    const fields =
      record.type === 'upgrade_check' ||
      record.type === 'upgrade_download' ||
      record.type === 'upgrade_install' ||
      record.type === 'upgrade_heartbeat'
        ? UPGRADE_FIELDS
        : FEEDBACK_FIELDS;

    for (const key of fields) {
      const value = (record as unknown as Record<string, unknown>)[key];
      if (value === undefined || value === null) continue;
      payload[key] = value;
    }

    return payload;
  }
}
