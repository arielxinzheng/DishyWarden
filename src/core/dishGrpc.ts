/**
 * Starlink Dish gRPC 客户端
 *
 * 协议要点（与真实 dish 及 DishyMock 一致，见 DishyMock docs/field-contract.md）:
 *
 * 1. **proto 靠 reflection 获取**，不依赖本地 .proto 文件 ——
 *    真实 dish 与 DishyMock 都注册了 gRPC reflection。
 * 2. **loader 选项必须 `keepCase: false`** —— 字段名要变成 camelCase
 *    （`dish_get_obstruction_map` → `dishGetObstructionMap`）。
 *    这是硬约束：keepCase 不对时服务端收到的是空 oneof 分支，
 *    响应里只有 apiVersion，且**不会报错**。
 * 3. **请求分支名用 camelCase**：`{ dishGetObstructionMap: {} }`。
 * 4. 响应挂在顶层 camelCase 键上：`resp.dishGetObstructionMap`。
 * 5. 遮挡图的 `snr` 是首选路径，值域 0..12，`-1` 是无数据哨兵；
 *    遮挡度换算 `1 - snr/12`，钳到 [0,1]。
 *    `obstructionMatrix` 是次选路径，值直接被 clamp 到 [0,1]。
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * gRPC reflection 的 proto —— 用来在客户端侧构造 reflection 客户端。
 *
 * `@grpc/reflection` 这个包只导出服务端用的 `ReflectionService`（addToServer），
 * 客户端侧的 reflection stub 不在里面，所以要用它自带的 .proto 自行构造。
 */
const REFLECTION_PROTO_PATH = require.resolve('@grpc/reflection/build/proto/grpc/reflection/v1/reflection.proto');

/** 与被测方生产代码 / DishyMock 完全一致的 loader 选项 */
const PROTO_OPTS: protoLoader.Options = {
  keepCase: false,
  longs: String,
  enums: String,
  bytes: Buffer,
  defaults: false,
  oneofs: true,
};

const SERVICE_NAME = 'SpaceX.API.Device.Device';
const SYMBOL = 'SpaceX.API.Device.Request';

/** 遮挡图的 SNR 参考值: 遮挡度 = 1 - snr/12 */
const REF_SNR = 12;

export interface ObstructionMapResult {
  /** numRows × numCols 的遮挡度矩阵, 值域 0..1 */
  data: number[][];
  /** 矩阵维度 */
  numRows: number;
  numCols: number;
  /** 平均 SNR (仅统计有效像素), 无有效像素时 null */
  avgSnr: number | null;
  /** 数据是否来自设备 (用于标注来源) */
  source: 'real';
}

/** Handle 方法的调用签名 (ClientUnaryMethod 在 grpc-js 的类型导出里没有, 自行声明) */
type HandleMethod = (
  request: unknown,
  options: grpc.CallOptions,
  callback: (err: grpc.ServiceError | null, res?: Record<string, unknown>) => void
) => grpc.ClientUnaryCall;

/** 带 Handle 方法的客户端 */
type DeviceClient = grpc.Client & { Handle: HandleMethod };

