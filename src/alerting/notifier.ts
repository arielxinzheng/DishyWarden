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

export class Notifier {
  constructor(private config: NotificationConfig) {}

  /**
   * 发送通知到所有启用的渠道
   */
  async notify(context: NotificationContext): Promise<void> {
    const promises: Promise<void>[] = [];

    if (this.config.telegram?.enabled) {
      promises.push(this.sendTelegram(context));
    }

    if (this.config.webhook?.enabled) {
      promises.push(this.sendWebhook(context));
    }

    if (this.config.email?.enabled) {
      promises.push(this.sendEmail(context));
    }

    await Promise.allSettled(promises);
  }

  /**
   * Telegram 通知
   */
  private async sendTelegram(context: NotificationContext): Promise<void> {
    const { botToken, chatId } = this.config.telegram!;
    const message = this.formatTelegramMessage(context);

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
        }),
      });

      if (!response.ok) {
        throw new Error(`Telegram API error: ${response.status}`);
      }
    } catch (error) {
      console.error('Failed to send Telegram notification:', error);
      throw error;
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
  private async sendWebhook(context: NotificationContext): Promise<void> {
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
      return;
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
        await this.logWebhookError(
          `目标返回 HTTP ${response.status} ${response.statusText}`,
        );
      }
    } catch (error) {
      // ⚠️ 绝不能抛出：webhook 挂了不能影响告警流程，更不能让主进程崩
      const reason =
        (error as { name?: string })?.name === 'AbortError'
          ? `请求超时（${timeoutMs}ms）`
          : String((error as Error)?.message ?? error);
      await this.logWebhookError(reason, error);
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
   * 邮件通知 (占位,需要 nodemailer)
   */
  private async sendEmail(_context: NotificationContext): Promise<void> {
    // TODO: 实现邮件发送
    console.log('Email notification not implemented yet');
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