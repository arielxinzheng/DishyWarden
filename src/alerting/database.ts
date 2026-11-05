/**
 * 告警状态数据库
 * 使用 SQLite 持久化告警状态,支持去重和历史查询
 */

import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';

/**
 * 告警生命周期状态。
 *
 *   new ──► ongoing ──(条件消失)──► resolved
 *            │
 *            └──(用户标记误报)────► false_positive
 *
 * resolved 与 false_positive 都是终态，区别在于：
 * - resolved      物理故障真实发生过，duration 有意义
 * - false_positive 用户判定"根本没发生过"，duration 无意义
 *                  且该行作为负样本永久冻结，不再被采集覆盖
 */
export type AlertStatus = 'new' | 'ongoing' | 'resolved' | 'false_positive';

/**
 * 告警状态的两个互斥集合 —— 活跃视图与历史视图正好把 alerts 表二分。
 *
 * 单列常量而不是在两处各写一遍字面量：新增状态时只改这里，
 * 不会出现「活跃列表收了、历史列表漏了」这种静默空洞，
 * 也不会出现同一条告警同时出现在两个列表里。
 */
export const ACTIVE_STATUSES = ['new', 'ongoing'] as const satisfies readonly AlertStatus[];

/**
 * 终态：告警已结束，不会再变。
 * resolved       故障真实发生过，duration 有意义
 * false_positive 用户判定"根本没发生过"，作为负样本永久冻结
 */
export const TERMINAL_STATUSES = ['resolved', 'false_positive'] as const satisfies readonly AlertStatus[];

export interface AlertRecord {
  id?: number;
  alert_key: string;
  alert_type: string;
  severity: 'critical' | 'warning' | 'info';
  status: AlertStatus;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  last_notified_at: string | null;
  notification_count: number;
  summary: string;
  description: string;
  evidence: string; // JSON string — 触发瞬间的快照，误报时作为负样本保留
  recommendations: string; // JSON string
  // 降噪字段
  snooze_until?: string | null; // ISO 时间戳, 忽略直到该时刻
  snooze_type?: 'temporary' | 'until_resolved' | null; // 忽略类型
  // 注: 旧版有 marked_false_positive 布尔列，已由 status='false_positive' 取代。
  // 数据库列仍保留（避免迁移风险），但代码中不再作为真值来源，无任何读取方。
}

export type Severity = AlertRecord['severity'];
export type Status = AlertRecord['status'];

/**
 * 历史查询条件。
 *
 * 用对象而不是位置参数：维度只会越来越多（时间 / 严重度 / 状态 / 类型…），
 * 位置参数一多就没人记得住顺序，加一个还得同时改 IPC / preload / manager
 * 五层签名。契约对象加字段是纯增量。
 */
export interface AlertHistoryQuery {
  limit?: number;
  offset?: number;
  severity?: Severity;
  status?: Status;
  /**
   * 只要终态（resolved / false_positive），排除 new / ongoing。
   *
   * 历史视图**恒传 true** —— 「历史」的定义就是已经结束的告警。
   * new / ongoing 属于活跃视图（`getActiveAlerts`），
   * 只有让两个视图按 status 严格二分，同一条告警才不会既在
   * 「告警」列表又在「历史记录」列表里出现。
   *
   * 默认 false 不是笔误：保留全表查询能力给诊断脚本与统计，
   * 既有调用方（含单元测试的分页用例）依赖它能看到未结束的告警。
   * 也就是说「是否只要终态」必须由调用方显式声明，而不是靠方法名暗示。
   */
  terminalOnly?: boolean;
  /**
   * 时间下界（含），比较 last_seen。
   * ISO 8601 UTC，必须与库内存储格式一致（都是 toISOString() 产物）——
   * 同格式下字典序即时间序，可以直接比较并吃索引。
   */
  from?: string;
  /** 时间上界（含），比较 last_seen */
  to?: string;
  /**
   * 关键词，匹配 summary / description / alert_type。
   * 大小写不敏感（SQLite LIKE 对 ASCII 天然如此），空串按未提供处理。
   */
  keyword?: string;
}

