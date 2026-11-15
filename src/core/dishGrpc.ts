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
import { grpcWebUnaryNode } from './grpcWebNode';
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
 * dish 的**原生 gRPC** 端口（HTTP/2）。
 *
 * reflection 服务只在这个端口上 ⇒ **不管用户把 dishPort 配成什么，
 * reflection 都要能回落到这里**，否则用户填了 9201 就永远拿不到描述符。
 */
const DEFAULT_NATIVE_PORT = 9200;


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
 *
 * **按 host 分键**：用户在设置里从 DishyMock(127.0.0.1) 切到真机（或反过来）时，
 * 不能拿上一台设备的描述符去编解码另一台。同时记下实际拿到描述符的原生端口，
 * 否则命中缓存的新实例会回到"配置端口"（可能是 9201）。
 */
const moduleDescriptorCache = new Map<string, { bytes: Uint8Array[]; nativePort: number }>();

/** 测试用：清空模块级描述符缓存 */
export function clearDescriptorCacheForTest(): void {
  moduleDescriptorCache.clear();
}

const KNOWN_FIELD_NUMBERS: Record<string, number> = {
  getStatus: 1004,
  getHistory: 1007,
  dishGetObstructionMap: 2008,
  getDeviceInfo: 1008,
  getNetworkInterfaces: 1015,
  // 公开 proto（starlink-grpc-tools / sparky8512 整理）：Request.get_location = 1017，
  // 响应 GetLocationResponse { lla { lat, lon, alt }, sigma_m, source }。
  // 只在描述符里**没有** Request 类型时才会用到这个字段号。
  getLocation: 1017,
};

/** dish 自带 GPS 给出的位置 */
export interface DishLocation {
  lat: number;
  lon: number;
  /** 海拔(m)，设备不给时缺省 */
  alt?: number;
  /** 水平误差(m) */
  sigmaM?: number;
  /** 定位来源（如 GNSS_ONLY / STARLINK_ONLY），原样透传 */
  source?: string;
}

/**
 * 从 Handle 响应里取位置。
 *
 * 字段：`getLocation.lla.{lat,lon,alt}`（json_name）。兼容 `dishGetLocation` 键与
 * 下划线命名，免得固件换个名字就整体失效。(0,0) 视为无效 —— 设备未定位时会回全 0。
 */
