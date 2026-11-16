/**
 * 告警通知器
 * 支持多渠道通知: Telegram, Webhook, 邮件
 */

import type { AlertRecord } from './database';

import {
  DEFAULT_WEBHOOK_TEMPLATE,
  buildWebhookRequest,
  type WebhookVarValue,
} from './webhookTemplate';
import {
  classifyTarget,
  hostFromSmtpAddress,
  hostFromUrl,
  type ChannelKind,
  type ClassifiedTarget,
} from './targetClassifier';

/** 单次发送的结果 */
export interface SendResult {
  ok: boolean;
  /** 失败原因（成功时为空） */
  error?: string;
}

export interface NotificationConfig {
  telegram?: {
    enabled: boolean;
    botToken: string;
    chatId: string;
  };
  webhook?: {
    enabled: boolean;
    url: string;
    /** 请求方法：GET 把 payload 拼到 URL 查询串，POST 作为请求体发送 */
    method?: 'GET' | 'POST';
    /** 自定义请求头（如 {"Authorization": "Bearer xxx"}），用于接口鉴权 */
    headers?: Record<string, string>;
    /**
     * 自定义请求体模板（JSON），支持 `{{变量}}` 插值。
     *
     * 例：`{"content": "告警：{{alert_title}}，详情：{{alert_detail}}"}`
     * 变量清单见 `webhookTemplate.ts` 的 WEBHOOK_TEMPLATE_VARIABLES。
     */
    payloadTemplate?: string;
    /** 请求超时（毫秒），默认 5000；超时按失败处理并记本地错误日志 */
    timeoutMs?: number;
  };
  email?: {
    enabled: boolean;
    smtpHost: string;
    smtpPort: number;
    username: string;
    password: string;
    from?: string;
    to: string[];
    useTLS?: boolean;
  };
}

export interface NotificationContext {
  type: 'new' | 'update' | 'resolved';
  alert: AlertRecord;
  duration?: string; // 持续时长(仅 resolved 时)
  /** 告警标题（规则名）；没有对应规则时留空，由调用方兜底成 alert_type */
  title?: string;
}

/** Telegram 单次请求超时（毫秒）—— 与 webhook 默认口径一致 */
const TELEGRAM_TIMEOUT_MS = 5000;

export class Notifier {
  constructor(private config: NotificationConfig) {}

  /**
   * 发送通知到所有启用的渠道。
   *
   * ⚠️ 直接用这个方法会**绕过**内网/公网分流（内网目标不该等公网连通性、
   * 公网目标不该在无外网时干等）。告警链路请走 `AlertDispatcher.dispatch()`。
   */
  async notify(context: NotificationContext): Promise<void> {
    const targets = this.enabledTargets();
    await Promise.allSettled(targets.map((t) => this.sendTo(t.kind, context)));
  }

  /**
   * 当前启用的通道 + 它们的可达域分类。
   *
   * 分发器靠它决定：内网目标立刻发，公网目标要先看网络路径。
   */
  enabledTargets(): ClassifiedTarget[] {
    const out: ClassifiedTarget[] = [];

    if (this.config.telegram?.enabled) {
      out.push(classifyTarget('telegram', 'api.telegram.org'));
    }
    if (this.config.webhook?.enabled) {
      out.push(classifyTarget('webhook', hostFromUrl(this.config.webhook.url ?? '')));
    }
    if (this.config.email?.enabled) {
      out.push(classifyTarget('email', hostFromSmtpAddress(this.config.email.smtpHost ?? '')));
    }
    return out;
  }

  /**
   * 发给**指定**通道，返回成功与否。
   *
   * 永远不抛异常 —— 调用方（分发器）需要用这个结果决定"入队还是算了"。
   */
  async sendTo(kind: ChannelKind, context: NotificationContext): Promise<SendResult> {
    try {
      switch (kind) {
        case 'telegram':
          await this.sendTelegram(context);
          break;
        case 'email':
          await this.sendEmail(context);
          break;
        case 'webhook':
          return await this.sendWebhook(context);
      }
      return { ok: true };
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      console.error(`[Notifier] ${kind} 发送失败:`, message);
      return { ok: false, error: message };
    }
  }

