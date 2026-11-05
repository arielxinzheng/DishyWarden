/**
 * 告警状态数据库
 * 使用 SQLite 持久化告警状态,支持去重和历史查询
 */

import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';

export interface AlertRecord {
  id?: number;
  alert_key: string;
  alert_type: string;
  severity: 'critical' | 'warning' | 'info';
  status: 'new' | 'ongoing' | 'resolved';
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  last_notified_at: string | null;
  notification_count: number;
  summary: string;
  description: string;
  evidence: string; // JSON string
  recommendations: string; // JSON string
  // 降噪字段
  snooze_until?: string | null; // ISO 时间戳, 忽略直到该时刻
  snooze_type?: 'temporary' | 'until_resolved' | null; // 忽略类型
  marked_false_positive?: boolean; // 是否标记为误报
}

export type Severity = AlertRecord['severity'];
export type Status = AlertRecord['status'];

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
      CREATE INDEX IF NOT EXISTS idx_snooze_until ON alerts(snooze_until);
    `);
  }

  /**
   * 记录或更新告警
   * @returns 'new' | 'ongoing' | 'resolved'
   */
  upsertAlert(alert: Omit<AlertRecord, 'id' | 'created_at' | 'updated_at'>): 'new' | 'ongoing' | 'resolved' {
    const existing = this.getAlertByKey(alert.alert_key);

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
      WHERE status IN ('new', 'ongoing')
      ORDER BY severity DESC, first_seen DESC
    `);

    return stmt.all() as AlertRecord[];
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
   * 标记告警为误报
   */
  markFalsePositive(alertKey: string): void {
    const stmt = this.db.prepare(`
      UPDATE alerts
      SET marked_false_positive = 1,
          snooze_until = NULL,
          snooze_type = 'until_resolved',
          updated_at = CURRENT_TIMESTAMP
      WHERE alert_key = ?
    `);

    stmt.run(alertKey);
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
   * 获取告警历史（包括已恢复）
   * @param limit 最多返回条数
   * @param offset 偏移量（分页）
   * @param severityFilter 可选的严重程度筛选
   * @param statusFilter 可选的状态筛选
   */
  getAlertHistory(
    limit = 100,
    offset = 0,
    severityFilter?: Severity,
    statusFilter?: Status
  ): AlertRecord[] {
    let sql = `
      SELECT * FROM alerts
      WHERE 1=1
    `;
    const params: (string | number)[] = [];

    if (severityFilter) {
      sql += ` AND severity = ?`;
      params.push(severityFilter);
    }

    if (statusFilter) {
      sql += ` AND status = ?`;
      params.push(statusFilter);
    }

    sql += `
      ORDER BY last_seen DESC, first_seen DESC
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as AlertRecord[];
  }

  /**
   * 获取告警总数（用于分页）
   * @param severityFilter 可选的严重程度筛选
   * @param statusFilter 可选的状态筛选
   */
  getAlertCount(
    severityFilter?: Severity,
    statusFilter?: Status
  ): number {
    let sql = `SELECT COUNT(*) as count FROM alerts WHERE 1=1`;
    const params: string[] = [];

    if (severityFilter) {
      sql += ` AND severity = ?`;
      params.push(severityFilter);
    }

    if (statusFilter) {
      sql += ` AND status = ?`;
      params.push(statusFilter);
    }

    const stmt = this.db.prepare(sql);
    const result = stmt.get(...params) as { count: number };
    return result.count;
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    this.db.close();
  }
}
