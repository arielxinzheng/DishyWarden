/**
 * traceroute() 失败原因端到端测试。
 *
 * 背景：用户两次反馈路由跟踪「无法获取路由信息」且**没有原因**。
 * 根因：exec 成功（exit 0）但 0 跳时，旧代码不带 error；失败时只带
 * "Command failed: tracert ..."（只有命令行本身）。
 *
 * 这里 mock child_process.exec，覆盖：
 *   1. exit 0 + 0 跳 + 报错在 stderr       ⇒ error = stderr 报错行
 *   2. exit 0 + 0 跳 + 报错在 stdout       ⇒ error = stdout 报错行（Windows tracert 的行为）
 *   3. exit 1 + 报错在 stdout（GBK 编码）  ⇒ error 正确解码出中文
 *   4. 超时被 kill + 无输出                ⇒ error 写明"超时"
 *   5. 渲染层显示见 src/renderer/components/Dashboard/RouteTraceEmpty.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type ExecCb = (err: any, out?: { stdout: Buffer; stderr: Buffer }) => void;
type ExecHandler = (cmd: string, opts: unknown, cb: ExecCb) => void;
/** 每个用例自己装一个 handler（不用 vi.fn：它在本场景下会被额外以 0 参调用一次） */
const execImpl = {
  handler: null as ExecHandler | null,
  mockImplementation(h: ExecHandler) { this.handler = h; },
  mockReset() { this.handler = null; },
};

// promisify(exec) 的调用形态是 exec(cmd, opts, cb)；按"最后一个参数是回调"取，不依赖参数个数
vi.mock('child_process', () => ({
  exec: (...args: unknown[]) =>
    execImpl.handler?.(args[0] as string, args[1], args[args.length - 1] as ExecCb),
}));

const { traceroute, pickMeaningfulLine, decodeCommandOutput } = await import('./traceroute');

/** "无法解析目标系统名称 nosuch.invalid。" 的 GBK 字节 */
const GBK_UNRESOLVED = Buffer.from(
  'cedeb7a8bde2cef6c4bfb1eacfb5cdb3c3fbb3c6206e6f737563682e696e76616c6964a1a3',
  'hex',
);

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => execImpl.mockReset());
afterEach(() => setPlatform(realPlatform));

