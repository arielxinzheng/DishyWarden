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
 * 输出同时写 stdout 与 %APPDATA%\DishyWarden\logs\dishywarden-<yyyyMMdd>.log（UTF-8）。
 */

import { DishGrpcClient } from '../core/dishGrpc';
import { dualLine } from './logger';

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
  // 设置页「从星链终端读取」位置用：诊断时直接看到它是可用 / PERMISSION_DENIED(7) / 不支持
  'getLocation',
  'getDeviceInfo',
];

/**
 * 每行同时写 stdout 与 UTF-8 日志文件：双击启动没有控制台，
 * 只写 stdout 用户什么也看不到（见 logger.ts）。
 */
function line(s = ''): void {
  dualLine(s);
}

/** 应用实际采集用到的三个分支：兜底通道只验证这几个，不再把 14 个候选全跑一遍 */
const CORE_BRANCHES = ['getStatus', 'getHistory', 'dishGetObstructionMap'];

export interface DishApiDumpOptions {
  host: string;
  port: number;
  /** grpc-web 兜底端口（默认 9201） */
  webPort?: number;
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
  // 必须把 webPort 传进去：不传就固定打 9201，设置里改过 grpc-web 端口时诊断测的不是应用实际用的端口
  const client = new DishGrpcClient(opts.host, opts.port, opts.webPort);

  line('=== Dish API 探测 (--dump-dish-api) ===');
  line(`address: ${opts.host}:${opts.port}`);
  line(
    'ports: ' + opts.port + ' = 原生 gRPC (HTTP/2, reflection 在这里, Handle 兜底) | ' +
    (opts.webPort ?? 9201) + ' = grpc-web (HTTP/1.1, Handle 主通道)',
  );
  line('设置页「端口」请填 ' + opts.port + '（reflection 用）；grpc-web 端口默认 9201，一般不用改。');
  line('');

  line('传输优先级: grpc-web(9201) 主 / 原生 gRPC(9200) 兜底');
  line('  （与 dishylink 一致：真机 9200 Handle 全回 UNIMPLEMENTED，9201 才可用）');
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

  const runPass = async (transport: 'native' | 'web', label: string, list: string[]) => {
    line(`[2] 逐个尝试候选分支 —— ${label}`);
    let results: Awaited<ReturnType<DishGrpcClient['probeBranches']>> = [];
    try {
      // 预算吃紧就少试几个候选，别让诊断挂住
      const remaining = deadline - Date.now();
      const candidates = remaining < timeoutMs * 2
        ? list.slice(0, 3)
        : list;
      if (candidates.length < list.length) {
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

  // 主通道先跑全量候选；兜底通道只验证应用实际用到的分支
  const web = await runPass('web', `grpc-web (${opts.webPort ?? 9201}, HTTP/1.1) —— 主通道`, CANDIDATES);
  const native = await runPass('native', `原生 gRPC (${opts.port}, HTTP/2) —— 兜底，只验证核心分支`, CORE_BRANCHES);

  line('[3] 结论');
  const usableOf = (rs: typeof native) =>
    rs.filter((r) => r.ok && r.keys.some((k) => DATA_KEYS.includes(k))).map((r) => r.name);

  const nativeOk = usableOf(native);
  const webOk = usableOf(web);
  if (nativeOk.length === 0 && webOk.length === 0) {
    line('    两条通道都没有拿到数据 —— 先查网络/代理（见 verify-dish.ps1 的三条判据）。');
  } else {
    if (webOk.length) line('    grpc-web(主)  可用分支: ' + webOk.join(', '));
    else line('    grpc-web(主)  没有可用分支');
    if (nativeOk.length) line('    原生(兜底)    可用分支: ' + nativeOk.join(', '));
    else line('    原生(兜底)    没有可用分支（这台固件 9200 的 Handle 回 UNIMPLEMENTED 属已知现象）');
    line('    ⇒ 传输优先级：应用先走 grpc-web，失败才试原生；原生成功后改为原生优先。');
  }

  client.close();
}
