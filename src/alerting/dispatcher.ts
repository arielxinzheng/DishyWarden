/**
 * 本地告警分发引擎（Alert Dispatcher）。
 *
 * ## 解决的悖论
 *
 * "断网时收不到告警" —— 这是星链这类卫星链路的物理限制，不是软件能绕过的。
 * 但**软件能做的是**：别让告警在等待中卡死、别把它悄悄丢掉、也别在恢复时
 * 一次性糊 50 封邮件过去。
 *
 * ## 分流规则
 *
 * | 目标 | 判定 | 策略 |
 * |---|---|---|
 * | 内网（Home Assistant / 内网 webhook） | 主机是 `192.168.x.x` / `10.x.x.x` / `172.16-31.x.x` / `localhost` / `*.local` / 裸主机名 | **无视公网连通性，立刻全速发**，不做网络前置校验 |
 * | 公网（Telegram / 公网 SMTP / 公网 webhook） | 其它 | 发送前看网络路径：<br>· `starlink`/`backup` ⇒ 直接发<br>· `none`（完全无外网）⇒ **直接进离线队列**，不做无谓尝试 |
 *
 * `backup` 路径 = 星链不通但外网仍可达 ⇒ 流量走了多 WAN / 5G 备线 ⇒ 照发不误。
 *
 * ## 失败不阻塞
 *
 * 发送超时/连接失败一律**捕获**，把告警序列化进 SQLite 队列就返回 ——
 * 告警线程绝不因为网络问题死等。
 *
 * ## 恢复时聚合补发
 *
 * 断网期间积压的告警按**类型聚合成一条**汇总消息补发，不是一条条轰炸：
 * `🔔 网络已恢复。断网期间共发生 5 条遮挡告警，3 条丢包告警（详见控制台）。`
 */

import type { AlertDatabase } from './database';
import type { NotificationContext, Notifier, SendResult } from './notifier';
import { aggregateByType, buildRecoverySummary, queuedToAlertRecord } from './offlineQueue';
import type { NetworkPath } from './networkPath';
import type { ChannelKind } from './targetClassifier';

/** 分发器的外部依赖（便于测试注入） */
export interface DispatcherDeps {
  /** 通知发送器 */
  notifier: Notifier;
  /** 告警库（离线队列存在这里） */
  db: AlertDatabase;
  /** 当前外网路径 */
  currentPath: () => NetworkPath;
  /** 告警类型 → 中文短标签（汇总文案用） */
  labelOf: (alertType: string) => string;
}

/** 一次分发的结果统计 */
export interface DispatchResult {
  /** 直接发出去的通道 */
  sent: ChannelOutcome[];
  /** 进队列的通道 */
  queued: ChannelOutcome[];
}

export interface ChannelOutcome {
  channel: string;
  scope: 'lan' | 'public';
  ok: boolean;
  reason?: string;
}

/** 汇总补发用的告警类型标识 */
const RECOVERY_SUMMARY_TYPE = 'network_recovery_summary';

/** 通道名收敛：数据库里存的是字符串，只认这三种 */
function isChannelKind(value: string): value is ChannelKind {
  return value === 'telegram' || value === 'email' || value === 'webhook';
}

export class AlertDispatcher {
  /** 冲刷进行中标记 —— 避免恢复瞬间并发触发多次冲刷 */
  private flushing = false;

  constructor(private deps: DispatcherDeps) {}

  /**
   * 分发一条告警。
   *
   * 不抛异常：任何一个通道失败都不该影响其它通道，更不该影响告警状态机。
   */
  async dispatch(context: NotificationContext): Promise<DispatchResult> {
    const result: DispatchResult = { sent: [], queued: [] };
    const path = this.deps.currentPath();

    for (const target of this.deps.notifier.enabledTargets()) {
      // ① 内网目标：星链断网也照样立刻发，不做前置校验
      if (target.scope === 'lan') {
        const res = await this.deps.notifier.sendTo(target.kind, context);
        result.sent.push({
          channel: target.kind,
          scope: 'lan',
          ok: res.ok,
          reason: res.error,
        });
        continue;
      }

      // ② 公网目标 + 完全无外网 ⇒ 直接进离线队列（一次网络尝试都不做）
      if (path === 'none') {
        this.enqueue(target.kind, context, '无外网，暂存待补发');
        result.queued.push({
          channel: target.kind,
          scope: 'public',
          ok: true,
          reason: '无外网',
        });
        continue;
      }

      // ③ 公网目标 + 有外网 ⇒ 直接尝试发送
      const res = await this.deps.notifier.sendTo(target.kind, context);
      if (res.ok) {
        result.sent.push({ channel: target.kind, scope: 'public', ok: true });
      } else {
        this.enqueue(target.kind, context, res.error ?? '发送失败');
        result.queued.push({
          channel: target.kind,
          scope: 'public',
          ok: false,
          reason: res.error,
        });
      }
    }

    return result;
  }