  /**
   * Telegram 通知
   */
  private async sendTelegram(context: NotificationContext): Promise<void> {
    const { botToken, chatId } = this.config.telegram!;
    const message = this.formatTelegramMessage(context);

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    // 超时控制：Node 的 fetch **默认没有超时**。目标被黑洞(连不上的测试网、
    // 被墙的 API)时 fetch 会一直挂到 OS 的 TCP 超时(可达数分钟)。
    // 告警分发是串行 await 的 ⇒ 一个挂住的通道会把后面所有通道一起堵死
    // (表现为"告警发不出去")。与 webhook 通道保持同一个 5s 口径。
    const timeoutMs = TELEGRAM_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Telegram API error: ${response.status}`);
      }
    } catch (error) {
      console.error('Failed to send Telegram notification:', error);
      if (controller.signal.aborted) {
        throw new Error(`请求超时（${timeoutMs}ms）`);
      }
      throw error;
    } finally {
      // 必须清掉定时器 —— 否则它会吊住事件循环最多 5s（发送成功也是）
      clearTimeout(timer);
    }
  }


  /**
   * 格式化 Telegram 消息
   */
  private formatTelegramMessage(context: NotificationContext): string {
    const { alert, type, duration } = context;
    const emoji = this.getSeverityEmoji(alert.severity);
    const statusEmoji = type === 'resolved' ? '✅' : type === 'new' ? '🚨' : '⚠️';

    if (type === 'resolved') {
      return `
${statusEmoji} <b>[RESOLVED]</b> ${alert.summary}

⏰ 恢复时间: ${new Date(alert.last_seen).toLocaleString('zh-CN')}
⏱️ 持续时长: ${duration || '未知'}
🔢 发生次数: ${alert.occurrence_count}次

#${alert.alert_type.replace(/_/g, '')} #Resolved
      `.trim();
    }

    const evidence = alert.evidence ? JSON.parse(alert.evidence) : {};
    const recommendations = alert.recommendations ? JSON.parse(alert.recommendations) : [];

    let message = `
${emoji} <b>[${alert.severity.toUpperCase()}]</b> ${alert.summary}

⏰ 发生时间: ${new Date(alert.first_seen).toLocaleString('zh-CN')}
📍 故障类型: ${alert.alert_type}
`.trim();

    if (type === 'update') {
      message += `\n🔄 状态: 持续中 (第${alert.occurrence_count}次)`;
    }

    if (Object.keys(evidence).length > 0) {
      message += '\n\n📊 证据:';
      for (const [key, value] of Object.entries(evidence)) {
        message += `\n- ${key}: ${value}`;
      }
    }

    if (recommendations.length > 0) {
      message += '\n\n💡 建议动作:';
      recommendations.forEach((rec: string, i: number) => {
        message += `\n${i + 1}. ${rec}`;
      });
    }

    message += `\n\n#${alert.alert_type.replace(/_/g, '')} #${alert.severity}`;

    return message;
  }

