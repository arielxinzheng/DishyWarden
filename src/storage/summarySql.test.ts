import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database as SqlJsDb, SqlJsStatic } from 'sql.js';
import path from 'node:path';
import { DDL } from './schema';
import { ESTIMATED_BYTES_SQL } from './summarySql';

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs({
 locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
});

/** 创建空库 + 建表，返回一个可用的 sql.js Database。 */
function makeDb(): SqlJsDb {
  const db = new SQL.Database();
  db.run(DDL);
  return db;
}

/** 插入一条样本（只填流量估算需要的 NOT NULL 列）。 */
function insert(db: SqlJsDb, ts: number, downBps: number, upBps: number) {
  db.run(
 `INSERT INTO telemetry_samples
 (ts, state, latency_ms, drop_rate, down_bps, up_bps, snr,
 fraction_obstructed, currently_obstructed)
     VALUES (?,?,?,?,?,?,?,?,0)`,
    [ts, 'ONLINE', 20, 0, downBps, upBps, 8, 0.01],
  );
}

/** 执行 ESTIMATED_BYTES_SQL 并返回 {down_bytes, up_bytes}。 */
function queryBytes(
  db: SqlJsDb,
  nominalSec: number,
  capSec: number,
  fromMs: number,
  toMs: number,
): { down_bytes: number; up_bytes: number } {
  const stmt = db.prepare(ESTIMATED_BYTES_SQL);
  stmt.bind([nominalSec, capSec, fromMs, toMs]);
  stmt.step();
  const row = stmt.getAsObject() as { down_bytes: number; up_bytes: number };
  stmt.free();
  return row;
}

describe('ESTIMATED_BYTES_SQL — 按样本间隔计流量，不跨间隙外推', () => {
  it('密集均匀采样：结果 ≈ 均值 × 覆盖时长 ÷ 8（与旧公式一致）', () => {
    const db = makeDb();
    const NOMINAL = 30;
    const BPS = 160; // down: 160 bps → 每拍 30s = 600 bytes
    const UPS = 80;  // up:   80 bps → 每拍 30s = 300 bytes
    // 10 拍，每 30s 一拍，t = 0..270
    for (let i = 0; i < 10; i++) insert(db, i * 30_000, BPS, UPS);

    const r = queryBytes(db, NOMINAL, NOMINAL * 2, 0, 10_000_000);
    // 首拍（无 LAG）→ COALESCE → nominal=30 → 600 bytes
    // 后 9 拍 → gap=30 → 600 bytes × 9 = 5400
    // down 总 = 6000; up 总 = 3000
    expect(r.down_bytes).toBe(6000);
    expect(r.up_bytes).toBe(3000);
 db.close();
  });

  it('跨大间隙（模拟停机/重启）：间隙后的首拍最多只计 cap 秒，不外推', () => {
    const db = makeDb();
    const NOMINAL = 30;
    const BPS = 16; // → 每正常拍 30s = 60 bytes；cap=60s → 120 bytes
    const UPS = 8;  // →30 / 60

    // 簇 A: t = 0..270 (10 拍, 30s 间隔)
    for (let i = 0; i < 10; i++) insert(db, i * 30_000, BPS, UPS);
    // 大间隙 3600s（停机 1h）
    // 簇 B: t = 3870, 3900 (2 拍)
    insert(db, 3_870_000, BPS, UPS);
    insert(db, 3_900_000, BPS, UPS);

    const r = queryBytes(db, NOMINAL, NOMINAL * 2, 0, 10_000_000);
    // down:
 //   簇 A 首拍 → nominal=30 → 16×30/8 = 60
    //   簇 A 后 9 拍 → 60 × 9 = 540
    //   簇 B 首拍 → gap=3600, cap=60 → 16×60/8 = 120
    //   簇 B 末拍 → gap=30 → 60
    //   total = 60+540+120+60 = 780
    expect(r.down_bytes).toBe(780);
    expect(r.up_bytes).toBe(390); // 30+270+60+30
    db.close();
  });

  it('窗口外的样本不计入（WHERE ts >= ? AND ts <= ? 生效）', () => {
    const db = makeDb();
    const NOMINAL = 30;
    insert(db, -60_000, 999, 999); // 窗口外（前）
    for (let i = 0; i < 5; i++) insert(db, i * 30_000, 16, 8);
    insert(db, 999_999_000, 999, 999); // 窗口外（后）

    const r = queryBytes(db, NOMINAL, NOMINAL * 2, 0, 500_000);
    // 只有5 拍在窗口内：首拍 60 + 4×60 = 300 (down); up = 30 + 4×30 = 150
    expect(r.down_bytes).toBe(300);
    expect(r.up_bytes).toBe(150);
    db.close();
  });

  it('空窗口返回 0（COALESCE 兜底）', () => {
    const db = makeDb();
    const r = queryBytes(db, 30, 60, 0, 10_000_000);
    expect(r.down_bytes).toBe(0);
    expect(r.up_bytes).toBe(0);
    db.close();
  });
});