  /**
   * 断网恢复后冲刷队列。
   *
   * - 按通道分别冲刷（不同通道的队列互不相干）；
   * - 每个通道只发**一条汇总**（不是 N 条）；
   * - 补发成功才标记已冲刷 —— 失败就留着，下次再试（宁可晚点补发，不要丢）。
   *
   * @returns 实际补发的条数（原始条目数）
   */
  async flushIfRecovered(): Promise<number> {
    if (this.flushing) return 0;
    if (this.deps.currentPath() === 'none') return 0;

    const pending = this.deps.db.getPendingOfflineAlerts();
    if (pending.length === 0) return 0;

    this.flushing = true;
    let flushed = 0;

    try {
      // 按通道分组
      const byChannel = new Map<string, typeof pending>();
      for (const item of pending) {
        const list = byChannel.get(item.channel) ?? [];
        list.push(item);
        byChannel.set(item.channel, list);
      }

      for (const [channel, items] of byChannel) {
        // 队列里的 channel 来自数据库（字符串），收敛成已知通道类型
        if (!isChannelKind(channel)) {
          console.error(`[Dispatcher] 队列里有未知通道「${channel}」，跳过`);
          continue;
        }
        const groups = aggregateByType(items);
        const summary = buildRecoverySummary(groups, this.deps.labelOf);

        // 用队里第一条的记录做"壳"，把正文换成汇总文案
        const template = queuedToAlertRecord(items[0]!);
        const recoveryAlert = {
          ...template,
          alert_type: RECOVERY_SUMMARY_TYPE,
          alert_key: `network_recovery:${channel}`,
          summary,
          description:
            `断网期间共积压 ${items.length} 条告警，已按类型聚合为一条汇总补发。` +
            `明细见控制台告警列表。`,
          evidence: JSON.stringify({
            queued_count: items.length,
            groups: groups.map((g) => ({ alert_type: g.alertType, count: g.count })),
          }),
        };

        const res: SendResult = await this.deps.notifier.sendTo(channel, {
          type: 'new',
          alert: recoveryAlert,
          title: '网络恢复',
        });

        if (res.ok) {
          this.deps.db.markOfflineAlertsFlushed(items.map((i) => i.id));
          flushed += items.length;
          console.log(
            `[Dispatcher] 网络恢复，补发 ${channel} 通道：${items.length} 条聚合为 1 条汇总`,
          );
        } else {
          console.error(
            `[Dispatcher] ${channel} 补发失败（${res.error ?? '未知原因'}），队列保留待下次重试`,
          );
        }
      }
    } finally {
      this.flushing = false;
    }

    // 消费完立即回收：让到下一个 tick 再执行 DELETE，不阻塞主流程。
    // 用 daysToKeep=0 —— 这批行刚补发完，原始告警仍在 alerts 表里
    // （汇总文案里的"详见控制台"指的就是它），队列行只是冗余副本，
    // 留着只会让库只增不减。
    this.scheduleImmediateQueueGC();

    return flushed;
  }

  /**
   * 即时清理已冲刷的队列行。
   *
   * 放到 setImmediate 里：DELETE 是同步的（better-sqlite3），
   * 但队列很小、删除极快，用不着为此挂起整条告警流程。
   */
  private scheduleImmediateQueueGC(): void {
    setImmediate(() => {
      try {
        const removed = this.deps.db.cleanupFlushedOfflineAlerts(0);
        if (removed > 0) {
          console.log(`[Dispatcher] 已回收 ${removed} 条冲刷过的离线队列记录`);
        }
      } catch (error) {
        console.error('[Dispatcher] 清理离线队列失败:', error);
      }
    });
  }

  /** 待补发条数 */
  pendingCount(): number {
    return this.deps.db.countPendingOfflineAlerts();
  }

  /** 告警进离线队列 */
  private enqueue(channel: string, context: NotificationContext, reason: string): void {
    try {
      this.deps.db.enqueueOfflineAlert(channel, context.alert, {
        type: context.type,
        duration: context.duration,
        title: context.title,
      });
      console.log(
        `[Dispatcher] ${channel} 通道未投递（${reason}），告警已暂存到离线队列`,
      );
    } catch (error) {
      // 连队列都写不进去（磁盘满/库损坏）—— 记日志，不能让告警流程崩
      console.error('[Dispatcher] 写入离线队列失败:', error);
    }
  }
}