export function parseDishLocation(res: Record<string, unknown>): DishLocation | null {
  const body = (res.getLocation ?? res.dishGetLocation ?? res.get_location) as
    | Record<string, unknown>
    | undefined;
  if (!body || typeof body !== 'object') return null;
  const lla = (body.lla ?? body) as Record<string, unknown>;
  const lat = Number(lla.lat);
  const lon = Number(lla.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  const out: DishLocation = { lat, lon };
  const alt = Number(lla.alt);
  if (lla.alt !== undefined && Number.isFinite(alt)) out.alt = alt;
  const sigma = Number(body.sigmaM ?? body.sigma_m);
  if ((body.sigmaM ?? body.sigma_m) !== undefined && Number.isFinite(sigma)) out.sigmaM = sigma;
  if (body.source !== undefined) out.source = String(body.source);
  return out;
}

/**
 * dish 位置拿不到时的原因分类 —— 界面按它给出**可操作**的提示。
 *
 *   permission_denied：code 7。dish 默认**不对局域网开放位置**，要在 Starlink App
 *                      里打开「允许本地网络访问位置/调试数据」开关。
 *   unsupported      ：code 12，或描述符里根本没有该分支 ⇒ 固件不支持。
 *   unreachable      ：连不上设备（超时 / 拒绝连接 / 14 UNAVAILABLE / 4 DEADLINE）。
 *   no_fix           ：调用成功，但设备还没定位（全 0 或缺字段）。
 */
export type DishLocationFailure = 'permission_denied' | 'unsupported' | 'unreachable' | 'no_fix' | 'other';

export function classifyDishLocationError(message: string): DishLocationFailure {
  if (/\(code 7\)|PERMISSION_DENIED/i.test(message)) return 'permission_denied';
  if (/\(code 12\)|UNIMPLEMENTED|不认任何一个候选分支|没有已知字段号/i.test(message)) return 'unsupported';
  if (/\(code (4|14)\)|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timeout|超时|不可达/i.test(message)) {
    return 'unreachable';
  }
  return 'other';
}

/** reflection 失败后多久内不再重试（小于采集周期 30s，下一轮会重新尝试） */
const DESCRIPTOR_RETRY_MS = 15000;

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
  /**
   * 传输优先级。
   *
   * 2026-11-15 真机证据（内部验证记录，未随公开仓库发布）：
   * 9200 的 Handle **对所有已知分支都回 UNIMPLEMENTED**，而 9201 的 grpc-web
   * 正常可用 —— dishylink 也**只用 9201 调 Handle**。
   *
   * 所以默认 `true`：直接走 grpc-web；原生 9200 只作兜底。好处：
   *   - 每轮采集少掉 1 次必然失败的原生尝试（之前是 9200 失败再切 9201，
   *     每帧多一次超时等待）
   *   - 诊断模式 14 个分支不再先跑一遍"注定全挂"的原生 pass
   *
   * reflection 仍然在 9200 上（真机证据确认它在那里能通），这部分不变。
   */
  private useWebTransport = true;
  /** reflection 拿到的描述符（用于请求编码 + 响应解码） */
  private descriptorBytes: Uint8Array[] | null = null;
  private registry: ReturnType<typeof createFileRegistry> | null = null;
  /** registry 建过一次且失败 ⇒ 不再每次 RPC 都重建 + 刷告警日志 */
  private registryFailed = false;

  /** 描述符磁盘缓存路径（可空 = 不做磁盘缓存） */
  private descriptorCachePath: string | null;

  /**
   * 实际拿到描述符的端口（= 原生 gRPC 端口）。
   *
   * 用户可能把 dishPort 配成 9201（grpc-web），但 reflection 只在 9200 上
   * ⇒ 这时 nativePort 会被回落到 9200，原生传输也走 9200 ⇒ 配置不会把应用打死。
   */
  private nativePort: number;

  constructor(
    host: string,
    port: number,
    webPort: number = DEFAULT_WEB_PORT,
    descriptorCachePath?: string | null,
    /**
     * 主传输（第 5 参数）。默认 `grpc-web`，与 dishylink 一致、也与真机实测一致。
     * 测试里需要显式走原生通道的场景（本地起 gRPC 假服务）可以传 `native`。
     */
    preferTransport: 'grpc-web' | 'native' = 'grpc-web',
  ) {
    this.host = host;
    this.port = port;
    this.webPort = webPort;
    this.nativePort = port;
    this.useWebTransport = preferTransport === 'grpc-web';
    this.descriptorCachePath = descriptorCachePath
      ? perHostCachePath(descriptorCachePath, host)
      : null;
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
    const cached = moduleDescriptorCache.get(this.host);
    if (cached) {
      this.nativePort = cached.nativePort;
      return this.buildClient(cached.bytes);
    }

    const descriptor = await this.resolveDescriptor();
    return this.buildClient(descriptor);
  }

  /** 从描述符字节构建 proto-loader 客户端（connect 的后半段，可被缓存路径复用） */
  private buildClient(descriptor: Uint8Array[]): DeviceClient {
    // 用实际拿到描述符的端口（nativePort）—— 用户把 dishPort 填成 9201 时
    // 这里会用 9200，而不是去连一个不提供原生 gRPC 的端口。
    const address = `${this.host}:${this.nativePort}`;
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
              // bufbuild v2 的 FieldDescriptorProto.typeName 对 message/enum 字段才有值；
              // 格式可能是全限定（".a.b.C"）、带包名（"a.b.C"）或仅类型名（"C"）。
              // 任何非空值都当成候选符号 —— reflection 服务允许按符号查，没有不扣分。
              if (!f.typeName) continue;
              if (f.typeName.startsWith('.')) {
                refs.add(f.typeName.slice(1));
                continue;
              }
              // 相对名（protobufjs 系 reflection 会发这种）⇒ 按包作用域由内向外都试一遍，
              // reflection 只认全限定符号；查不到的会回 errorResponse，已容错
              const parts = fp.package ? fp.package.split('.') : [];
              for (let i = parts.length; i >= 0; i--) {
                refs.add([...parts.slice(0, i), f.typeName].join('.'));
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

      // 已收下的文件名 / 已定义的全限定类型名。
      //
      // ⚠️ 标准 reflection（grpc-go / @grpc/reflection）对 fileContainingSymbol
      // 返回「该文件 + 全部传递依赖」⇒ 按类型名补依赖时同一个文件会回来很多次。
      // proto-loader 遇到重复文件直接抛 `duplicate name 'X' in Namespace`
      // ⇒ 原生通道建不起来。所以按文件名去重，且已定义的类型不再去要。
      const seenFiles = new Set<string>();
      const definedTypes = new Set<string>();
      const collectDefined = (fp: { package?: string; messageType: readonly NamedLike[]; enumType: readonly { name?: string }[]; service: readonly { name?: string }[] }) => {
        const pkg = fp.package ? `${fp.package}.` : '';
        const visit = (prefix: string, m: NamedLike): void => {
          const full = `${prefix}${m.name ?? ''}`;
          definedTypes.add(full);
          for (const e of m.enumType) definedTypes.add(`${full}.${e.name ?? ''}`);
          for (const n of m.nestedType) visit(`${full}.`, n);
        };
        for (const m of fp.messageType) visit(pkg, m);
        for (const e of fp.enumType) definedTypes.add(`${pkg}${e.name ?? ''}`);
        for (const s of fp.service) definedTypes.add(`${pkg}${s.name ?? ''}`);
      };
      type NamedLike = { name?: string; nestedType: readonly NamedLike[]; enumType: readonly { name?: string }[] };

      const pump = () => {
        while (pendingFiles.length) {
          const file = pendingFiles.shift()!;
          if (requestedFiles.has(file) || definedTypes.has(file)) continue;
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
        if (errorResponse || !list?.fileDescriptorProto?.length) {
          // 某个依赖拉不到（或空响应）⇒ 不致命，继续用已有的文件。
          // 不能只看 errorMessage 非空：空消息的错误响应也要扣 inFlight，否则流永远不 end。
          inFlight = Math.max(0, inFlight - 1);
          pump();
          return;
        }
        const fresh: Uint8Array[] = [];
        for (const b of list.fileDescriptorProto) {
          let name = '';
          try {
            const fp = fromBinary(FileDescriptorProtoSchema, b);
            name = fp.name;
            if (name && seenFiles.has(name)) continue;
            collectDefined(fp);
          } catch {
            /* 解析不了的文件照收，交给下游报错 */
          }
          if (name) seenFiles.add(name);
          chunks.push(b);
          fresh.push(b);
        }
        for (const b of fresh) {
          for (const ref of collectRefs(b)) {
            if (!requestedFiles.has(ref) && !definedTypes.has(ref)) pendingFiles.push(ref);
          }
        }
        inFlight = Math.max(0, inFlight - 1);
        pump();
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
   * 为什么需要：不同固件给同一语义起的分支名可能不同（dishylink 的 protoset 与
   * DishyMock 就不同）。硬编码只能覆盖已知的几种，靠描述符推导才通用。
   * 注：2026-11-15 真机实测 `get_history`(#1007) 可用、`dish_get_history`(#2006)
   * 回 UNIMPLEMENTED（docs/DISH-CONNECTIVITY-ISSUES.md §4）。
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
    const cached = moduleDescriptorCache.get(this.host);
    if (cached) {
      this.nativePort = cached.nativePort;
      return cached.bytes;
    }
    // 刚失败过 ⇒ 直接复用那次的错误。一次 getStatus 会经 candidateBranches /
    // callNative / grpc-web 兜底三处各要一次描述符；9200 黑洞时每次白等 10s ⇒ 一帧 30s。
    if (this.descriptorFailure && Date.now() - this.descriptorFailure.at < DESCRIPTOR_RETRY_MS) {
      throw this.descriptorFailure.err;
    }
    // 采集器里 getTelemetry 与 analyzeHandoffs 并发进来 ⇒ 只跑一条 reflection 流
    if (!this.descriptorInFlight) {
      this.descriptorInFlight = this.resolveDescriptorUncached()
        .then((bytes) => {
          this.descriptorFailure = null;
          return bytes;
        })
        .catch((err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err));
          this.descriptorFailure = { at: Date.now(), err: e };
          throw e;
        })
        .finally(() => {
          this.descriptorInFlight = null;
        });
    }
    return this.descriptorInFlight;
  }

  private descriptorInFlight: Promise<Uint8Array[]> | null = null;
  private descriptorFailure: { at: number; err: Error } | null = null;

  private async resolveDescriptorUncached(): Promise<Uint8Array[]> {

    const disk = this.readDescriptorFromDisk();
    const timeoutMs = disk ? 2500 : 10000;

    // 依次尝试：配置的端口 → 默认原生端口(9200)。
    // 用户把 dishPort 填成 9201(grpc-web) 时，reflection 拿不到，
    // 这里自动回落到 9200 ⇒ 配置填错也不会让整个应用瘫掉。
    //
    // 只在「配置端口就是 grpc-web 端口」时回落，且**先试 9200**：
    //  - 对 HTTP/1.1 端口做 HTTP/2 reflection 可能要等满超时，先试它会让首帧
    //    多等一整个 timeoutMs（超出采集周期 10s 的预算）；
    //  - 其它自定义端口（如本地 mock 起在 19200）不回落 —— 否则可能静默连上
    //    同机 9200 上的另一个服务，数据来自错误的对象。
    const isWebPort = this.port === this.webPort || this.port === DEFAULT_WEB_PORT;
    const candidates = isWebPort && this.port !== DEFAULT_NATIVE_PORT
      ? [DEFAULT_NATIVE_PORT]
      : [this.port];

    let lastErr: unknown = null;
    for (const port of candidates) {
      const address = `${this.host}:${port}`;
      const probe = new grpc.Client(address, grpc.credentials.createInsecure());
      try {
        const fresh = await this.reflectFileContainingSymbol(probe, SYMBOL, timeoutMs);
        if (port !== this.port) {
          console.warn(
            `[DishGrpc] 配置端口 ${this.port} 是 grpc-web 端口（不提供 reflection），` +
            `已改用原生 gRPC 端口 ${port}；设置页请填 ${port}`,
          );
        }
        this.nativePort = port;
        moduleDescriptorCache.set(this.host, { bytes: fresh, nativePort: port });
        this.writeDescriptorToDisk(fresh);
        console.log(`[DishGrpc] reflection 成功（端口 ${port}），描述符已就绪`);
        return fresh;
      } catch (err) {
        lastErr = err;
      } finally {
        probe.close();
      }
    }

    if (disk) {
      console.warn(
        '[DishGrpc] reflection 不可用, 改用磁盘缓存的描述符:',
        lastErr instanceof Error ? lastErr.message : lastErr,
      );
      // 配置端口填成了 grpc-web 端口 ⇒ 原生通道按 9200 走（reflection 本该在那儿）。
      // 其它自定义端口（如本地 mock 起在别的端口）保持原样，不擅自改连。
      if (candidates[0] !== this.port) this.nativePort = DEFAULT_NATIVE_PORT;
      moduleDescriptorCache.set(this.host, { bytes: disk, nativePort: this.nativePort });
      return disk;
    }
    throw lastErr instanceof Error ? lastErr : new Error('reflection 失败');
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
    // 走和正常采集同一条路（含 9200 回落 + 缓存），诊断看到的就是应用实际用的描述符
    if (!this.descriptorBytes) {
      this.descriptorBytes = await this.resolveDescriptor();
    }
    return this.descriptorBytes;
  }

  /**
   * 原生 9200 是否**只**提供 reflection（业务分支一律 UNIMPLEMENTED）。
   *
   * 真机实测结论：9200 上 `Handle` 对所有业务分支都回 UNIMPLEMENTED(12)，
   * 业务实际只走 9201 grpc-web（dishylink 也只用 9201）。
   *
   * 首次拿到 code 12 时置位 ⇒ 之后不再拿 9200 当兜底试（省一次超时）。
   * 保守：只有真正观测到 12 才置位，观测不到就照旧兜底。
   */
  private nativeIsUnimplementedOnly = false;

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
          if (err) {
            // code 12 = UNIMPLEMENTED ⇒ 这台设备的 9200 不实现该分支
            if (err.code === 12) this.nativeIsUnimplementedOnly = true;
            reject(new Error(`gRPC 调用失败: ${err.message} (code ${err.code})`));
          } else resolve(res ?? {});
        }
      );
    });
  }

  /** 调用 Handle, oneof 分支名必须是 camelCase */
  private async call(request: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    // 主传输 → 兜底传输。默认主传输是 grpc-web(9201)，与 dishylink 一致；
    // 兜底成功就把主传输换过去（这台设备上兜底那条才是对的），之后不再白试。
    const webFirst = this.useWebTransport;
    const primary = webFirst ? 'grpc-web' : '原生 gRPC';
    const secondary = webFirst ? '原生 gRPC' : 'grpc-web';
    const run = (web: boolean) =>
      web ? this.callViaGrpcWeb(request, timeoutMs) : this.callNative(request, timeoutMs);

    try {
      return await run(webFirst);
    } catch (err) {
      const original = err instanceof Error ? err : new Error(String(err));

      // ⚠️ **UNIMPLEMENTED(12) 的兜底不用试**。
      // 真机实测：这台设备的**原生 gRPC(9200) 对所有分支都返回 UNIMPLEMENTED** ——
      // 因为 9200 只提供 reflection，实际业务分支只走 9201 grpc-web。
      // 所以在 grpc-web 为主传输时，兜底去问 9200 必然得到 12，
      // 白等一个超时（8~10s）还必然失败 ⇒ 采集周期被拖垮，
      // 表现就是"数据已 N 分钟未更新"。
      //
      // ⇒ 主传输失败且**兜底传输对这个请求注定 UNIMPLEMENTED** 时，
      //   直接抛主传输的错误，把秒级浪费省下来。
      const secondaryWouldBeUnimplemented =
        !webFirst && this.nativeIsUnimplementedOnly;

      if (secondaryWouldBeUnimplemented) {
        throw new Error(
          `${primary}: ${original.message}（原生 9200 对该分支固定返回 UNIMPLEMENTED，已跳过兜底）`,
        );
      }

      try {
        const res = await run(!webFirst);
        this.useWebTransport = !webFirst;
        console.warn(`[DishGrpc] ${primary} 不可用, 已切换到 ${secondary} 传输`);
        return res;
      } catch (fallbackErr) {
        const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        // 两条错误都带上：一条拒连(code 14) + 另一条 UNIMPLEMENTED(code 12) 时，
        // 只抛一条会让 callWithFallback 以为是"真错误"而不去试下一个候选分支。
        throw new Error(`${primary}: ${original.message}；${secondary}: ${fbMsg}`);
      }
    }
  }

  /** 当前主传输（诊断输出用） */
  get primaryTransport(): 'grpc-web' | 'native' {
    return this.useWebTransport ? 'grpc-web' : 'native';
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
      // bufbuild v2 的 oneof 成员**不是**顶层属性，而是挂在 oneof 名下的
      // { case, value } —— 直接写 [field.name] 会让 toBinary 抛
      // "Cannot read properties of undefined (reading 'case')"，被下面的 catch 吞掉。
      const branchValue = { $typeName: field.message.typeName };
      payload = toBinary(requestType, {
        $typeName: SYMBOL,
        id: BigInt(typeof request.id === 'number' ? request.id : 0),
        ...(field.oneof
          ? { [field.oneof.localName]: { case: field.localName, value: branchValue } }
          : { [field.localName]: branchValue }),
      } as never);
    } catch {
      // 描述符里没有 Request 类型 / 找不到分支 ⇒ 按字段号手工编码
      payload = this.encodeRequestManually(request);
    }

    // Handle 的完整方法路径：/SpaceX.API.Device.Device/Handle
    const url = `http://${this.host}:${this.webPort}/SpaceX.API.Device.Device/Handle`;
    let result;
    try {
      // 主进程用 node:http 版本 —— fetch 会自动带 sec-fetch-mode，
      // dish 的 Referer guard 可能因此回空 200（探针不带这些头却能通）。
      result = await grpcWebUnaryNode(url, payload, timeoutMs);
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
    if (this.registry || this.registryFailed) return this.registry as never;
    if (!this.descriptorBytes) {
      this.descriptorBytes = await this.resolveDescriptor();
    }
    try {
      // v2 的 createFileRegistry 收一个 FileDescriptorSet
      const set = fromBinary(
        FileDescriptorSetSchema,
        packFileDescriptorSet(this.descriptorBytes),
      );
      qualifyTypeNames(set);
      this.registry = createFileRegistry(set);
    } catch (err) {
      // 描述符不完整（缺跨文件类型引用）⇒ registry 建不起来。
      // 这时仍可以**发请求**（走手工字段号编码），只是解不了响应。
      console.warn(
        '[DishGrpc] 描述符不完整, registry 不可用:',
        err instanceof Error ? err.message : err,
      );
      this.registry = null as never;
      this.registryFailed = true;
    }
    return this.registry;
  }

  /**
   * 拉取遮挡图。
   *
   * 走 dishGetObstructionMap 分支 (#2008，真机实测)。按契约, 响应必须挂在顶层
   * `dishGetObstructionMap` 键上 —— 服务端如果只挂在 oneof 虚拟字段上,
   * 这里会拿到 undefined, 属于协议实现错误, 直接抛错而不是返回空图。
   */
  async getObstructionMap(timeoutMs = 8000): Promise<ObstructionMapResult> {
    const res = await this.call({ id: Date.now() % 100000, dishGetObstructionMap: {} }, timeoutMs);

    // 兜底键：不同固件的响应字段名可能是 dish_get_obstruction_map 或 get_obstruction_map
    const map = (res.dishGetObstructionMap ?? res.getObstructionMap) as {
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

  /**
   * 读 dish 自带 GPS 的位置（Request.get_location）。
   *
   * 为什么要它：用户机器的浏览器定位依赖 Windows 定位服务 —— 远程桌面会话 / 定位服务关闭时
   * 必然拿不到。dish 本身就有 GNSS，位置不依赖用户机器。
   *
   * 返回 null = 调用成功但设备还没定位；设备不支持/未授权会**抛错**（原因交给
   * classifyDishLocationError 分类）。
   */
  async getLocation(timeoutMs = 6000): Promise<DishLocation | null> {
    const { res } = await this.callWithFallback(
      await this.candidateBranches(['getLocation', 'dishGetLocation'], 'location'),
      timeoutMs,
      '读取 dish 位置',
    );
    return parseDishLocation(res);
  }

  close(): void {
    try { this.client?.close(); } catch { /* ignore */ }
    this.client = null;
  }
}

/**
 * 把描述符里的**相对**类型名改写成全限定名（`RouterInfo` → `.SpaceX.API.Device.RouterInfo`）。
 *
 * 为什么：protobufjs 系的 reflection 服务（`@grpc/reflection`，DishyMock 用的就是它）
 * 发出的 type_name 是相对名；proto-loader 能按作用域解析，但 bufbuild 的 registry
 * 只认全限定名 ⇒ 报 `type_name RouterInfo not found` ⇒ grpc-web 解不了码。
 * 解析规则同 protoc：从字段所在消息的作用域逐层向外找，找到第一个已定义的名字。
 */
/** protoc 的 json_name 规则：去掉下划线，下划线后的字母大写（`dish_get_status` → `dishGetStatus`） */
export function protocJsonName(name: string): string {
  let out = '';
  let upper = false;
  for (const ch of name) {
    if (ch === '_') { upper = true; continue; }
    out += upper ? ch.toUpperCase() : ch;
    upper = false;
  }
  return out;
}

export function qualifyTypeNames(set: { file: FileDesc[] }): void {
  // 全限定类型名 → 定义它的文件名
  const defined = new Map<string, string>();
  for (const f of set.file) {
    const collect = (prefix: string, m: MsgDesc): void => {
      const full = `${prefix}.${m.name}`;
      defined.set(full, f.name);
      for (const e of m.enumType) defined.set(`${full}.${e.name}`, f.name);
      for (const n of m.nestedType) collect(full, n);
    };
    const pkg = f.package ? `.${f.package}` : '';
    for (const m of f.messageType) collect(pkg, m);
    for (const e of f.enumType) defined.set(`${pkg}.${e.name}`, f.name);
  }
  const resolve = (scope: string, name: string): string => {
    if (!name || name.startsWith('.')) return name;
    let s = scope;
    for (;;) {
      const candidate = `${s}.${name}`;
      if (defined.has(candidate)) return candidate;
      if (!s) return name;
      s = s.slice(0, Math.max(0, s.lastIndexOf('.')));
    }
  };
  for (const f of set.file) {
    // 同时补 import：@grpc/reflection 发出的文件 dependency 为空，
    // 而 bufbuild 只在声明过的 import 里找跨文件类型
    const deps = new Set(f.dependency);
    const use = (name: string): string => {
      const owner = defined.get(name);
      if (owner && owner !== f.name) deps.add(owner);
      return name;
    };
    const fix = (scope: string, m: MsgDesc): void => {
      const full = `${scope}.${m.name}`;
      for (const fd of m.field) {
        if (fd.typeName) fd.typeName = use(resolve(full, fd.typeName));
        // 有的 reflection 实现（如 @grpc/reflection）发的描述符不带 json_name ⇒
        // bufbuild 的 jsonName 是 "" ⇒ toJson 把所有字段都写到 "" 键下、
        // getStatus 看到的顶层键只有一个空串。按 protoc 的规则补上。
        if (!fd.jsonName && fd.name) fd.jsonName = protocJsonName(fd.name);
      }
      for (const n of m.nestedType) fix(full, n);
    };
    const pkg = f.package ? `.${f.package}` : '';
    for (const m of f.messageType) fix(pkg, m);
    for (const sv of f.service) {
      for (const md of sv.method) {
        md.inputType = use(resolve(pkg, md.inputType));
        md.outputType = use(resolve(pkg, md.outputType));
      }
    }
    for (const d of deps) if (!f.dependency.includes(d)) f.dependency.push(d);
  }

  // bufbuild 按顺序建 registry：被 import 的文件必须排在前面
  const byName = new Map(set.file.map((f) => [f.name, f]));
  const ordered: FileDesc[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (f: FileDesc): void => {
    if (state.get(f.name)) return; // done，或成环（成环交给 registry 报错）
    state.set(f.name, 'visiting');
    for (const d of f.dependency) {
      const dep = byName.get(d);
      if (dep) visit(dep);
    }
    state.set(f.name, 'done');
    ordered.push(f);
  };
  for (const f of set.file) visit(f);
  set.file.splice(0, set.file.length, ...ordered);
}

type FileDesc = {
  name: string;
  package: string;
  dependency: string[];
  messageType: MsgDesc[];
  enumType: { name: string }[];
  service: { method: { inputType: string; outputType: string }[] }[];
};

type MsgDesc = {
  name: string;
  field: { name: string; typeName: string; jsonName: string }[];
  nestedType: MsgDesc[];
  enumType: { name: string }[];
};

/**
 * 描述符磁盘缓存按 host 分文件：`dish-descriptor.bin` → `dish-descriptor-192.168.100.1.bin`。
 *
 * 否则在设置里从 DishyMock(127.0.0.1) 切到真机后，会读到 mock 的描述符
 * （它缺 RouterInfo，registry 建不起来 ⇒ grpc-web 解不了码）。
 */
export function perHostCachePath(basePath: string, host: string): string {
  const ext = path.extname(basePath);
  const stem = ext ? basePath.slice(0, -ext.length) : basePath;
  return `${stem}-${host.replace(/[^A-Za-z0-9._-]/g, '_')}${ext}`;
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