/** gRPC 客户端包装: 负责 reflection 取 proto 与 Handle 调用 */
export class DishGrpcClient {
  private client: DeviceClient | null = null;
  private host: string;
  private port: number;

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;
  }

  /**
   * 通过 reflection 拿到 proto 并建立连接。
   *
   * reflection 失败时抛错 —— 不要静默降级成 mock，
   * 否则用户看到的是"假在线"，排查时无从下手。
   */
  private async connect(): Promise<DeviceClient> {
    if (this.client) return this.client;

    const address = `${this.host}:${this.port}`;
    const probe = new grpc.Client(address, grpc.credentials.createInsecure());

    const descriptor = await this.reflectFileContainingSymbol(probe, SYMBOL);
    // loadFileDescriptorSetFromBuffer 专门吃打包好的 FileDescriptorSet 字节流
    const pkgDef = protoLoader.loadFileDescriptorSetFromBuffer(
      packFileDescriptorSet(descriptor),
      PROTO_OPTS
    );
    const loaded = grpc.loadPackageDefinition(pkgDef) as unknown as {
      SpaceX: { API: { Device: { Device: new (addr: string, creds: grpc.ChannelCredentials) => grpc.Client } } };
    };

    const DeviceCtor = loaded.SpaceX?.API?.Device?.Device;
    if (!DeviceCtor) {
      probe.close();
      throw new Error(`reflection 返回的 proto 里没有 ${SERVICE_NAME} 服务`);
    }

    const real = new DeviceCtor(address, grpc.credentials.createInsecure());
    this.client = real as unknown as DeviceClient;
    probe.close();
    return this.client;
  }

  /**
   * 请求服务端的 file_containing_symbol, 拿回 proto 描述符。
   *
   * 用 reflection 自己的 proto 构造客户端 —— 走标准 gRPC reflection 协议。
   */
  private reflectFileContainingSymbol(
    client: grpc.Client,
    symbol: string
  ): Promise<Uint8Array[]> {
    const reflectionDef = protoLoader.loadSync(REFLECTION_PROTO_PATH, PROTO_OPTS);
    const reflectionPkg = grpc.loadPackageDefinition(reflectionDef) as unknown as {
      grpc: {
        reflection: {
          v1: { ServerReflection: new (addr: string, creds: grpc.ChannelCredentials) => grpc.Client };
        };
      };
    };

    const ServerReflection = reflectionPkg.grpc?.reflection?.v1?.ServerReflection;
    if (!ServerReflection) {
      throw new Error('无法构造 reflection 客户端 (ServerReflection 缺失)');
    }

    return new Promise((resolve, reject) => {
      const reflection = new ServerReflection(
        client.getChannel().getTarget(),
        grpc.credentials.createInsecure()
      );
      const stream = (reflection as unknown as {
        serverReflectionInfo: () => grpc.ClientDuplexStream<unknown, unknown>;
      }).serverReflectionInfo();

      const chunks: Uint8Array[] = [];
      let done = false;

      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { stream.cancel(); } catch { /* ignore */ }
        if (err) reject(err);
        else if (chunks.length) resolve(chunks);
        else reject(new Error(`reflection 未返回 ${symbol} 的描述符`));
      };

      const timer = setTimeout(() => finish(new Error('reflection 超时 (10s)')), 10000);

      stream.on('data', (msg: unknown) => {
        // 响应里描述符在 fileDescriptorResponse.fileDescriptorProto,
        // 不是 fileContainingSymbol (那是请求侧的字段名)
        const list = (msg as {
          fileDescriptorResponse?: { fileDescriptorProto?: Uint8Array[] };
        }).fileDescriptorResponse;
        if (list?.fileDescriptorProto?.length) {
          chunks.push(...list.fileDescriptorProto);
        }
      });
      stream.on('error', (e: Error) => finish(e));
      stream.on('end', () => finish());

      stream.write({ fileContainingSymbol: symbol });
      stream.end();
    });
  }

  /** 调用 Handle, oneof 分支名必须是 camelCase */
  private async call(request: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const client = await this.connect();
    return new Promise((resolve, reject) => {
      client.Handle(
        request,
        { deadline: Date.now() + timeoutMs },
        (err: grpc.ServiceError | null, res?: Record<string, unknown>) => {
          if (err) reject(new Error(`gRPC 调用失败: ${err.message} (code ${err.code})`));
          else resolve(res ?? {});
        }
      );
    });
  }

  /**
   * 拉取遮挡图。
   *
   * 走 dishGetObstructionMap 分支 (1015)。按契约, 响应必须挂在顶层
   * `dishGetObstructionMap` 键上 —— 服务端如果只挂在 oneof 虚拟字段上,
   * 这里会拿到 undefined, 属于协议实现错误, 直接抛错而不是返回空图。
   */
  async getObstructionMap(timeoutMs = 8000): Promise<ObstructionMapResult> {
    const res = await this.call({ id: Date.now() % 100000, dishGetObstructionMap: {} }, timeoutMs);

    const map = res.dishGetObstructionMap as {
      numRows?: number; numCols?: number;
      snr?: number[]; obstructionMatrix?: number[];
    } | undefined;

    if (!map) {
      throw new Error(
        `响应里没有 dishGetObstructionMap (顶层键: ${Object.keys(res).join(', ')})`
      );
    }

    const numRows = map.numRows ?? 123;
    const numCols = map.numCols ?? 123;

    let flat: number[];
    if (Array.isArray(map.snr) && map.snr.length > 0) {
      flat = map.snr;
    } else if (Array.isArray(map.obstructionMatrix) && map.obstructionMatrix.length > 0) {
      // 次选路径: 值已经是遮挡度, 直接用
      const rows: number[][] = [];
      for (let r = 0; r < numRows; r++) {
        rows.push(
          Array.from({ length: numCols }, (_, c) => {
            const v = map.obstructionMatrix![r * numCols + c];
            return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
          })
        );
      }
      return { data: rows, numRows, numCols, avgSnr: null, source: 'real' };
    } else {
      throw new Error('遮挡图响应里既没有 snr 也没有 obstructionMatrix');
    }

    // 首选路径: snr -> 遮挡度 = 1 - snr/12, snr=-1 是无数据哨兵 -> 0
    const rows: number[][] = [];
    const validSnr: number[] = [];

    for (let r = 0; r < numRows; r++) {
      const row: number[] = [];
      for (let c = 0; c < numCols; c++) {
        const snr = flat[r * numCols + c];
        if (!Number.isFinite(snr) || snr < 0) {
          row.push(0);   // 哨兵 = 未映射
          continue;
        }
        validSnr.push(snr);
        row.push(Math.min(1, Math.max(0, 1 - snr / REF_SNR)));
      }
      rows.push(row);
    }

    const avgSnr = validSnr.length > 0
      ? validSnr.reduce((a, b) => a + b, 0) / validSnr.length
      : null;

    return { data: rows, numRows, numCols, avgSnr, source: 'real' };
  }

  /** 拉取 dish 状态 */
  async getStatus(timeoutMs = 8000): Promise<Record<string, unknown>> {
    const res = await this.call({ id: Date.now() % 100000, getStatus: {} }, timeoutMs);
    const status = res.dishGetStatus as Record<string, unknown> | undefined;
    if (!status) {
      throw new Error(`响应里没有 dishGetStatus (顶层键: ${Object.keys(res).join(', ')})`);
    }
    return status;
  }

  /**
   * 拉取历史数据（包含 outages）
   * 
   * 走 getHistory 请求分支，响应在 dishGetHistory 键上。响应包含：
   * - currentTimestamp: 当前时间戳（秒）
   * - popPingLatencyMs: PoP ping 延迟数组
   * - downlinkThroughputBps: 下行吞吐量数组
   * - uplinkThroughputBps: 上行吞吐量数组
   * - popPingDropRate: PoP ping 丢包率数组
   * - snr: SNR 数组
   * - obstructed: 遮挡状态数组
   * - outages: 中断事件数组（关键：包含卫星切换）
   */
  async getHistory(timeoutMs = 8000): Promise<Record<string, unknown>> {
    const res = await this.call({ id: Date.now() % 100000, getHistory: {} }, timeoutMs);
    const history = res.dishGetHistory as Record<string, unknown> | undefined;
    if (!history) {
      throw new Error(`响应里没有 dishGetHistory (顶层键: ${Object.keys(res).join(', ')})`);
    }
    return history;
  }

  close(): void {
    try { this.client?.close(); } catch { /* ignore */ }
    this.client = null;
  }
}

/** varint 编码 */
function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    let b = value & 0x7f;
    value >>>= 7;
    if (value > 0) b |= 0x80;
    bytes.push(b);
  } while (value > 0);
  return Buffer.from(bytes);
}

/**
 * 把 FileDescriptorProto 数组打包成 FileDescriptorSet。
 *
 * wire format: field 1 (file) 重复, 每项是 length-delimited。
 */
export function packFileDescriptorSet(descriptors: Uint8Array[]): Buffer {
  const parts: Buffer[] = [];
  for (const d of descriptors) {
    parts.push(Buffer.from([0x0a]), varint(d.length), Buffer.from(d));
  }
  return Buffer.concat(parts);
}
