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
import { createFileRegistry, fromBinary, toBinary, toJson } from '@bufbuild/protobuf';
import { FileDescriptorSetSchema, FileDescriptorProtoSchema } from '@bufbuild/protobuf/wkt';
import { grpcWebUnary } from './grpcWeb';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
const RESPONSE_SYMBOL = 'SpaceX.API.Device.Response';

/**
 * dish 的 grpc-web 端口（HTTP/1.1）。真机上 9200 的原生 gRPC 会对部分请求分支
 * 回 `12 UNIMPLEMENTED`，而 9201 的 grpc-web 正常（dishylink 的实测文档
 * LOCAL-API.md 记录了同一现象：它只用 9201 调 Handle）。
 */
const DEFAULT_WEB_PORT = 9201;


/**
 * 已知分支的**字段号**（来自真机 proto 描述符，dishylink 的 schema/dish.protoset
 * 与真机 reflection 一致）。
 *
 * 用途：有些固件的 reflection 描述符里**只有 Response、没有 Request**，
 * 这时 protobufjs 查不到 Request 类型 ⇒ 退化成手工编码
 * （tag = 字段号<<3|2，length=0；外加 id 字段）。
 */
/**
 * 模块级描述符缓存。
 *
 * 为什么需要它：grpc-web(9201) 兜底依赖 reflection 拿 proto 描述符，
 * 而 **reflection 只在 9200 上有**。如果 9200 完全不可达（ECONNREFUSED），
 * reflection 也做不了 ⇒ grpc-web 兜底建不起来 ⇒ 循环依赖 ⇒ 全部超时。
 *
 * 缓存后：首次 reflection 成功（9200 短暂可达时）⇒ 描述符记住 ⇒
 * 后续即使 9200 挂了，原生 gRPC 快速失败（<1s），grpc-web 用缓存继续工作。
 */
let moduleDescriptorCache: Uint8Array[] | null = null;

