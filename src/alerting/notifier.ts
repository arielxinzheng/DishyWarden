/**
 * 告警通知器
 * 支持多渠道通知: Telegram, Webhook, 邮件
 */

import type { AlertRecord } from './database';

export interface NotificationConfig {
  telegram?: {
    enabled: boolean;
    botToken: string;
    chatId: string;
  };
  webhook?: {
    enabled: boolean;
    url: string;
    method?: 'POST' | 'PUT';
    headers?: Record<string, string>;
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
    const { url, method = 'POST', headers = {} } = this.config.webhook!;
    const payload = this.formatWebhookPayload(context);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Webhook error: ${response.status}`);
      }
    } catch (error) {
      console.error('Failed to send Webhook notification:', error);
      throw error;
    }
  }

  /**
   * 格式化 Webhook payload
   */
  private formatWebhookPayload(context: NotificationContext) {
    const { alert, type, duration } = context;

    return {
      alert_type: alert.alert_type,
      severity: alert.severity,
      status: type === 'resolved' ? 'resolved' : 'firing',
      timestamp: alert.last_seen,
      summary: alert.summary,
      description: alert.description,
      evidence: alert.evidence ? JSON.parse(alert.evidence) : {},
      recommendations: alert.recommendations ? JSON.parse(alert.recommendations) : [],
      occurrence_count: alert.occurrence_count,
      first_seen: alert.first_seen,
      last_seen: alert.last_seen,
      duration,
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