describe('traceroute() —— 0 跳必须带原因', () => {
  it('exit 0 + 0 跳 + 报错在 stderr ⇒ error 取 stderr', async () => {
    setPlatform('darwin');
    execImpl.mockImplementation((_c, _o, cb) =>
      cb(null, {
        stdout: Buffer.from(''),
        stderr: Buffer.from('traceroute: unknown host nosuch.invalid\n'),
      }),
    );
    const r = await traceroute('nosuch.invalid', { timeout: 1000 });
    expect(r.hops).toEqual([]);
    expect(r.error).toBe('traceroute: unknown host nosuch.invalid');
  });

  it('exit 0 + 0 跳 + 报错在 stdout（Windows tracert）⇒ error 取 stdout', async () => {
    setPlatform('win32');
    execImpl.mockImplementation((_c, _o, cb) =>
      cb(null, {
        stdout: Buffer.from('\r\nUnable to resolve target system name nosuch.invalid.\r\n'),
        stderr: Buffer.from(''),
      }),
    );
    const r = await traceroute('nosuch.invalid', { timeout: 1000 });
    expect(r.hops).toEqual([]);
    expect(r.error).toBe('Unable to resolve target system name nosuch.invalid.');
  });

  it('exit 0 + stdout/stderr 全空 ⇒ 仍然带兜底原因', async () => {
    setPlatform('darwin');
    execImpl.mockImplementation((_c, _o, cb) =>
      cb(null, { stdout: Buffer.from(''), stderr: Buffer.from('') }),
    );
    const r = await traceroute('x', { timeout: 1000 });
    expect(r.hops).toEqual([]);
    expect(r.error).toMatch(/没有返回任何跳/);
  });

  it('exit 1 + GBK 中文报错在 stdout ⇒ error 正确解码，带 exit code', async () => {
    setPlatform('win32');
    execImpl.mockImplementation((_c, _o, cb) =>
      cb(Object.assign(new Error('Command failed: tracert ...'), {
        code: 1,
        stdout: GBK_UNRESOLVED,
        stderr: Buffer.from(''),
      })),
    );
    const r = await traceroute('nosuch.invalid', { timeout: 1000 });
    expect(r.hops).toEqual([]);
    expect(r.error).toContain('无法解析目标系统名称');
    expect(r.error).toContain('exit code 1');
    expect(r.error).not.toContain('Command failed');
  });

  it('超时被 kill + 无输出 ⇒ error 写明超时', async () => {
    setPlatform('darwin');
    execImpl.mockImplementation((_c, _o, cb) =>
      cb(Object.assign(new Error('Command failed'), {
        killed: true,
        signal: 'SIGTERM',
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      })),
    );
    const r = await traceroute('x', { timeout: 30000 });
    expect(r.hops).toEqual([]);
    expect(r.error).toMatch(/超时（30s/);
  });

  it('exit 0 + 中文失败块（GBK）⇒ 原因不再是「到 … 的路由:」，raw 带全文', async () => {
    setPlatform('win32');
    // 解析不出跳的输出：只有说明行（例如目标完全不可达，tracert 立刻返回）
    const text = '\r\n无法访问目标主机或路由。\r\n到 example.com [203.0.113.5] 的路由:\r\n\r\n跟踪完成。\r\n';
    execImpl.mockImplementation((_c, _o, cb) =>
      cb(null, { stdout: Buffer.from(new TextEncoder().encode(text)), stderr: Buffer.from('') }),
    );
    const r = await traceroute('example.com', { timeout: 1000 });
    expect(r.hops).toEqual([]);
    expect(r.error).toBe('无法访问目标主机或路由。');
    expect(r.raw).toContain('到 example.com [203.0.113.5] 的路由:');
    expect(r.raw).toContain('无法访问目标主机或路由。');
    expect(r.raw).not.toContain('\r');
  });

  it('exit 0 + 只有「到 … 的路由:」⇒ 原因说明"有输出但没解析出跳"，raw 带原文', async () => {
    setPlatform('win32');
    execImpl.mockImplementation((_c, _o, cb) =>
      cb(null, {
        stdout: Buffer.from('\r\n通过最多 15 个跃点跟踪\r\n到 example.com [203.0.113.5] 的路由:\r\n'),
        stderr: Buffer.from(''),
      }),
    );
    const r = await traceroute('example.com', { timeout: 1000 });
    expect(r.hops).toEqual([]);
    expect(r.error).toMatch(/没有解析出任何跳/);
    expect(r.raw).toContain('到 example.com [203.0.113.5] 的路由:');
  });

  it('中文 GBK 真实输出 ⇒ 解析出 5 跳，成功路径也带 raw', async () => {
    setPlatform('win32');
    // 真正按 GBK 编码（与中文 Windows tracert 一致）
    const iconv = await import('iconv-lite');
    const text = [
      '', '通过最多 15 个跃点跟踪', '到 example.com [203.0.113.5] 的路由:', '',
      '  1    <1 毫秒   <1 毫秒   <1 毫秒 192.168.1.1 ',
      '  2     3 ms     2 ms     2 ms  10.11.80.1 ',
      '  3     *        *        *     请求超时。',
      '  4    31 ms    *       29 ms  100.64.0.1 ',
      '  5    40 ms    41 ms    40 ms  203.0.113.5 ',
      '', '跟踪完成。', '',
    ].join('\r\n');
    const gbk = iconv.encode(text, 'gbk');
    execImpl.mockImplementation((_c, _o, cb) => cb(null, { stdout: gbk, stderr: Buffer.from('') }));
    const r = await traceroute('example.com', { timeout: 1000 });
    expect(r.hops).toHaveLength(5);
    expect(r.hops.map((h) => h.ip)).toEqual([
      '192.168.1.1', '10.11.80.1', null, '100.64.0.1', '203.0.113.5',
    ]);
    expect(r.error).toBeUndefined();
    expect(r.raw).toContain('<1 毫秒');
  });

  it('超时被 kill 但已有跳 ⇒ 保留部分结果并带 raw', async () => {
    setPlatform('win32');
    execImpl.mockImplementation((_c, _o, cb) =>
      cb(Object.assign(new Error('Command failed'), {
        killed: true,
        signal: 'SIGTERM',
        stdout: Buffer.from('到 x [203.0.113.5] 的路由:\r\n  1    <1 ms    <1 ms    <1 ms  192.168.1.1 \r\n  2     *        *        *     请求超时。\r\n'),
        stderr: Buffer.from(''),
      })),
    );
    const r = await traceroute('x', { timeout: 20000 });
    expect(r.hops).toHaveLength(2);
    expect(r.raw).toContain('192.168.1.1');
  });

  it('raw 截断到 4KB', async () => {
    const { buildRawSnapshot, RAW_OUTPUT_LIMIT } = await import('./traceroute');
    const s = buildRawSnapshot('x'.repeat(RAW_OUTPUT_LIMIT + 100), '');
    expect(s.length).toBeLessThan(RAW_OUTPUT_LIMIT + 50);
    expect(s).toContain('已截断');
  });

  it('有跳时不带 error（成功路径不被误伤）', async () => {
    setPlatform('win32');
    execImpl.mockImplementation((_c, _o, cb) =>
      cb(null, {
        stdout: Buffer.from('  1    <1 ms    <1 ms    <1 ms  192.168.100.1\r\n'),
        stderr: Buffer.from(''),
      }),
    );
    const r = await traceroute('x', { timeout: 1000 });
    expect(r.hops).toHaveLength(1);
    expect(r.error).toBeUndefined();
  });
});

describe('辅助函数', () => {
  it('pickMeaningfulLine 跳过标题行与跳行', () => {
    expect(pickMeaningfulLine('Tracing route to x [1.2.3.4]\n  1  *  *  *  Request timed out.\n', '')).toBeNull();
    expect(pickMeaningfulLine('', 'some odd text')).toBe('some odd text');
  });

  it('decodeCommandOutput：UTF-8 原样、GBK 回落', () => {
    expect(decodeCommandOutput(Buffer.from('请求超时', 'utf-8'))).toBe('请求超时');
    expect(decodeCommandOutput(Buffer.from('c7ebc7f3b3accab1', 'hex'))).toBe('请求超时');
  });
});
