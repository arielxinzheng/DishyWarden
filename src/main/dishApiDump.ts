/**
 * `--dump-dish-api` 诊断模式：让设备自己回答「支持哪些 oneof 分支」。
 *
 * 背景：某台真机（Windows 侧 192.168.100.1:9200）对 `getHistory` 返回
 * `12 UNIMPLEMENTED` —— 网络与 proto 都对（reflection 能拿到描述符），
 * 只是这台固件用的分支名不一样（同一台机器的遮挡图分支就叫
 * `dishGetObstructionMap`，带 dish 前缀）。
 *
 * 这个模式会：
 *   1. 打印 reflection 拿到的描述符里出现的候选字段名（启发式，供人看）
 *   2. 逐个尝试候选分支，打印每个分支的 gRPC 结果与响应顶层键
 *   3. 给出「这台设备实际支持哪些分支」的结论
 *
 * 用法（打包版）：
 *   DishyWarden.exe --dump-dish-api --enable-logging
 *   DishyWarden.exe --dump-dish-api --dish-ip 192.168.100.1 --dish-port 9200
 * 输出走 stdout（配 --enable-logging 会同时进日志文件）。
 */

import { DishGrpcClient } from '../core/dishGrpc';

/** 常见分支名候选（覆盖 get* / dishGet* 两种命名风格） */
const CANDIDATES = [
  'getStatus',
  'dishGetStatus',
  'getHistory',
  'dishGetHistory',
  'getStats',
  'dishGetStats',
  'getDebugStats',
  'dishGetDebugStats',
  'getChannelArray',
  'dishGetChannelArray',
  'getObstructionMap',
  'dishGetObstructionMap',
  'getInfo',
  'dishGetInfo',
];

function line(s = ''): void {
  console.log(s);
}

export interface DishApiDumpOptions {
  host: string;
  port: number;
  /** 每个分支的超时（毫秒） */
  timeoutMs?: number;
  /** 总时间预算（毫秒），超时后不再继续探测 */
  budgetMs?: number;
}

/**
 * 跑一次 API 探测。**不抛错** —— 诊断工具要把所有信息打全，
 * 最后由调用方决定退出码。
 */
export async function runDishApiDump(opts: DishApiDumpOptions): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  // 总预算：诊断必须自己结束，不能让用户干等
  const budgetMs = opts.budgetMs ?? 90000;
  const deadline = Date.now() + budgetMs;
  const client = new DishGrpcClient(opts.host, opts.port);

  line('=== Dish API 探测 (--dump-dish-api) ===');
  line(`address: ${opts.host}:${opts.port}`);
  line('');

  line('[1] reflection：取设备自己的 proto 描述符');
  try {
    const fields = await client.describeRequestFields();
    if (fields.length) {
      line(`    Request 消息的字段（这台固件的真实分支名与字段号，共 ${fields.length} 个）:`);
      // 只打印与我们要用的语义相关的，避免刷屏
      const interesting = fields.filter(
        (f) => /history|status|obstruction|device_info|ping/i.test(f.name),
      );
      const show = interesting.length ? interesting : fields.slice(0, 20);
      for (const f of show) {
        line(`      #${String(f.number).padStart(5)}  ${f.name}  (json: ${f.jsonName})`);
      }
      if (!interesting.length) {
        line('      (没有名字含 history/status/obstruction 的字段 —— ' +
          '这台固件的分支命名可能完全不同)');
      }
    } else {
      const names = await client.describeDeclaredNames();
      line(`    描述符里出现的消息名 (${names.length}):`);
      line('    ' + (names.length ? names.join(', ') : '(没扫到候选名)'));
    }
  } catch (err) {
    line('    反射失败: ' + (err instanceof Error ? err.message : String(err)));
    line('    ⇒ 设备可能没开 reflection 服务，或 proto 里没有 ' +
      'SpaceX.API.Device.Request 这个符号。');
  }
  line('');

  // 「有数据」才算可用：DishyMock 对未知分支会回一个只有 apiVersion 的空响应，
  // 只看"有没有报错"会把空响应误判成成功。
  const DATA_KEYS = ['dishGetStatus', 'dishGetHistory', 'dishGetObstructionMap'];

  const runPass = async (transport: 'native' | 'web', label: string) => {
    line(`[2] 逐个尝试候选分支 —— ${label}`);
    let results: Awaited<ReturnType<DishGrpcClient['probeBranches']>> = [];
    try {
      // 预算吃紧就少试几个候选，别让诊断挂住
      const remaining = deadline - Date.now();
      const candidates = remaining < timeoutMs * 2
        ? CANDIDATES.slice(0, 3)
        : CANDIDATES;
      if (candidates.length < CANDIDATES.length) {
        line('    (时间预算不够，只试前 ' + candidates.length + ' 个候选)');
      }
      results = await client.probeBranches(candidates, timeoutMs, transport);
    } catch (err) {
      line('    探测过程失败: ' + (err instanceof Error ? err.message : String(err)));
    }
    for (const r of results) {
      const hasData = r.keys.some((k) => DATA_KEYS.includes(k));
      if (r.ok && hasData) {
        line(`    ${r.name.padEnd(24)} -> 可用      响应顶层键: ${r.keys.join(', ')}`);
      } else if (r.ok) {
        line(`    ${r.name.padEnd(24)} -> 空响应    顶层键: ${r.keys.join(', ') || '(空)'}`);
      } else {
        const code = r.code === 12 ? 'UNIMPLEMENTED' : `code ${r.code}`;
        line(`    ${r.name.padEnd(24)} -> ${code.padEnd(12)} ${r.message.slice(0, 110)}`);
      }
    }
    line('');
    return results;
  };

  const native = await runPass('native', '原生 gRPC (9200, HTTP/2)');
  const web = await runPass('web', 'grpc-web (9201, HTTP/1.1)');

  line('[3] 结论');
  const usableOf = (rs: typeof native) =>
    rs.filter((r) => r.ok && r.keys.some((k) => DATA_KEYS.includes(k))).map((r) => r.name);

  const nativeOk = usableOf(native);
  const webOk = usableOf(web);
  if (nativeOk.length === 0 && webOk.length === 0) {
    line('    两条通道都没有拿到数据 —— 先查网络/代理（见 verify-dish.ps1 的三条判据）。');
  } else {
    if (nativeOk.length) line('    原生 gRPC(9200) 可用分支: ' + nativeOk.join(', '));
    else line('    原生 gRPC(9200) 没有可用分支（很可能就是 UNIMPLEMENTED 那个问题）');
    if (webOk.length) line('    grpc-web(9201)  可用分支: ' + webOk.join(', '));
    line('    ⇒ 应用会自动优先用原生通道，失败时自动切 grpc-web（已内置）。');
  }

  client.close();
}
