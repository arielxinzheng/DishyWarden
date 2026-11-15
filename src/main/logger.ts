/**
 * 主进程文件日志（UTF-8）+ 进程级异常捕获。
 *
 * ## 为什么必须有
 *
 * Electron GUI 程序在 Windows 上**双击启动没有控制台** ⇒ `console.*` 输出直接丢失；
 * "窗口没出来"的现场里，主进程打出的错误**根本没落地**，排查无从谈起。
 *
 * 另：Windows 控制台/PowerShell 管道默认按 **GBK(936)** 解码，我们输出的是
 * UTF-8 ⇒ `鎺㈡祴` 乱码。GUI 进程没有自己的控制台，`SetConsoleOutputCP(65001)`
 * 无从调用 ⇒ **中文只靠文件承载**：文件固定 UTF-8（新文件带 BOM），
 * 每次启动写一行 `encoding: UTF-8` 提示，用 GBK 打开也能看到该改编码。
 *
 * ## 设计约定
 *
 * - **同步追加**（`appendFileSync`）：诊断模式结束就 `app.exit(0)`、崩溃时进程
 *   直接没了 —— 异步 WriteStream 的缓冲会丢，恰恰丢的是最关键的最后几行。
 *   30s 一轮的写入，同步开销可以忽略。
 * - **日志自身失败只能吞**：异常处理器里再抛等于彻底无救。
 * - **stdout/stderr 写失败不能崩**：重定向到管道而读端关了会 EPIPE。
 */

import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { app, dialog } from 'electron';

type Level = 'INFO' | 'WARN' | 'ERROR';
const RETENTION_DAYS = 14;

let filePath: string | null = null;
let consolePatched = false;
let handlersInstalled = false;
let fatalDialogShown = false;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function dateStamp(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function timestamp(d = new Date()): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

export function formatArgs(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'string'
      ? a
      : util.inspect(a, { depth: 4, breakLength: Infinity, colors: false })))
    .join(' ');
}

export function formatLine(level: Level, args: unknown[], d = new Date()): string {
  return `[${timestamp(d)}] [${level.padEnd(5)}] ${formatArgs(args)}\n`;
}

function append(text: string): void {
  if (!filePath) return;
  try { fs.appendFileSync(filePath, text, { encoding: 'utf8' }); } catch { /* ignore */ }
}

function writeLine(level: Level, args: unknown[]): void {
  append(formatLine(level, args));
}

/** 删掉命名符合 dishywarden-YYYYMMDD.log 且超过保留期的旧文件 */
export function pruneOldLogs(dir: string, now = new Date(), keepDays = RETENTION_DAYS): void {
  const cutoff = dateStamp(new Date(now.getTime() - keepDays * 86400000));
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const m = /^dishywarden-(\d{8})\.log$/.exec(name);
    if (m && m[1] < cutoff) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* ignore */ }
    }
  }
}

/** 管道读端关闭时 stdout 会抛 EPIPE —— 挂个 noop 不让它把主进程带走 */
function guardStdio(): void {
  for (const s of [process.stdout, process.stderr]) {
    try { s?.on?.('error', () => { /* swallow */ }); } catch { /* ignore */ }
  }
}

/**
 * 打开日志文件并接管 console（原输出保留，再追加一份到文件）。
 * 调用方必须保证 `app.getPath('userData')` 可用（`pinUserDataDir()` 之后）。
 */
export function initFileLogger(): string | null {
  if (filePath) return filePath;
  guardStdio();
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    pruneOldLogs(dir);
    const target = path.join(dir, `dishywarden-${dateStamp()}.log`);
    // 新文件写 UTF-8 BOM：记事本等老编辑器靠它识别编码
    if (!fs.existsSync(target)) fs.writeFileSync(target, '﻿', { encoding: 'utf8' });
    filePath = target;
  } catch (err) {
    try { process.stderr.write(`[logger] cannot open log file: ${String(err)}\n`); } catch { /* ignore */ }
    return null;
  }

  append(
    `===== DishyWarden ${app.getVersion()} start ${timestamp()} ` +
      `pid=${process.pid} platform=${process.platform} arch=${process.arch} ` +
      `packaged=${app.isPackaged} (encoding: UTF-8 / 本文件是 UTF-8 编码) =====\n` +
      `argv: ${JSON.stringify(process.argv)}\n`,
  );

  if (!consolePatched) {
    consolePatched = true;
    const orig = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };
    const safe = (fn: (...a: unknown[]) => void, a: unknown[]) => {
      try { fn(...a); } catch { /* 控制台不可用 */ }
    };
    console.log = (...a: unknown[]) => { safe(orig.log, a); writeLine('INFO', a); };
    console.info = (...a: unknown[]) => { safe(orig.info, a); writeLine('INFO', a); };
    console.warn = (...a: unknown[]) => { safe(orig.warn, a); writeLine('WARN', a); };
    console.error = (...a: unknown[]) => { safe(orig.error, a); writeLine('ERROR', a); };
  }
  return filePath;
}

export function getLogFilePath(): string | null {
  return filePath;
}

/**
 * 弹一个**用户看得见**的错误框，并告诉用户日志在哪。
 * `dialog.showErrorBox` 在 ready 之前就能调。只弹一次，避免连环刷屏。
 */
export function showFatalDialog(title: string, detail: string): void {
  if (fatalDialogShown) return;
  fatalDialogShown = true;
  const where = filePath ? `\n\n日志文件 (UTF-8):\n${filePath}` : '';
  try { dialog.showErrorBox(title, `${detail}${where}`); } catch { /* ignore */ }
}

/**
 * 进程级异常捕获。
 *
 * ⚠️ 挂了 `uncaughtException` 后，Electron **不再**弹它默认的错误框
 * ⇒ 这里必须自己弹，否则反而比不挂更"静默"。
 * unhandledRejection 默认既不退出也不弹 ⇒ 至少得记日志。
 */
export function installProcessHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  guardStdio();
  process.on('uncaughtException', (err) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    try { process.stderr.write(`[uncaughtException] ${msg}\n`); } catch { /* ignore */ }
    writeLine('ERROR', ['[uncaughtException]', msg]);
    showFatalDialog('DishyWarden 主进程异常', `${msg.split('\n').slice(0, 10).join('\n')}`);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    try { process.stderr.write(`[unhandledRejection] ${msg}\n`); } catch { /* ignore */ }
    writeLine('ERROR', ['[unhandledRejection]', msg]);
  });
}

/** 诊断模式下把一行**同时**写 stdout 和日志；双击启动时至少文件里能看到。 */
export function dualLine(s: string): void {
  try { process.stdout.write(s + '\n'); } catch { /* no console */ }
  writeLine('INFO', [s]);
}