const KNOWN_FIELD_NUMBERS: Record<string, number> = {
  getStatus: 1004,
  getHistory: 1007,
  dishGetObstructionMap: 2008,
  getDeviceInfo: 1008,
  getNetworkInterfaces: 1015,
};

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
  /** grpc-web 兜底端口（9201） */
  private webPort: number;
  /** 一旦发现原生 gRPC 不行，就一直走 grpc-web */
  private useWebTransport = false;
  /** reflection 拿到的描述符（用于请求编码 + 响应解码） */
  private descriptorBytes: Uint8Array[] | null = null;
  private registry: ReturnType<typeof createFileRegistry> | null = null;

  /** 描述符磁盘缓存路径（可空 = 不做磁盘缓存） */
  private descriptorCachePath: string | null;

  constructor(
    host: string,
    port: number,
    webPort: number = DEFAULT_WEB_PORT,
    descriptorCachePath?: string | null,
  ) {
    this.host = host;
    this.port = port;
    this.webPort = webPort;
    this.descriptorCachePath = descriptorCachePath ?? null;
  }

  /**
   * 通过 reflection 拿到 proto 并建立连接。
   *
   * reflection 失败时抛错 —— 不要静默降级成 mock，
   * 否则用户看到的是"假在线"，排查时无从下手。
   */
  private async connect(): Promise<DeviceClient> {
    if (this.client) return this.client;

    // 优先用模块级缓存 —— 9200 不可达时跳过 reflection（省 10s 超时）。
    // proto-loader 客户端的连接是 lazy 的，真正的网络 I/O 发生在 Handle 调用时。
    if (moduleDescriptorCache) {
      return this.buildClient(moduleDescriptorCache);
    }

    const descriptor = await this.resolveDescriptor();
    return this.buildClient(descriptor);
  }

  /** 从描述符字节构建 proto-loader 客户端（connect 的后半段，可被缓存路径复用） */
  private buildClient(descriptor: Uint8Array[]): DeviceClient {
    const address = `${this.host}:${this.port}`;
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
      throw new Error(`reflection 返回的 proto 里没有 ${SERVICE_NAME} 服务`);
    }

    const real = new DeviceCtor(address, grpc.credentials.createInsecure());
    this.client = real as unknown as DeviceClient;
    return this.client;
  }

  /**
   * 请求服务端的 file_containing_symbol, 拿回 proto 描述符。
   *
   * ⚠️ 必须**递归拉依赖文件**：reflection 的 file_containing_symbol 只返回
   * "包含该符号的那个文件"，而该文件可能引用别的文件（如 SpaceX.API.Status、
   * RouterInfo）。proto-loader 容忍缺引用，但 `@bufbuild/protobuf` 的 registry
   * 是严格模式 —— 缺一个类型就报
   * `invalid FieldDescriptorProto: type_name XXX not found`。
   * grpcurl 的 `describe` 也是这么做的（逐个 file_by_filename 补依赖）。
   *
   * 用 reflection 自己的 proto 构造客户端 —— 走标准 gRPC reflection 协议。
   */
  private async reflectFileContainingSymbol(
    client: grpc.Client,
    symbol: string,
    timeoutMs = 10000,
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
      const requestedFiles = new Set<string>();
      const pendingFiles: string[] = [];
      let inFlight = 0;
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

      const timer = setTimeout(
        () => finish(new Error(`reflection 超时 (${Math.round(timeoutMs / 1000)}s)`)),
        timeoutMs,
      );

      // 收集一个文件引用的**类型名**（bufbuild 解析单个文件不校验引用 ✓）。
      //
      // 为什么按类型名而不是按文件名：不同固件的 reflection 对
      // file_by_filename 的支持程度不一，而 fileContainingSymbol 一定支持。
      // 所以用"缺哪个类型就按类型名再要一次"的方式把依赖闭包补齐
      // （grpcurl 的 describe 也是类似的依赖解析）。
      const collectRefs = (bytes: Uint8Array): string[] => {
        const refs = new Set<string>();
        try {
          const fp = fromBinary(FileDescriptorProtoSchema, bytes);
          // 结构化类型（bufbuild v2 里是 DescMessage，不导出 MessageType 值）
          // bufbuild v2 的 FieldDescriptorProto 直接给 typeName（全限定名）
          type MsgLike = {
            field: readonly { typeName?: string }[];
            nestedType: readonly MsgLike[];
          };
          const visitMessage = (m: MsgLike): void => {
            for (const f of m.field) {
              // 只保留全限定名（含点）—— 标量名（double/string…）不是符号
              if (f.typeName && f.typeName.includes('.')) {
                refs.add(f.typeName.replace(/^\./, ''));
              }
            }
            for (const nested of m.nestedType) visitMessage(nested);
          };
          for (const m of fp.messageType) visitMessage(m);
          for (const sv of fp.service) {
            for (const method of sv.method) {
              if (method.inputType) refs.add(method.inputType.replace(/^\./, ''));
              if (method.outputType) refs.add(method.outputType.replace(/^\./, ''));
            }
          }
        } catch {
          /* 解析不了就跳过，靠已知的文件内容继续 */
        }
        return [...refs];
      };

      const pump = () => {
        while (pendingFiles.length) {
          const file = pendingFiles.shift()!;
          if (requestedFiles.has(file)) continue;
          requestedFiles.add(file);
          inFlight += 1;
          stream.write({ fileContainingSymbol: file });
        }
        if (inFlight === 0 && pendingFiles.length === 0 && chunks.length) {
          stream.end();
        }
      };

      stream.on('data', (msg: unknown) => {
        // 响应里描述符在 fileDescriptorResponse.fileDescriptorProto,
        // 不是 fileContainingSymbol (那是请求侧的字段名)
        const list = (msg as {
          fileDescriptorResponse?: { fileDescriptorProto?: Uint8Array[] };
        }).fileDescriptorResponse;
        const errorResponse = (msg as { errorResponse?: { errorMessage?: string } }).errorResponse;
        if (errorResponse?.errorMessage) {
          // 某个依赖拉不到 ⇒ 不致命，继续用已有的文件
          inFlight = Math.max(0, inFlight - 1);
          pump();
          return;
        }
        if (list?.fileDescriptorProto?.length) {
          chunks.push(...list.fileDescriptorProto);
          for (const b of list.fileDescriptorProto) {
            for (const ref of collectRefs(b)) {
              if (!requestedFiles.has(ref)) pendingFiles.push(ref);
            }
          }
          inFlight = Math.max(0, inFlight - 1);
          pump();
        }
      });
      stream.on('error', (e: Error) => finish(e));
      stream.on('end', () => finish());

      inFlight += 1;
      stream.write({ fileContainingSymbol: symbol });
    });
  }

  /**
   * 按**设备自己的描述符**推导候选分支名。
   *
   * 为什么需要：不同固件给同一语义起的分支名可能不同 —— 实测有固件把
   * history 的请求分支叫 `dish_get_history`(#2006) 而不是 `get_history`(#1007)
   * （响应键则相反）。硬编码只能覆盖已知的几种，靠描述符推导才通用。
   *
   * 做法：从 Request 消息的字段里挑出名字含该语义关键字的（如 history），
   * 插到首选列表后面作为兜底。
   */
  private async candidateBranches(preferred: string[], keyword: string): Promise<string[]> {
    const out = [...preferred];
    try {
      const registry = await this.ensureRegistry();
      const requestType = registry.getMessage(SYMBOL);
      if (!requestType) return out;
      for (const field of requestType.fields.values()) {
        const camel = field.name.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
        if (camel.toLowerCase().includes(keyword) && !out.includes(camel)) {
          out.push(camel);
        }
      }
    } catch {
      /* 描述符不可用时只用首选列表 */
    }
    return out;
  }

  /**
   * 列出设备 Request 消息的字段（名字 + 字段号 + JSON 名）——诊断用。
   *
   * 这是判断「这台固件到底把 history 分支叫啥」最直接的证据。
   */
  async describeRequestFields(): Promise<
    { name: string; number: number; jsonName: string }[]
  > {
    // 优先用 registry（最准）
    try {
      const registry = await this.ensureRegistry();
      const requestType = registry.getMessage(SYMBOL);
      if (requestType) {
        return [...requestType.fields.values()].map((f) => ({
          name: f.name,
          number: f.number,
          jsonName: f.jsonName,
        }));
      }
    } catch {
      /* 落到直接解析 */
    }

    // 兜底：直接解析 FileDescriptorProto（不建 registry ⇒ 不做跨文件校验，
    // 描述符不完整时也能拿到 Request 的字段清单）
    const chunks = await this.rawDescriptorBytes();
    const out: { name: string; number: number; jsonName: string }[] = [];
    for (const chunk of chunks) {
      try {
        const fp = fromBinary(FileDescriptorProtoSchema, chunk);
        for (const m of fp.messageType) {
          if (m.name !== 'Request') continue;
          for (const f of m.field) {
            out.push({ name: f.name, number: f.number, jsonName: f.jsonName });
          }
        }
      } catch {
        /* 跳过解析不了的文件 */
      }
    }
    return out;
  }

  /**
   * 同一个语义在不同固件上可能用不同的 oneof 分支名。
   *
   * 实测：某台真机（Windows 侧 192.168.100.1:9200）对 `getHistory` 返回
   * `12 UNIMPLEMENTED` —— 分支名不对，**不是网络问题**（reflection 能拿到 proto，
   * 说明协议层是通的）。而遮挡图分支叫 `dishGetObstructionMap`（带 dish 前缀），
   * 说明这台固件倾向 `dishGet*` 命名。
   *
   * 所以：按候选列表依次试，**UNIMPLEMENTED 才换下一个**（其它错误码直接抛，
   * 免得把真故障当成"换名字"糊弄过去）。
   */
  private async callWithFallback(
    candidates: string[],
    timeoutMs: number,
    what: string,
  ): Promise<{ res: Record<string, unknown>; branch: string }> {
    let lastErr: Error | null = null;
    for (const branch of candidates) {
      try {
        const res = await this.call({ id: Date.now() % 100000, [branch]: {} }, timeoutMs);
        return { res, branch };
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (!/code 12\b/.test(lastErr.message)) throw lastErr; // 非 UNIMPLEMENTED ⇒ 真错误
      }
    }
    throw new Error(
      `${what}：设备不认任何一个候选分支 (${candidates.join(', ')})；` +
      `最后错误: ${lastErr?.message ?? '未知'}`
    );
  }

  /**
   * 探测设备支持哪些 oneof 分支（诊断用）。
   *
   * transport='native' ⇒ 只走 9200 原生 gRPC；'web' ⇒ 只走 9201 grpc-web；
   * 'auto'（默认）⇒ 原生优先，失败自动切 grpc-web。
   */
  async probeBranches(
    candidates: string[],
    timeoutMs = 6000,
    transport: 'auto' | 'native' | 'web' = 'auto',
  ): Promise<{ name: string; ok: boolean; code: number; message: string; keys: string[] }[]> {
    const out: { name: string; ok: boolean; code: number; message: string; keys: string[] }[] = [];
    for (const name of candidates) {
      try {
        const req = { id: Date.now() % 100000, [name]: {} };
        const res = transport === 'native'
          ? await this.callNative(req, timeoutMs)
          : transport === 'web'
            ? await this.callViaGrpcWeb(req, timeoutMs)
            : await this.call(req, timeoutMs);
        out.push({ name, ok: true, code: 0, message: '', keys: Object.keys(res) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const m = message.match(/\(code (\d+)\)/);
        out.push({ name, ok: false, code: m ? Number(m[1]) : -1, message, keys: [] });
      }
    }
    return out;
  }

  /**
   * 从 reflection 拿到的描述符里抽出疑似消息/字段名（给��看的启发式清单）。
   *
   * 只是提示，不是权威 proto —— 但足以看出这台设备声明了哪些分支名。
   */
  async describeDeclaredNames(): Promise<string[]> {
    const chunks = await this.rawDescriptorBytes();
    const names = new Set<string>();
    // 描述符里的字段名/消息名都是长度前缀的 UTF-8 串，直接扫可打印 ASCII 段
    const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const text = merged.toString('latin1');
    for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_]{3,63}/g)) {
      const v = m[0];
      // 过滤 protobufjs 生成的 "XxxH" 辅助类型，保留其余消息/服务名
      if (/H$/.test(v) && /[A-Z]/.test(v.slice(-2, -1))) continue;
      names.add(v);
    }
    return [...names].sort();
  }

  /**
   * 解析描述符：模块缓存 → 磁盘缓存 → reflection。
   *
   * 为什么需要磁盘缓存：reflection 只在 9200 上有，而 grpc-web(9201) 兜底
   * 需要描述符才能编解码。9200 一旦不可达，连"取描述符"都做不到 ⇒
   * 整个 grpc-web 通道瘫痪。
   *
   * 有磁盘缓存时先给 reflection 一个**短超时**（2.5s）：9200 活着就取新鲜的
   * （固件升级后 proto 可能变），不活就直接用缓存，不白等 10s。
   */
  private async resolveDescriptor(): Promise<Uint8Array[]> {
    if (moduleDescriptorCache) return moduleDescriptorCache;

    const disk = this.readDescriptorFromDisk();
    const timeoutMs = disk ? 2500 : 10000;
    const address = `${this.host}:${this.port}`;
    const probe = new grpc.Client(address, grpc.credentials.createInsecure());
    try {
      const fresh = await this.reflectFileContainingSymbol(probe, SYMBOL, timeoutMs);
      moduleDescriptorCache = fresh;
      this.writeDescriptorToDisk(fresh);
      return fresh;
    } catch (err) {
      if (disk) {
        console.warn(
          '[DishGrpc] reflection 不可用, 改用磁盘缓存的描述符:',
          err instanceof Error ? err.message : err,
        );
        moduleDescriptorCache = disk;
        return disk;
      }
      throw err;
    } finally {
      probe.close();
    }
  }

  /** 读磁盘上的描述符缓存（FileDescriptorSet 字节流） */
  private readDescriptorFromDisk(): Uint8Array[] | null {
    if (!this.descriptorCachePath) return null;
    try {
      if (!fs.existsSync(this.descriptorCachePath)) return null;
      const buf = fs.readFileSync(this.descriptorCachePath);
      if (buf.length === 0) return null;
      const set = fromBinary(FileDescriptorSetSchema, buf);
      return set.file.map((f) => toBinary(FileDescriptorProtoSchema, f));
    } catch (err) {
      console.warn(
        '[DishGrpc] 读描述符缓存失败:',
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /** 写磁盘上的描述符缓存（FileDescriptorSet 字节流） */
  private writeDescriptorToDisk(descriptor: Uint8Array[]): void {
    if (!this.descriptorCachePath) return;
    try {
      fs.mkdirSync(path.dirname(this.descriptorCachePath), { recursive: true });
      fs.writeFileSync(this.descriptorCachePath, packFileDescriptorSet(descriptor));
    } catch (err) {
      console.warn(
        '[DishGrpc] 写描述符缓存失败:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** 取 reflection 返回的原始描述符字节（诊断用） */
  private async rawDescriptorBytes(): Promise<Uint8Array[]> {
    const address = `${this.host}:${this.port}`;
    const probe = new grpc.Client(address, grpc.credentials.createInsecure());
    try {
      return await this.reflectFileContainingSymbol(probe, SYMBOL);
    } finally {
      probe.close();
    }
  }

  /** 走原生 gRPC(9200) 调用 Handle */
  private async callNative(
    request: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
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

  /** 调用 Handle, oneof 分支名必须是 camelCase */
  private async call(request: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.useWebTransport) return this.callViaGrpcWeb(request, timeoutMs);

    try {
      return await this.callNative(request, timeoutMs);
    } catch (err) {
      // 原生 gRPC(9200) 不吃这个请求 ⇒ 换 grpc-web(9201) 再试一次。
      // 两种传输都失败时，抛原始错误（原生那条信息更贴近现场）。
      const original = err instanceof Error ? err : new Error(String(err));
      try {
        const res = await this.callViaGrpcWeb(request, timeoutMs);
        this.useWebTransport = true;
        console.warn('[DishGrpc] 原生 gRPC 不可用, 已切换到 grpc-web 传输');
        return res;
      } catch (webErr) {
        console.warn(
          '[DishGrpc] grpc-web 兜底也失败:',
          webErr instanceof Error ? webErr.message : webErr,
        );
        throw original;
      }
    }
  }

  /**
   * 走 grpc-web（HTTP/1.1 + 手工帧）调用 Handle。
   *
   * 请求体用 protobufjs 直接编码：reflection 拿到的描述符 → Request 类型。
   * 注意 protobufjs 的 fromObject **只认 snake_case 字段名**，
   * 所以这里把 camelCase 分支名映射回 proto 里的真实字段名。
   */
  private async callViaGrpcWeb(
    request: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const registry = await this.ensureRegistry();
    const responseType = registry ? (registry.getMessage(RESPONSE_SYMBOL) ?? null) : null;

    let payload: Uint8Array;
    try {
      if (!registry) throw new Error('registry 不可用');
      const requestType = registry.getMessage(SYMBOL);
      if (!requestType) throw new Error('描述符里没有 Request 消息类型');
      // camelCase 分支名 → proto 字段名（snake_case）
      const branch = Object.keys(request).find((k) => k !== 'id');
      const field = branch
        ? [...requestType.fields.values()].find(
            (f) => f.name.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()) === branch,
          )
        : undefined;
      if (!field || !field.message) throw new Error('描述符里没有对应的 Request 分支字段');
      payload = toBinary(requestType, {
        $typeName: SYMBOL,
        id: BigInt(typeof request.id === 'number' ? request.id : 0),
        [field.name]: { $typeName: field.message.typeName },
      } as never);
    } catch {
      // 描述符里没有 Request 类型 ⇒ 按字段号手工编码
      payload = this.encodeRequestManually(request);
    }

    // Handle 的完整方法路径：/SpaceX.API.Device.Device/Handle
    const url = `http://${this.host}:${this.webPort}/SpaceX.API.Device.Device/Handle`;
    let result;
    try {
      result = await grpcWebUnary(url, payload, timeoutMs);
    } catch (err) {
      // 统一成和原生 gRPC 一样的错误格式，便于上层/日志区分
      const status = (err as { grpcStatus?: number }).grpcStatus;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        typeof status === 'number'
          ? `gRPC 调用失败: ${message} (code ${status})`
          : `gRPC 调用失败: ${message}`,
      );
    }
    if (result.bytes.length === 0) return {};
    if (!responseType || !registry) {
      throw new Error(
        'grpc-web 通道有响应，但描述符不完整、无法解码（缺跨文件类型引用）',
      );
    }
    // toJson 用 proto 的 JSON 名（camelCase）⇒ 与 proto-loader keepCase:false 的结果一致
    return toJson(responseType, fromBinary(responseType, result.bytes), {
      registry,
    }) as Record<string, unknown>;
  }

  /**
   * 手工编码 `{ id, <branch>: {} }` 请求（描述符缺 Request 类型时的兜底）。
   *
   * 线格式：id 走字段 1（varint），分支走 `字段号<<3|2` + 长度 0。
   */
  private encodeRequestManually(request: Record<string, unknown>): Uint8Array {
    const branch = Object.keys(request).find((k) => k !== 'id');
    const fieldNum = branch ? KNOWN_FIELD_NUMBERS[branch] : undefined;
    if (fieldNum === undefined) {
      throw new Error(
        `无法编码请求：描述符里没有 Request 类型，且分支 ${branch ?? '(无)'} 没有已知字段号`,
      );
    }
    const bytes: number[] = [];
    const pushVarint = (value: number) => {
      let v = value >>> 0;
      while (v > 0x7f) {
        bytes.push((v & 0x7f) | 0x80);
        v >>>= 7;
      }
      bytes.push(v);
    };
    const id = typeof request.id === 'number' ? request.id : 0;
    bytes.push(0x08);            // field 1 (id), varint
    pushVarint(id);
    pushVarint((fieldNum << 3) | 2);  // 分支字段，length-delimited
    bytes.push(0x00);            // 长度 0 ⇒ 空消息
    return Uint8Array.from(bytes);
  }

  /**
   * 解析 reflection 描述符 → bufbuild registry（请求编码 + 响应解码都要用）。
   *
   * 注意：reflection 返回的是**一个个 FileDescriptorProto**，而
   * `@bufbuild/protobuf` 的 registry 需要一个 FileDescriptorSet
   * ⇒ 这里复用 packFileDescriptorSet() 把它们打包起来。
   */
  private async ensureRegistry(): Promise<ReturnType<typeof createFileRegistry>> {
    if (this.registry) return this.registry;
    if (!this.descriptorBytes) {
      this.descriptorBytes = await this.resolveDescriptor();
    }
    try {
      // v2 的 createFileRegistry 收一个 FileDescriptorSet
      const set = fromBinary(
        FileDescriptorSetSchema,
        packFileDescriptorSet(this.descriptorBytes),
      );
      this.registry = createFileRegistry(set);
    } catch (err) {
      // 描述符不完整（缺跨文件类型引用）⇒ registry 建不起来。
      // 这时仍可以**发请求**（走手工字段号编码），只是解不了响应。
      console.warn(
        '[DishGrpc] 描述符不完整, registry 不可用:',
        err instanceof Error ? err.message : err,
      );
      this.registry = null as never;
    }
    return this.registry;
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
    const { res, branch } = await this.callWithFallback(
      await this.candidateBranches(['getStatus', 'dishGetStatus'], 'status'),
      timeoutMs,
      '拉取 dish 状态',
    );
    const status = (res.dishGetStatus ?? res.getStatus) as Record<string, unknown> | undefined;
    if (!status) {
      throw new Error(
        `响应里没有 dishGetStatus (分支 ${branch}, 顶层键: ${Object.keys(res).join(', ')})`);
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
    const { res, branch } = await this.callWithFallback(
      await this.candidateBranches(['getHistory', 'dishGetHistory'], 'history'),
      timeoutMs,
      '拉取历史数据',
    );
    const history = (res.dishGetHistory ?? res.getHistory) as Record<string, unknown> | undefined;
    if (!history) {
      throw new Error(
        `响应里没有 dishGetHistory (分支 ${branch}, 顶层键: ${Object.keys(res).join(', ')})`);
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
