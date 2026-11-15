/**
 * 期望朝向（desiredBoresight*）的解析语义。
 *
 * 这组用例锁的是一个真实踩过的坑：期望朝向被兜成 0 之后，
 * 「设备没上报推荐朝向」会变成「推荐正北」，校准页据此给出
 * 「向西旋转 135°」这种错误引导，而「无期望值」分支永远走不到。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ReflectionService } from '@grpc/reflection';
import { DishClient, parseFiniteNumber, type TelemetryData } from './dishClient';
import { DishGrpcClient, clearDescriptorCacheForTest, perHostCachePath, protocJsonName } from './dishGrpc';

/** parseStatus 是 private，但映射逻辑是本文件要锁的东西 —— 用类型断言取出来 */
function mapper() {
  const client = new DishClient({ address: '127.0.0.1', grpcPort: 9200 });
  const inner = client as unknown as {
    parseStatus(status: Record<string, unknown>): TelemetryData;
    lastTelemetry: TelemetryData | null;
  };
  return {
    parse: (status: Record<string, unknown>) => inner.parseStatus(status),
    setPrev: (t: TelemetryData | null) => {
      inner.lastTelemetry = t;
    },
  };
}

describe('parseFiniteNumber', () => {
  it('正常数字原样返回', () => {
    expect(parseFiniteNumber(135)).toBe(135);
    expect(parseFiniteNumber(0)).toBe(0);
    expect(parseFiniteNumber(-12.5)).toBe(-12.5);
  });

  it('数字字符串能解析（int64 在 proto 里是 string）', () => {
    expect(parseFiniteNumber('135')).toBe(135);
    expect(parseFiniteNumber('0')).toBe(0);
  });

  it('缺失 / 非法值返回 undefined，而不是 0', () => {
    expect(parseFiniteNumber(undefined)).toBeUndefined();
    expect(parseFiniteNumber(null)).toBeUndefined();
    expect(parseFiniteNumber('')).toBeUndefined();
    expect(parseFiniteNumber('  ')).toBeUndefined();
    expect(parseFiniteNumber('abc')).toBeUndefined();
    expect(parseFiniteNumber(Number.NaN)).toBeUndefined();
    expect(parseFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('0 与 undefined 必须能区分：0 是合法的正北方位，不是「没上报」', () => {
    // 设备确实上报了 0（推荐正北）→ 有值
    expect(parseFiniteNumber(0) ?? '缺失').toBe(0);
    // 设备没上报 → 没值
    expect(parseFiniteNumber(undefined) ?? '缺失').toBe('缺失');
  });
});

describe('parseStatus —— 期望朝向的映射', () => {
  it('设备不报期望朝向时是 undefined，不是 0', () => {
    const { parse } = mapper();
    const t = parse({
      alignmentStats: { hasActuators: 'HAS_ACTUATORS_YES', attitudeUncertaintyDeg: 0.4 },
      boresightAzimuthDeg: 135,
    });
    expect(t.alignmentStats?.desiredBoresightAzimuthDeg).toBeUndefined();
    expect(t.alignmentStats?.desiredBoresightElevationDeg).toBeUndefined();
  });

  it('整个 alignmentStats 缺失时也是 undefined', () => {
    const { parse } = mapper();
    const t = parse({ boresightAzimuthDeg: 135 });
    expect(t.alignmentStats?.desiredBoresightAzimuthDeg).toBeUndefined();
  });

  it('设备上报 0 时保留 0（推荐正北是合法值，不能当成缺失）', () => {
    const { parse } = mapper();
    const t = parse({
      alignmentStats: { desiredBoresightAzimuthDeg: 0, desiredBoresightElevationDeg: 0 },
    });
    expect(t.alignmentStats?.desiredBoresightAzimuthDeg).toBe(0);
    expect(t.alignmentStats?.desiredBoresightElevationDeg).toBe(0);
  });

  it('正常上报时按值映射', () => {
    const { parse } = mapper();
    const t = parse({
      alignmentStats: { desiredBoresightAzimuthDeg: 135, desiredBoresightElevationDeg: 45 },
    });
    expect(t.alignmentStats?.desiredBoresightAzimuthDeg).toBe(135);
    expect(t.alignmentStats?.desiredBoresightElevationDeg).toBe(45);
  });

  it('本帧缺失时沿用上一帧的值（设备抖动不应让推荐范围忽有忽无）', () => {
    const { parse, setPrev } = mapper();
    setPrev({
      alignmentStats: { desiredBoresightAzimuthDeg: 135, desiredBoresightElevationDeg: 45 },
    } as TelemetryData);
    const t = parse({ alignmentStats: { attitudeUncertaintyDeg: 0.4 } });
    expect(t.alignmentStats?.desiredBoresightAzimuthDeg).toBe(135);
    expect(t.alignmentStats?.desiredBoresightElevationDeg).toBe(45);
  });

  it('回归：绝不能退化成 0（0 会被当成「推荐正北」）', () => {
    const { parse } = mapper();
    const t = parse({ alignmentStats: {} });
    expect(t.alignmentStats?.desiredBoresightAzimuthDeg).not.toBe(0);
  });
});

/**
 * ===== 回归：proto3「值为 0 的字段不出现在响应里」=====
 *
 * 现象：DishyMock 恢复全部告警后，DishyWarden 里的 high_packet_loss /
 * severe_weather 一直不消失（occurrence_count 涨到 68，last_seen 持续刷新）。
 *
 * 根因：dishGrpc 用 `defaults: false` 加载 proto，proto3 里等于默认值的字段
 * **根本不会出现在响应里**。旧代码把「丢包率回到 0 ⇒ 字段消失」当成
 * 「设备没上报 ⇒ 沿用上一帧」，于是丢包率被永久冻结在 0.6，告警永远成立。
 *
 * 修法：所有物理量走 `gauge()` —— 缺失即 0。
 */
describe('parseStatus —— 物理量缺失必须归零，不能沿用上一帧', () => {
  it('丢包率从 0.6 恢复为「字段消失」⇒ 必须回到 0（告警要能自愈）', () => {
    const { parse, setPrev } = mapper();
    // 第一帧：场景激活，丢包 60%
    const sick = parse({
      popPingDropRate: 0.6,
      downlinkThroughputBps: 120e6,
      snr: 6,
      obstructionStats: { fractionObstructed: 0.3 },
    });
    expect(sick.popPingDropRate).toBeCloseTo(0.6, 6);
    setPrev(sick as TelemetryData);

    // 第二帧：场景恢复 —— 0 值的字段在 proto3 里直接消失
    const healthy = parse({
      downlinkThroughputBps: 140e6,
      isSnrAboveNoiseFloor: true,
    });

    expect(healthy.popPingDropRate).toBe(0);        // ← 修复前是 0.6
    expect(healthy.snr).toBe(0);                    // ← 修复前是 6
    expect(healthy.fractionObstructed).toBe(0);     // ← 修复前是 0.3
    expect(healthy.secondsObstructed).toBe(0);
  });

  it('恢复后 high_packet_loss 判据不再成立', () => {
    const { parse, setPrev } = mapper();
    const sick = parse({ popPingDropRate: 0.6 });
    setPrev(sick as TelemetryData);
    const healthy = parse({ popPingLatencyMs: 30 });
    // 规则判据: (data.popPingDropRate || 0) > 0.1
    expect((healthy.popPingDropRate || 0) > 0.1).toBe(false);
  });

  it('真实非零量照常透传', () => {
    const { parse } = mapper();
    const t = parse({
      popPingDropRate: 0.12, popPingLatencyMs: 88, snr: 4,
      downlinkThroughputBps: 5e6,
      deviceInfo: { dishTemperature: 61 },
    });
    expect(t.popPingDropRate).toBeCloseTo(0.12, 6);
    expect(t.popPingLatencyMs).toBe(88);
    expect(t.snr).toBe(4);
    expect(t.dishTemperature).toBe(61);
  });

  it('设备重启（uptime 归零）不再被旧值掩盖', () => {
    const { parse, setPrev } = mapper();
    setPrev(parse({ deviceState: { uptimeS: 86400 } }) as TelemetryData);
    const rebooted = parse({ deviceState: {} }); // uptime=0 ⇒ 字段消失
    expect(rebooted.uptime).toBe(0);
  });
});

/**
 * ===== 连接状态推导：必须分清 SEARCHING 与 OFFLINE =====
 *
 * 旧实现把所有"无下行"的情况都算成 SEARCHING，于是
 * dish_offline（判据 state !== 'ONLINE'）与 frequent_searching（state === 'SEARCHING'）
 * 会对同一件事双报；而真正该报的 severe_weather 又要求 state === 'ONLINE' 反而漏报。
 */
describe('deriveState（经由 parseStatus）—— 状态语义', () => {
  const online = (over: Record<string, unknown> = {}) => ({
    downlinkThroughputBps: 140e6,
    deviceState: { uptimeS: 3600 },
    isSnrAboveNoiseFloor: true,
    ...over,
  });

  it('有下行且有 SNR 证据 ⇒ ONLINE', () => {
    const { parse } = mapper();
    expect(parse(online()).state).toBe('ONLINE');
  });

  it('无下行但路由器还连着 ⇒ SEARCHING（正在锁星，属正常过程）', () => {
    const { parse } = mapper();
    const t = parse({
      downlinkThroughputBps: 0,
      connectedRouters: ['router-1'],
      deviceState: { uptimeS: 3600 },
    });
    expect(t.state).toBe('SEARCHING');
  });

  it('无下行且看不到任何路由器 ⇒ OFFLINE（设备在线却不在服务）', () => {
    const { parse } = mapper();
    const t = parse({
      downlinkThroughputBps: 0,
      deviceState: { uptimeS: 3600 },
    });
    expect(t.state).toBe('OFFLINE');
  });

  it('刚开机（uptime < 60s）优先判 BOOTING，不报离线', () => {
    const { parse } = mapper();
    const t = parse({ downlinkThroughputBps: 0, deviceState: { uptimeS: 12 } });
    expect(t.state).toBe('BOOTING');
  });

  it('恶劣天气（丢包 12% + SNR 低于噪声底，但下行仍在）⇒ ONLINE', () => {
    const { parse } = mapper();
    const t = parse({
      popPingDropRate: 0.12,
      downlinkThroughputBps: 140e6,
      isSnrAboveNoiseFloor: false,
      deviceState: { uptimeS: 90970 },
    });
    // 关键: 没有真实 snr 字段时，snr=0，但下行健康 ⇒ 不能判成搜星/离线
    expect(t.state).toBe('ONLINE');
  });
});

// ── history 最新样本提取（真机数值只在 dish_get_history 里）────────────────
describe('latestHistorySample', () => {
  it('取各数组的最后一个元素（最新样本）', async () => {
    const { latestHistorySample } = await import('./dishClient');
    const sample = latestHistorySample({
      popPingDropRate: [0.1, 0.2, 0.3],
      popPingLatencyMs: [10, 20, 30],
      downlinkThroughputBps: [100, 200, 300],
      uplinkThroughputBps: [1, 2, 3],
    });
    expect(sample).toEqual({
      dropRate: 0.3,
      latencyMs: 30,
      downlinkBps: 300,
      uplinkBps: 3,
    });
  });

  it('空数组/缺字段 ⇒ undefined（不编造 0）', async () => {
    const { latestHistorySample } = await import('./dishClient');
    expect(latestHistorySample({ popPingDropRate: [] })).toBeUndefined();
    expect(latestHistorySample({})).toBeUndefined();
  });

  it('int64 用字符串表示时也能转成数字', async () => {
    const { latestHistorySample } = await import('./dishClient');
    const sample = latestHistorySample({ popPingLatencyMs: ['12', '34'] });
    expect(sample?.latencyMs).toBe(34);
  });
});

// ── history 是环形缓冲：最新样本不在末尾 ─────────────────────────────────
describe('latestHistorySample 环形缓冲索引', () => {
  it('按 current 计数器定位最新样本（不是取末尾）', async () => {
    const { latestHistorySample } = await import('./dishClient');
    // 数组长度 3，current=5 ⇒ 最新样本在 (5-1)%3 = 1
    const sample = latestHistorySample({
      current: 5,
      popPingLatencyMs: [10, 20, 30],
      popPingDropRate: [0.1, 0.2, 0.3],
      downlinkThroughputBps: [100, 200, 300],
      uplinkThroughputBps: [1, 2, 3],
    });
    expect(sample).toEqual({
      dropRate: 0.2,
      latencyMs: 20,
      downlinkBps: 200,
      uplinkBps: 2,
    });
  });

  it('缓冲绕回后仍取到真正的最新样本', async () => {
    const { latestHistorySample } = await import('./dishClient');
    // 长度 900，current=1000 ⇒ 最新样本在 (1000-1)%900 = 99
    const latencies = new Array(900).fill(0);
    latencies[99] = 42;
    const sample = latestHistorySample({ current: 1000, popPingLatencyMs: latencies });
    expect(sample?.latencyMs).toBe(42);
  });

  it('没有 current 时退回取末尾', async () => {
    const { latestHistorySample } = await import('./dishClient');
    const sample = latestHistorySample({ popPingLatencyMs: [10, 20, 30] });
    expect(sample?.latencyMs).toBe(30);
  });
});

// ── dishGrpc 传输层回归（本地起 gRPC + reflection + 假 grpc-web 服务，不依赖真机） ──
//
// 放在这个文件里是因为本轮改动的可写范围只含这一个测试文件；
// 逻辑上属于 dishGrpc.ts，后续可挪到 dishGrpc.test.ts。
describe('protocJsonName', () => {
  it('按 protoc 规则把 snake_case 转 camelCase（空串/首字母/多下划线都要稳）', () => {
    expect(protocJsonName('dish_get_status')).toBe('dishGetStatus');
    expect(protocJsonName('get_history')).toBe('getHistory');
    expect(protocJsonName('id')).toBe('id');
    expect(protocJsonName('')).toBe('');
    expect(protocJsonName('_leading')).toBe('Leading');
  });
});

describe('DishGrpcClient 传输层（本地 reflection 服务）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dishgrpc-'));
  // 跨文件引用 + 同文件内大量互相引用 —— 真机 proto 就是这个形状
  fs.writeFileSync(path.join(dir, 'common.proto'), `
syntax = "proto3";
package SpaceX.API.Common;
message Tag { string v = 1; }
`);
  fs.writeFileSync(path.join(dir, 'device.proto'), `
syntax = "proto3";
package SpaceX.API.Device;
import "common.proto";
message GetStatusRequest {}
message GetHistoryRequest {}
message GetPingRequest {}
message DishGetStatusResponse { string hardware_version = 1; SpaceX.API.Common.Tag tag = 2; }
message Request {
  uint64 id = 1;
  oneof request {
    GetStatusRequest get_status = 1004;
    GetHistoryRequest get_history = 1007;
    GetPingRequest get_ping = 1009;
  }
}
message Response {
  uint64 id = 1;
  oneof response { DishGetStatusResponse dish_get_status = 2004; }
}
service Device { rpc Handle(Request) returns (Response); }
`);

  let server: grpc.Server;
  let web: http.Server;
  let nativePort = 0;
  let webPort = 0;
  let lastWebBody: Buffer = Buffer.alloc(0);

  beforeAll(async () => {
    const pkgDef = protoLoader.loadSync(path.join(dir, 'device.proto'), {
      keepCase: false, longs: String, enums: String, defaults: false, oneofs: true, includeDirs: [dir],
    });
    const loaded = grpc.loadPackageDefinition(pkgDef) as unknown as {
      SpaceX: { API: { Device: { Device: { service: grpc.ServiceDefinition } } } };
    };
    server = new grpc.Server();
    server.addService(loaded.SpaceX.API.Device.Device.service, {
      Handle: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
        if (call.request.getStatus) cb(null, { id: call.request.id, dishGetStatus: { hardwareVersion: 'rev4' } });
        else cb({ code: grpc.status.UNIMPLEMENTED, details: 'no branch' } as grpc.ServiceError);
      },
    });
    new ReflectionService(pkgDef).addToServer(server);
    nativePort = await new Promise<number>((resolve, reject) =>
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));

    // 假 grpc-web：记下请求体，回一个 Response{dish_get_status:{hardware_version:"web"}} + trailers
    web = http.createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c));
      req.on('end', () => {
        lastWebBody = Buffer.concat(parts);
        const inner = Buffer.from([0x0a, 0x03, ...Buffer.from('web')]);
        const msg = Buffer.from([0xa2, 0x7d, inner.length, ...inner]); // field 2004, LEN
        const trailer = Buffer.from('grpc-status: 0\r\n');
        const frame = (flag: number, b: Buffer) => {
          const h = Buffer.alloc(5); h[0] = flag; h.writeUInt32BE(b.length, 1); return Buffer.concat([h, b]);
        };
        res.writeHead(200, { 'content-type': 'application/grpc-web+proto' });
        res.end(Buffer.concat([frame(0x00, msg), frame(0x80, trailer)]));
      });
    });
    webPort = await new Promise<number>((resolve) =>
      web.listen(0, '127.0.0.1', () => resolve((web.address() as { port: number }).port)));
  });

  afterAll(() => {
    server?.forceShutdown();
    web?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => clearDescriptorCacheForTest());

  it('reflection 去重：传递依赖重复返回时 proto-loader 仍能建客户端（原生通道可用）', async () => {
    // 默认主传输已改为 grpc-web；这条测的是原生通道 ⇒ 显式指定
    const c = new DishGrpcClient('127.0.0.1', nativePort, webPort, null, 'native');
    const status = await c.getStatus(3000);
    expect(status.hardwareVersion).toBe('rev4');
    c.close();
  });

  it('grpc-web 请求按 oneof 正确编码（不是退化成手工字段号）', async () => {
    const c = new DishGrpcClient('127.0.0.1', nativePort, webPort);
    // 先让描述符就位，再直接走 grpc-web
    await c.getStatus(3000);
    const res = await c.probeBranches(['getPing'], 3000, 'web');
    expect(res[0].message).toBe('');
    expect(res[0].ok).toBe(true);
    // getPing(#1009) 不在 KNOWN_FIELD_NUMBERS 里：只有 registry 编码才发得出 field 1009
    // 帧 = 5 字节头 + 负载；负载里要有 tag (1009<<3|2) = 0x8a 0x3f
    const payload = lastWebBody.subarray(5);
    expect(Buffer.from(payload).includes(Buffer.from([0x8a, 0x3f, 0x00]))).toBe(true);
    c.close();
  });

  it('描述符缓存按 host 分键：换设备不会复用上一台的描述符', async () => {
    const reflections = (c: DishGrpcClient) => {
      const inner = c as unknown as { reflectFileContainingSymbol: (...a: unknown[]) => Promise<Uint8Array[]> };
      const orig = inner.reflectFileContainingSymbol.bind(c);
      let n = 0;
      inner.reflectFileContainingSymbol = (...a: unknown[]) => { n += 1; return orig(...a); };
      return () => n;
    };
    const a = new DishGrpcClient('127.0.0.1', nativePort, webPort);
    const countA = reflections(a);
    await a.getStatus(3000);
    a.close();
    expect(countA()).toBe(1);
    // 同一台设备的新实例 ⇒ 命中模块缓存，不再 reflection
    const a2 = new DishGrpcClient('127.0.0.1', nativePort, webPort);
    const countA2 = reflections(a2);
    await a2.getStatus(3000);
    a2.close();
    expect(countA2()).toBe(0);
    // 换一个 host 字符串（指向同一个服务）⇒ 必须重新 reflection
    const b = new DishGrpcClient('localhost', nativePort, webPort);
    const countB = reflections(b);
    await b.getStatus(3000);
    b.close();
    expect(countB()).toBe(1);
  });

  it('端口回落只针对 grpc-web 端口：自定义原生端口不会被改连到 9200', async () => {
    const c = new DishGrpcClient('127.0.0.1', nativePort, webPort);
    await c.getStatus(3000);
    expect((c as unknown as { nativePort: number }).nativePort).toBe(nativePort);
    c.close();
  });

  it('配置端口 = grpc-web 端口 ⇒ reflection 直接走 9200（不先在 HTTP/1.1 端口上白等）', async () => {
    const c = new DishGrpcClient('127.0.0.1', webPort, webPort);
    const seen: string[] = [];
    const inner = c as unknown as { reflectFileContainingSymbol: (cl: grpc.Client) => Promise<Uint8Array[]> };
    inner.reflectFileContainingSymbol = async (cl: grpc.Client) => {
      seen.push(cl.getChannel().getTarget());
      throw new Error('stop');
    };
    await expect(c.getStatus(500)).rejects.toThrow();
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain(':9200');
    c.close();
  });

  it('磁盘缓存路径按 host 分文件', () => {
    expect(perHostCachePath('/x/dish-descriptor.bin', '192.168.100.1'))
      .toBe('/x/dish-descriptor-192.168.100.1.bin');
    expect(perHostCachePath('/x/cache', 'a:b')).toBe('/x/cache-a_b');
  });

  it('默认主传输是 grpc-web，响应顶层键能正确解码出 dishGetStatus（真机 9200 全挂的现象下也能工作）', async () => {
    // 不传 preferTransport ⇒ 默认 grpc-web ⇒ 返回 "web"（假 grpc-web 服务的值），
    // 而不是 "rev4"（原生 gRPC 的值）。顺带回归 jsonName 修复：
    // 之前描述符 json_name 缺失会让所有字段挤到 "" 键 ⇒ getStatus 抛"响应里没有 dishGetStatus"。
    const c = new DishGrpcClient('127.0.0.1', nativePort, webPort);
    const status = await c.getStatus(3000);
    expect(status.hardwareVersion).toBe('web');
    c.close();
  });

  it('grpc-web 主通道失败时兜底到原生 gRPC 并记住新方向', async () => {
    // 换一个"grpc-web 不可达"的端口：主通道必然失败，兜底走原生。
    const deadWebPort = 1; // 肯定没有服务
    const c = new DishGrpcClient('127.0.0.1', nativePort, deadWebPort);
    const status = await c.getStatus(3000);
    expect(status.hardwareVersion).toBe('rev4'); // 走到原生
    // 兜底一次后应切换主传输：下一次 call 直接走原生
    expect((c as unknown as { useWebTransport: boolean }).useWebTransport).toBe(false);
    c.close();
  });
});