export class AlertDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    // 如果提供了明确路径（包括 :memory:），直接使用
    if (dbPath) {
      this.db = new Database(dbPath);
    } else {
      // 否则使用默认路径
      const dataDir = path.join(app.getPath('userData'), 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      this.db = new Database(path.join(dataDir, 'alerts.db'));
    }
    this.initializeSchema();
  }

  private initializeSchema(): void {
    // 第一步：建表 + 只涉及原有列的索引。
    // 注意：这里绝不能引用降噪新列（snooze_until 等），否则旧库会因
    // "no such column" 让整个 exec 抛错，构造函数失败，告警模块直接起不来。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_key TEXT UNIQUE NOT NULL,
        alert_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        occurrence_count INTEGER DEFAULT 1,
        last_notified_at TEXT,
        notification_count INTEGER DEFAULT 0,
        summary TEXT NOT NULL,
        description TEXT NOT NULL,
        evidence TEXT,
        recommendations TEXT,
        snooze_until TEXT,
        snooze_type TEXT,
        marked_false_positive INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_alert_key ON alerts(alert_key);
      CREATE INDEX IF NOT EXISTS idx_status ON alerts(status);
      CREATE INDEX IF NOT EXISTS idx_severity ON alerts(severity);
      CREATE INDEX IF NOT EXISTS idx_first_seen ON alerts(first_seen);
    `);

    // 第二步：为旧库补齐降噪字段。
    this.migrateSchema();

    // 第三步：索引必须放在迁移之后，此时列一定存在。
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_snooze_until ON alerts(snooze_until);
      -- 历史页默认「最近 7 天 + 按 last_seen 倒序」，这条索引同时服务
      -- 范围过滤和排序，不加的话每次翻页都是全表扫 + 临时排序。
      CREATE INDEX IF NOT EXISTS idx_last_seen ON alerts(last_seen);
    `);
  }

  /**
   * 旧库升级：alerting 降噪字段是后加的，CREATE TABLE IF NOT EXISTS 不会补列。
   * 逐列检查，缺哪个补哪个，保证重复执行安全。
   */
  private migrateSchema(): void {
    const columns = this.db.pragma("table_info('alerts')") as Array<{ name: string }>;
    const columnNames = new Set(columns.map(c => c.name));

    const pendingColumns: Array<{ name: string; ddl: string }> = [
      { name: 'snooze_until', ddl: 'ALTER TABLE alerts ADD COLUMN snooze_until TEXT;' },
      { name: 'snooze_type', ddl: 'ALTER TABLE alerts ADD COLUMN snooze_type TEXT;' },
      { name: 'marked_false_positive', ddl: 'ALTER TABLE alerts ADD COLUMN marked_false_positive INTEGER DEFAULT 0;' },
    ];

    for (const column of pendingColumns) {
      if (!columnNames.has(column.name)) {
        this.db.exec(column.ddl);
      }
    }

    // 旧版的「误报」只是一个布尔标记，告警仍停留在活跃列表里。
    // 新状态机把误报提升为独立终态，把存量数据回填过去，避免两套真值并存。
    this.db.exec(`
      UPDATE alerts
      SET status = 'false_positive',
          marked_false_positive = 0,
          snooze_until = NULL,
          snooze_type = NULL
      WHERE marked_false_positive = 1
        AND status <> 'false_positive';
    `);
  }

  /**
   * 记录或更新告警
   * @returns 'new' | 'ongoing' | 'resolved' | 'false_positive'
   *          false_positive 表示该行已被用户标记误报，本次写入被忽略
   */
  upsertAlert(alert: Omit<AlertRecord, 'id' | 'created_at' | 'updated_at'>): AlertStatus {
    const existing = this.getAlertByKey(alert.alert_key);

    // 误报是终态：整行冻结，作为阈值调优的负样本原样保留。
    // 不能让流程落到下面的「持续触发」分支——那样 evidence 会被每轮采集
    // 覆盖成新快照、occurrence_count 无限增长，负样本就废了。
    if (existing && existing.status === 'false_positive') {
      return 'false_positive';
    }

    if (!existing) {
      // 新告警
      const stmt = this.db.prepare(`
        INSERT INTO alerts (
          alert_key, alert_type, severity, status,
          first_seen, last_seen, occurrence_count,
          last_notified_at, notification_count,
          summary, description, evidence, recommendations
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        alert.alert_key,
        alert.alert_type,
        alert.severity,
        alert.status,
        alert.first_seen,
        alert.last_seen,
        alert.occurrence_count,
        alert.last_notified_at,
        alert.notification_count,
        alert.summary,
        alert.description,
        alert.evidence,
        alert.recommendations
      );

      return 'new';
    } else if (existing.status === 'ongoing' && alert.status === 'resolved') {
      // 告警恢复（从 ongoing 到 resolved）
      const stmt = this.db.prepare(`
        UPDATE alerts
        SET status = ?, last_seen = ?, updated_at = CURRENT_TIMESTAMP
        WHERE alert_key = ?
      `);

      stmt.run(alert.status, alert.last_seen, alert.alert_key);
      return 'resolved';
    } else if (existing.status === 'resolved' && alert.status === 'ongoing') {
      // 告警重新激活（从 resolved 到 ongoing）
      // 如果恢复时间在 5 分钟内，保留原 occurrence_count（视为抖动/间歇性问题）
      const lastSeenTime = new Date(existing.last_seen).getTime();
      const nowTime = new Date(alert.last_seen).getTime();
      const isRecent = nowTime - lastSeenTime < 5 * 60 * 1000; // 5 分钟

      if (isRecent) {
        // 短时间内重新激活，保留计数
        const stmt = this.db.prepare(`
          UPDATE alerts
          SET status = ?,
              last_seen = ?,
              occurrence_count = occurrence_count + 1,
              summary = ?,
              description = ?,
              evidence = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE alert_key = ?
        `);

        stmt.run(
          alert.status,
          alert.last_seen,
          alert.summary,
          alert.description,
          alert.evidence,
          alert.alert_key
        );
        return 'ongoing'; // 视为持续问题，不重新通知
      } else {
        // 长时间后重新激活，重置计数
        const stmt = this.db.prepare(`
          UPDATE alerts
          SET status = ?,
              first_seen = ?,
              last_seen = ?,
              occurrence_count = 1,
              summary = ?,
              description = ?,
              evidence = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE alert_key = ?
        `);

        stmt.run(
          alert.status,
          alert.first_seen,
          alert.last_seen,
          alert.summary,
          alert.description,
          alert.evidence,
          alert.alert_key
        );
        return 'new'; // 视为新告警，触发通知
      }
    } else {
      // 持续触发
      const stmt = this.db.prepare(`
        UPDATE alerts
        SET occurrence_count = occurrence_count + 1,
            last_seen = ?,
            summary = ?,
            description = ?,
            evidence = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE alert_key = ?
      `);

      stmt.run(alert.last_seen, alert.summary, alert.description, alert.evidence, alert.alert_key);
      return 'ongoing';
    }
  }

  /**
   * 记录通知发送
   */
  markNotified(alertKey: string): void {
    const stmt = this.db.prepare(`
      UPDATE alerts
      SET last_notified_at = CURRENT_TIMESTAMP,
          notification_count = notification_count + 1
      WHERE alert_key = ?
    `);

    stmt.run(alertKey);
  }

  /**
   * 获取告警记录
   */
  getAlertByKey(alertKey: string): AlertRecord | undefined {
    const stmt = this.db.prepare('SELECT * FROM alerts WHERE alert_key = ?');
    return stmt.get(alertKey) as AlertRecord | undefined;
  }

  /**
   * 获取活跃告警列表
   */
  getActiveAlerts(): AlertRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM alerts
      WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
      ORDER BY severity DESC, first_seen DESC
    `);

    return stmt.all(...ACTIVE_STATUSES) as AlertRecord[];
  }

  /**
   * 忽略告警
   * @param alertKey 告警唯一标识
   * @param snoozeType 忽略类型: 'temporary' (限时) | 'until_resolved' (直到恢复)
   * @param durationMs 忽略时长(毫秒), 仅 temporary 类型需要
   */
  snoozeAlert(alertKey: string, snoozeType: 'temporary' | 'until_resolved', durationMs?: number): void {
    const snoozeUntil = snoozeType === 'temporary' && durationMs
      ? new Date(Date.now() + durationMs).toISOString()
      : null;

    const stmt = this.db.prepare(`
      UPDATE alerts
      SET snooze_until = ?,
          snooze_type = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE alert_key = ?
    `);

    stmt.run(snoozeUntil, snoozeType, alertKey);
  }

  /**
   * 取消忽略告警
   */
  unsnoozeAlert(alertKey: string): void {
    const stmt = this.db.prepare(`
      UPDATE alerts
      SET snooze_until = NULL,
          snooze_type = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE alert_key = ?
    `);

    stmt.run(alertKey);
  }

  /**
   * 标记告警为误报 —— 把告警推入终态 false_positive。
   *
   * 与「忽略」的本质区别：忽略只是暂时不提醒，告警仍在生命周期内；
   * 误报是用户否认该事件发生过，因此直接终结活跃生命周期、移入历史。
   *
   * evidence 字段不动：它保存着触发瞬间的延迟/丢包/探针状态，
   * 是后续调阈值的负样本，必须原样留在库里。
   */
  markFalsePositive(alertKey: string): void {
    // last_seen 冻结在标记时刻，让历史列表按 last_seen 排序时位置合理；
    // 同时清空 snooze 字段，避免「已终态 + 仍在忽略中」这种矛盾状态。
    const stmt = this.db.prepare(`
      UPDATE alerts
      SET status = 'false_positive',
          marked_false_positive = 0,
          snooze_until = NULL,
          snooze_type = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE alert_key = ?
        AND status IN ('new', 'ongoing')
    `);

    stmt.run(alertKey);
  }

  /**
   * 撤销误报标记，把告警退回活跃生命周期。
   * 没有这个出口，误点一次就会让该规则永久失效。
   */
  unmarkFalsePositive(alertKey: string): void {
    const stmt = this.db.prepare(`
      UPDATE alerts
      SET status = 'ongoing',
          last_seen = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE alert_key = ?
        AND status = 'false_positive'
    `);

    stmt.run(new Date().toISOString(), alertKey);
  }

  /**
   * 获取需要更新通知的告警
   * 规则: 每10次触发或每3小时发送一次更新
   */
  getAlertsNeedingUpdate(): AlertRecord[] {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

    const stmt = this.db.prepare(`
      SELECT * FROM alerts
      WHERE status = 'ongoing'
        AND (
          (occurrence_count % 10 = 0 AND occurrence_count > notification_count * 10)
          OR last_notified_at IS NULL
          OR last_notified_at < ?
        )
    `);

    return stmt.all(threeHoursAgo) as AlertRecord[];
  }

  /**
   * 清理已恢复的历史告警
   *
   * 只清理 resolved。false_positive 永不过期——它是规则引擎的负样本，
   * 删掉就再也没法回头调阈值了。
   *
   * @param daysToKeep 保留天数
   */
  cleanupResolvedAlerts(daysToKeep = 30): number {
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();

    const stmt = this.db.prepare(`
      DELETE FROM alerts
      WHERE status = 'resolved' AND last_seen < ?
    `);

    const result = stmt.run(cutoffDate);
    return result.changes;
  }

  /**
   * 历史查询的唯一实现：一次拼出 WHERE，同时给出当页数据和总数。
   *
   * 为什么把 list 和 count 合成一个方法：
   *   以前两者各拼一遍 WHERE，条件列表一旦不同步（新增筛选项只改了其中一个），
   *   列表和 total 就会对不上，翻页直接错乱。合并后结构上不可能不一致，
   *   也省掉一次重复的 WHERE 构造。
   *
   * 排序：last_seen DESC 是历史页的「绝对排序规则」——resolved 态的 last_seen
   * 就是恢复时刻，false_positive 态就是标记时刻，正是用户想看的"最近更新"。
   * 这里排一次，前端不再二次排序，避免出现第二份判据。
   */
  queryHistory(query: AlertHistoryQuery = {}): { alerts: AlertRecord[]; total: number } {
    const { limit = 100, offset = 0, severity, status, from, to } = query;
    const keyword = query.keyword?.trim();

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (severity) {
      conditions.push('severity = ?');
      params.push(severity);
    }
    // 显式 status 优先（诊断/测试用）；否则按 terminalOnly 收敛到终态集合。
    // 两者不叠加：既传 'ongoing' 又传 terminalOnly 是自相矛盾的调用，
    // 让显式值胜出，好过静默返回空列表让人以为没有数据。
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    } else if (query.terminalOnly) {
      conditions.push(`status IN (${TERMINAL_STATUSES.map(() => '?').join(',')})`);
      params.push(...TERMINAL_STATUSES);
    }
    // from/to 与 last_seen 同为 ISO 8601 UTC，同长度同格式下字典序即时间序
    if (from) {
      conditions.push('last_seen >= ?');
      params.push(from);
    }
    if (to) {
      conditions.push('last_seen <= ?');
      params.push(to);
    }
    if (keyword) {
      // 用户输入里的 % _ 是普通字符，不转义就会变成通配符：
      // 搜 "100%" 会匹配到全部记录，看起来像筛选失效。
      const escaped = keyword.replace(/[\\%_]/g, (c) => `\\${c}`);
      const like = `%${escaped}%`;
      conditions.push(
        `(summary LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR alert_type LIKE ? ESCAPE '\\')`
      );
      params.push(like, like, like);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const total = (
      this.db.prepare(`SELECT COUNT(*) as count FROM alerts ${where}`).get(...params) as {
        count: number;
      }
    ).count;

    const alerts = this.db
      .prepare(
        `SELECT * FROM alerts
         ${where}
         ORDER BY last_seen DESC, first_seen DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as AlertRecord[];

    return { alerts, total };
  }

  /**
   * @deprecated 用 queryHistory。保留位置参数签名只为不打断既有调用方与测试。
   */
  getAlertHistory(
    limit = 100,
    offset = 0,
    severityFilter?: Severity,
    statusFilter?: Status
  ): AlertRecord[] {
    return this.queryHistory({
      limit,
      offset,
      severity: severityFilter,
      status: statusFilter,
    }).alerts;
  }

  /**
   * @deprecated 用 queryHistory
   */
  getAlertCount(severityFilter?: Severity, statusFilter?: Status): number {
    return this.queryHistory({ severity: severityFilter, status: statusFilter }).total;
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    this.db.close();
  }
}
