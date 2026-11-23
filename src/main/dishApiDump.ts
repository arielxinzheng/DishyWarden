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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DishGrpcClient } from '../core/dishGrpc';
import { DishClient } from '../core/dishClient';
import { analyzeOutages } from '../core/outageAnalyzer';
import { dualLine, getLogFilePath } from './logger';

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
  collected.push(s);
  dualLine(s);
}

/**
 * 本轮诊断的完整输出。
 *
 * 用户要把它发回来 —— 日志文件里混着采集器/告警/Chromium 的噪声,
 * 从头翻很难滤。所以单独攒一份, 结束时写到桌面上的一个 txt。
 */
const collected: string[] = [];

/** 把整份输出写成一个独立文件, 返回路径（失败返回 null）。 */
function writeReport(): string | null {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14);
  const name = `dishywarden-diagnostics-${stamp}.txt`;
  // 桌面最方便用户找到；桌面不可写（企业策略/沙箱）时退到日志目录，再退到临时目录
  const candidates = [path.join(os.homedir(), 'Desktop'), path.dirname(getLogFilePath() ?? ''), os.tmpdir()];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      if (!fs.existsSync(dir)) continue;
      const target = path.resolve(dir, name);
      fs.writeFileSync(target, collected.join('\n') + '\n', 'utf8');
      return target;
    } catch {
      // 换下一个候选目录
    }
  }
  return null;
}

/**
 * 递归打印一个响应对象，供「设备到底发了哪些字段」这类问题破案用。
 *
 * 只展开到 depth 层：gRPC 响应可能很深（历史数组里几千个采样点），
 * 全展开会把日志刷爆。数组取前 5 项 —— 波束/时间戳这类标量都在顶层附近。
 */
