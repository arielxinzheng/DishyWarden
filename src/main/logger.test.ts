import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dateStamp, formatArgs, formatLine, pruneOldLogs } from './logger';

describe('logger helpers', () => {
  it('formatArgs 对 Error 打出堆栈而不是 "[object Object]"', () => {
    const err = new Error('boom');
    const out = formatArgs(['oops', err]);
    expect(out).toContain('oops');
    // util.inspect 会带上 stack 的首行（至少有 Error: boom）
    expect(out).toMatch(/Error: boom/);
  });

  it('formatLine 固定前缀：时间戳 + 对齐的 level + 内容', () => {
    const line = formatLine('WARN', ['msg'], new Date('2026-11-15T10:23:45.123Z'));
    // 时间戳是本地时区，不能硬断言分秒；但结构可断言
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[WARN \] msg\n$/);
  });

  it('dateStamp 产出 YYYYMMDD 8 位', () => {
    const s = dateStamp(new Date('2026-11-15T01:02:03Z'));
    expect(s).toMatch(/^\d{8}$/);
  });

  it('pruneOldLogs 只删超期且命名匹配的文件，别的文件原样保留', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-log-'));
    try {
      const now = new Date('2026-11-15T00:00:00Z');
      const old = `dishywarden-${dateStamp(new Date(now.getTime() - 30 * 86400000))}.log`;
      const fresh = `dishywarden-${dateStamp(now)}.log`;
      const unrelated = 'notes.txt';
      for (const n of [old, fresh, unrelated]) {
        fs.writeFileSync(path.join(dir, n), 'x');
      }
      pruneOldLogs(dir, now, 14);
      expect(fs.existsSync(path.join(dir, old))).toBe(false);
      expect(fs.existsSync(path.join(dir, fresh))).toBe(true);
      expect(fs.existsSync(path.join(dir, unrelated))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