  /**
   * Webhook 通知
   */
  private async sendWebhook(context: NotificationContext): Promise<SendResult> {
    const cfg = this.config.webhook!;
    const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : 5000;

    let request;
    try {
      request = buildWebhookRequest(
        {
          url: cfg.url,
          method: cfg.method,
          headers: cfg.headers,
          payloadTemplate: cfg.payloadTemplate ?? DEFAULT_WEBHOOK_TEMPLATE,
        },
        this.buildWebhookVars(context),
      );
    } catch (error) {
      // 模板/URL 构造失败 —— 属于配置问题，同样不能拖垮主进程
      await this.logWebhookError('构建请求失败', error);
      return { ok: false, error: '构建请求失败' };
    }

    if (request.unknownVars.length > 0) {
      console.warn(
        `[Webhook] 模板里有未定义的变量：${request.unknownVars.join(', ')}（已按空值处理）`,
      );
    }

    // 超时控制：AbortController + 定时器（不依赖 AbortSignal.timeout，兼容性更好）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const reason = `目标返回 HTTP ${response.status} ${response.statusText}`;
        await this.logWebhookError(reason);
        return { ok: false, error: reason };
      }
      return { ok: true };
    } catch (error) {
      // ⚠️ 绝不能抛出：webhook 挂了不能影响告警流程，更不能让主进程崩
      const reason =
        (error as { name?: string })?.name === 'AbortError'
          ? `请求超时（${timeoutMs}ms）`
          : String((error as Error)?.message ?? error);
      await this.logWebhookError(reason, error);
      return { ok: false, error: reason };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 把 webhook 失败静默记到本地错误日志。
   *
   * 写文件失败也只忽略 —— 记日志本身绝不能变成新的故障源。
   */
  private async logWebhookError(reason: string, error?: unknown): Promise<void> {
    const line = `[${new Date().toISOString()}] webhook 失败：${reason}${
      error && !(error as Error)?.name ? ` (${String(error)})` : ''
    }`;

    // 终端里保留一份（开发态最常用）
    console.error('[Webhook] 发送失败:', reason, error ?? '');

    try {
      const { app } = await import('electron');
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const dir = app.getPath('userData');
      const file = path.join(dir, 'webhook-errors.log');
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(file, line + '\n', 'utf-8');
    } catch {
      // 拿不到 userData / 无写权限 —— 忽略，终端里已经有日志
    }
  }

  /**
   * 把告警记录转成模板变量。
   *
   * 证据 / 建议在数据库里是 JSON 字符串，这里解出来当**对象/数组**用 ——
   * 模板里写 `"evidence": {{alert_evidence}}` 才能得到真正的对象而不是字符串。
   */
  private buildWebhookVars(context: NotificationContext): Record<string, WebhookVarValue> {
    const { alert, type, duration, title } = context;

    let evidence: unknown = {};
    try {
      evidence = alert.evidence ? JSON.parse(alert.evidence) : {};
    } catch {
      evidence = alert.evidence ?? {};
    }

    let recommendations: unknown = [];
    try {
      recommendations = alert.recommendations ? JSON.parse(alert.recommendations) : [];
    } catch {
      recommendations = alert.recommendations ?? [];
    }

    return {
      alert_title: title || alert.alert_type,
      alert_detail: alert.description ?? '',
      alert_summary: alert.summary ?? '',
      alert_type: alert.alert_type,
      alert_key: alert.alert_key,
      alert_severity: alert.severity,
      alert_status: type === 'resolved' ? 'resolved' : 'firing',
      alert_time: alert.last_seen,
      alert_first_seen: alert.first_seen,
      alert_count: alert.occurrence_count,
      alert_duration: duration ?? '',
      alert_recommendations: recommendations as WebhookVarValue,
      alert_evidence: evidence as WebhookVarValue,
    };
  }


  /**
   * 邮件通道 v1.0 未实现 —— 显式抛错而非假成功。
   *
   * 假成功的危害：sendTo 返回 ok:true ⇒ 分发器认为已投递，不重试、
   * 不入离线队列、日志无异常 —— 手工在 config.json 里启用 email 的用户
   * 会静默收不到任何告警。抛错后走失败路径，日志可见
   * 「email 发送失败: Email notifications are not implemented」。
   */
  private async sendEmail(_context: NotificationContext): Promise<void> {
    throw new Error('Email notifications are not implemented');
  }

  /**
   * 获取严重程度对应的 emoji
   */
  private getSeverityEmoji(severity: string): string {
    switch (severity) {
      case 'critical':
        return '🚨';
      case 'warning':
        return '⚠️';
      case 'info':
        return 'ℹ️';
      default:
        return '🔔';
    }
  }
}