function dumpValue(value: unknown, indent: string, depth: number): void {
  const clip = (s: string) => (s.length > 160 ? s.slice(0, 160) + '…' : s);
  if (value === null) {
    line(`${indent}null`);
    return;
  }
  if (Array.isArray(value)) {
    line(`${indent}[${value.length} 项]`);
    if (depth >= 3) return;
    for (const item of value.slice(0, 5)) {
      dumpValue(item, indent + '  ', depth + 1);
    }
    if (value.length > 5) line(`${indent}  … 其余 ${value.length - 5} 项省略`);
    return;
  }
  if (typeof value === 'object') {
    if (depth >= 3) {
      line(clip(indent + JSON.stringify(value)));
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object') {
        line(`${indent}${k}:`);
        dumpValue(v, indent + '  ', depth + 1);
      } else {
        line(`${indent}${k} = ${clip(JSON.stringify(v))}`);
      }
    }
    return;
  }
  line(clip(`${indent}${JSON.stringify(value)}`));
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

  line('[3] 波束指向（卫星雷达的紫色十字）与中断事件（卫星切换的来源）');
  line('');

  // ---- 3a. status 里的波束指向字段 ----
  try {
    const status = await client.getStatus(timeoutMs);
    const keys = Object.keys(status);
    line(`    status 顶层键共 ${keys.length} 个`);
    const hit = keys.filter((k) => /bore|point|align|azim|elev|beam/i.test(k));
    if (hit.length) {
      line('    与波束指向相关的顶层字段:');
      for (const k of hit) {
        line(`      ${k} = ${JSON.stringify(status[k])}`);
      }
    } else {
      line('    (顶层没有 bore/point/align/azim/elev/beam 相关字段)');
    }
    // alignmentStats 是设备实际放波束的地方, 整个对象打出来
    const stats = status.alignmentStats ?? status.alignment_stats;
    if (stats && typeof stats === 'object') {
      line('    alignmentStats = ' + JSON.stringify(stats));
    } else {
      line('    (status 里没有 alignmentStats 对象)');
    }

    // ---- 3a-2. 应用**实际会读到**的值 ----
    //
    // 这一段是整份报告的核心：它复刻 dishClient.parseStatus 的取值规则，
    // 直接回答「雷达页拿到的波束是 undefined 还是数」。
    // 只打原始键名不够 —— 字段可能藏在别的分支里。
    const readNum = (v: unknown): number | undefined => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    };
    const align = (status.alignmentStats ?? status.alignment_stats ?? {}) as Record<string, unknown>;
    const az =
      readNum(status.boresightAzimuthDeg) ??
      readNum(align.desiredBoresightAzimuthDeg) ??
      readNum(align.desired_boresight_azimuth_deg);
    const el =
      readNum(status.boresightElevationDeg) ??
      readNum(align.desiredBoresightElevationDeg) ??
      readNum(align.desired_boresight_elevation_deg);
    line('');
    line(`    ★ 应用会读到: 方位 ${az ?? 'undefined'} / 仰角 ${el ?? 'undefined'}`);
    if (az === undefined || el === undefined) {
      line('    ⇒ 雷达图不会画紫色十字, 也不会估算服务卫星。');
      line('    ⇒ 下面「status 完整内容」里找波束真正的字段名。');
    } else {
      line('    ⇒ 有波束值: 图上应该有紫色十字; 若没有, 是渲染问题不是数据问题。');
    }

    line('');
    line('    —— status 完整内容 (深度 3, 数组取前 5 项, 值超 160 字截断) ——');
    dumpValue(status, '      ', 0);
  } catch (err) {
    line('    读 status 失败: ' + (err instanceof Error ? err.message : String(err)));
  }
  line('');

  // ---- 3c. 应用解析后的 telemetry ----
  //
  // 这是**渲染层通过 IPC 真正拿到的对象**。前面 3a 看的是设备原始响应，
  // 这里看的是解析结果 —— 两者不一致时，问题就在 dishClient.parseStatus。
  try {
    const dc = new DishClient({
      address: opts.host,
      grpcPort: opts.port,
      grpcWebPort: opts.webPort,
      timeout: timeoutMs,
    });
    const t = await dc.getTelemetry();
    line('    —— 应用解析后的 telemetry（渲染层拿到的对象）——');
    line(`      boresightAzimuthDeg   = ${t.boresightAzimuthDeg ?? 'undefined'}`);
    line(`      boresightElevationDeg = ${t.boresightElevationDeg ?? 'undefined'}`);
    line(`      satelliteId           = ${t.satelliteId ?? 'undefined'}`);
    line(`      alignmentStats        = ${JSON.stringify(t.alignmentStats ?? null)}`);
        if (t.boresightAzimuthDeg === undefined || t.boresightElevationDeg === undefined) {
      line('    ⇒ 渲染层拿到的波束是 undefined —— 火箭图不画十字、也不估算服务卫星。');
      line('    ⇒ 问题在 dishClient.parseStatus: 设备发的字段名和解析代码对不上。');
    } else {
      line('    ⇒ 渲染层能拿到波束。若图上仍无紫色十字, 是渲染层问题。');
    }
  } catch (err) {
    line('    解析 telemetry 失败: ' + (err instanceof Error ? err.message : String(err)));
  }
  line('');

  // ---- 3b. history 里的中断事件 ----
  try {
    const history = await client.getHistory(timeoutMs);
    const outages = Array.isArray(history.outages) ? (history.outages as unknown[]) : [];
    line(`    history 顶层键: ${Object.keys(history).join(', ')}`);
    line(`    outages 事件数: ${outages.length}`);
    for (const o of outages.slice(0, 3)) {
      line('      原始: ' + JSON.stringify(o));
    }
    if (outages.length > 0) {
      // 用应用同一套判定跑一遍, 直接看出「有没有被认成卫星切换」
      try {
        const analysis = analyzeOutages(outages as never);
        line(`    判定结果: 切换 ${analysis.handoffs.length} 条 / 其他中断 ${analysis.otherOutages.length} 条`);
        for (const h of analysis.handoffs.slice(0, 5)) {
          line(`      切换 @${h.timestamp} 时长 ${h.durationMs}ms 原因 ${h.cause}`);
        }
        for (const o of analysis.otherOutages.slice(0, 3)) {
          line(`      其他中断 @${o.startTimestamp} (${o.cause})`);
        }
        if (analysis.handoffs.length === 0) {
          line('    ⇒ 没有一条被认成卫星切换 —— 上面的「原始」行里就是原因。');
        }
      } catch (err) {
        line('    判定失败: ' + (err instanceof Error ? err.message : String(err)));
      }
    } else {
      line('    ⇒ 设备没有上报任何中断事件 —— 卫星切换无从产生。');
    }
  } catch (err) {
    line('    读 history 失败: ' + (err instanceof Error ? err.message : String(err)));
  }
  line('');

  line('[4] 结论');
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

  line('');
  const reportPath = writeReport();
  if (reportPath) {
    line('=== 这份报告已保存到: ' + reportPath + ' ===');
    line('    把这个文件发回来，里面已经包含设备原始响应、解析结果和中断事件。');
  } else {
    line('=== 报告文件写入失败，请从上面的日志文件里复制 ===');
  }

  client.close();
}