describe('DishClient.getHistoryResponse —— 同一周期只拉一次 history', () => {
  it('并发调用合并成一次 RPC，maxAge 内复用', async () => {
    const client = new DishClient({ address: '127.0.0.1', grpcPort: 9200 });
    let calls = 0;
    (client as unknown as { grpc: unknown }).grpc = {
      getHistory: async () => { calls += 1; return { current: 1 }; },
      close: () => {},
    };
    const [a, b] = await Promise.all([client.getHistoryResponse(), client.getHistoryResponse()]);
    expect(a).toBe(b);
    await client.getHistoryResponse();
    expect(calls).toBe(1);
    await client.getHistoryResponse(1000, 0); // maxAge=0 ⇒ 强制重拉
    expect(calls).toBe(2);
  });
});

describe('latestHistorySample 环形索引不依赖 popPingLatencyMs', () => {
  it('latency 数组缺失时，其它数组仍按 current 取模', async () => {
    const { latestHistorySample } = await import('./dishClient');
    const sample = latestHistorySample({ current: 5, downlinkThroughputBps: [100, 200, 300] });
    expect(sample?.downlinkBps).toBe(200);
  });
});

describe('getTelemetry —— 遮挡图按间隔刷新', () => {
  it('间隔内不重复拉 60KB 遮挡图，且沿用上一份图的 SNR', async () => {
    const client = new DishClient({ address: '192.168.100.1', grpcPort: 9200 });
    let mapCalls = 0;
    (client as unknown as { grpc: unknown }).grpc = {
      getStatus: async () => ({ downlinkThroughputBps: 1e6 }),
      getHistory: async () => ({ current: 1, popPingLatencyMs: [30] }),
      getObstructionMap: async () => {
        mapCalls += 1;
        return { data: [[0]], numRows: 1, numCols: 1, avgSnr: 9, source: 'real' };
      },
      close: () => {},
    };
    const first = await client.getTelemetry();
    // 让 history 缓存过期，确保第二帧真的重新组装
    (client as unknown as { lastHistory: unknown }).lastHistory = null;
    const second = await client.getTelemetry();
    expect(mapCalls).toBe(1);
    expect(first.snr).toBe(9);
    expect(second.snr).toBe(9);
    expect(second.obstructionMapSource).toBe('real');
    expect(second.obstructionMap).toEqual([[0]]);
  });
});
