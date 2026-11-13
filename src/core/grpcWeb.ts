/**
 * gRPC-Web 传输层工具
 * 
 * 处理 Starlink dish 特有的网络限制：
 * 1. CORS 限制 - dish 只接受自身 origin
 * 2. Referer 头过滤 - 带 Referer 的请求会被拒绝
 * 3. HTTP/1.1 over gRPC-Web - dish 使用 gRPC-Web 协议
 */

/**
 * 创建代理服务器配置
 * 
 * 在 Electron 主进程中运行本地代理，绕过浏览器的 CORS 限制
 */
export interface ProxyConfig {
  localPort: number;        // 本地代理监听端口
  targetHost: string;       // 目标 dish 地址
  targetPort: number;       // 目标 dish gRPC 端口
}

/**
 * 移除可能导致请求失败的 HTTP 头
 */
export function sanitizeHeaders(headers: Headers): Headers {
  const sanitized = new Headers(headers);
  
  // Starlink dish 会拒绝这些头
  const blockedHeaders = [
    'referer',
    'origin',
    'sec-fetch-site',
    'sec-fetch-mode',
    'sec-fetch-dest',
  ];
  
  blockedHeaders.forEach(header => sanitized.delete(header));
  
  return sanitized;
}

/**
 * 检测是否需要使用代理
 * 
 * 在浏览器环境（Electron renderer）中需要代理
 * 在 Node 环境（Electron main）中可以直接连接
 */
export function shouldUseProxy(): boolean {
  // 主进程(tsconfig.electron)没有 DOM lib, 直接写 window 会报 TS2304。
  // 用 globalThis 探测: 渲染进程有 window.fetch, 主进程没有。
  const browserWindow = (globalThis as { window?: { fetch?: unknown } }).window;
  return typeof browserWindow !== 'undefined' && typeof browserWindow.fetch !== 'undefined';
}

/**
 * 构建 gRPC-Web 请求 URL
 */
export function buildGrpcWebUrl(
  host: string,
  port: number,
  serviceName: string,
  methodName: string
): string {
  return `http://${host}:${port}/${serviceName}/${methodName}`;
}

/**
 * 解析 gRPC-Web 错误
 */
export interface GrpcError {
  code: number;
  message: string;
  details?: any;
}

export function parseGrpcError(error: any): GrpcError {
  if (error.code && error.message) {
    return error;
  }
  
  return {
    code: 13, // INTERNAL
    message: error.message || 'Unknown gRPC error',
    details: error,
  };
}

/**
 * gRPC 状态码
 */
export enum GrpcStatusCode {
  OK = 0,
  CANCELLED = 1,
  UNKNOWN = 2,
  INVALID_ARGUMENT = 3,
  DEADLINE_EXCEEDED = 4,
  NOT_FOUND = 5,
  ALREADY_EXISTS = 6,
  PERMISSION_DENIED = 7,
  RESOURCE_EXHAUSTED = 8,
  FAILED_PRECONDITION = 9,
  ABORTED = 10,
  OUT_OF_RANGE = 11,
  UNIMPLEMENTED = 12,
  INTERNAL = 13,
  UNAVAILABLE = 14,
  DATA_LOSS = 15,
  UNAUTHENTICATED = 16,
}

/**
 * 将 gRPC 状态码转换为可读字符串
 */
export function getGrpcStatusName(code: number): string {
  return GrpcStatusCode[code] || 'UNKNOWN';
}

// ══════════════════════════════════════════════════════════════════
// 客户端（主进程用）：直接向 dish 的 **9201 grpc-web 端口**发 unary 调用
// ══════════════════════════════════════════════════════════════════
//
// 背景（真机实测，2026-11）：
//   dish 的两个端口是**两套协议**：
//     9200 = 原生 gRPC(HTTP/2) —— 反射服务在这里，能拿到完整 proto
//     9201 = grpc-web(HTTP/1.1) —— 同一个 Handle 方法，真机上正常工作
//   实测某些固件上 9200 的 Handle 会对我们用的请求分支回 `12 UNIMPLEMENTED`，
//   而 9201 正常。dishylink 项目（实测文档 LOCAL-API.md）也是只用 9201 调 Handle。
//
// 帧格式（grpc-web）：
//   1 字节标志 + 4 字节大端长度 + 负载
//   0x00 = protobuf 消息；0x80 = 文本 trailers（"grpc-status: 0\r\n..."）
//   出错时 grpc-status 可能只出现在 HTTP 响应头里（没有 body）。
//
// 注意：dish 的 "Referer guard" —— 带 Referer/Origin 的请求会回空的 200，
// 所以这里不发这两个头（Node fetch 默认也不发）。

const MESSAGE_FRAME = 0x00;
const TRAILERS_FRAME = 0x80;

export interface GrpcWebResult {
  /** 响应消息负载（空数组 = 没有消息体） */
  bytes: Uint8Array;
  /** grpc-status（0 = OK） */
  status: number;
  /** grpc-message */
  message: string;
}

export class GrpcWebError extends Error {
  constructor(
    public readonly grpcStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'GrpcWebError';
  }
}

/** 把 protobuf 负载包成 grpc-web 消息帧 */
export function encodeGrpcWebFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = MESSAGE_FRAME;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

/** 解析 trailers 文本里的 grpc-status / grpc-message */
export function parseGrpcWebTrailers(text: string): { status: number; message: string } {
  let status = 0;
  let message = '';
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'grpc-status') status = Number(value);
    else if (key === 'grpc-message') message = decodeURIComponent(value);
  }
  return { status, message };
}

/**
 * 发一次 grpc-web unary 调用。
 *
 * @param url 形如 `http://192.168.100.1:9201/SpaceX.API.Device.Device/Handle`
 * @param payload 已编码的 protobuf 请求体
 */
export async function grpcWebUnary(
  url: string,
  payload: Uint8Array,
  timeoutMs = 8000,
): Promise<GrpcWebResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/grpc-web+proto',
        'accept': 'application/grpc-web+proto',
        'x-grpc-web': '1',
        te: 'trailers',
      },
      // 用 ArrayBuffer 传体：TS 5.7+ 的 Uint8Array<ArrayBufferLike> 与 DOM 的
      // BodyInit 定义对不上（Buffer/视图会被判不兼容）
      body: (() => {
        const frame = encodeGrpcWebFrame(payload);
        return frame.buffer.slice(
          frame.byteOffset,
          frame.byteOffset + frame.byteLength,
        ) as ArrayBuffer;
      })(),
      signal: controller.signal,
    });

    const body = new Uint8Array(await res.arrayBuffer());

    const headerStatus = res.headers.get('grpc-status');
    const headerMessage = res.headers.get('grpc-message') ?? '';
    if (!res.ok && body.length === 0) {
      throw new GrpcWebError(
        headerStatus ? Number(headerStatus) : res.status,
        headerMessage || `HTTP ${res.status}`,
      );
    }

    let bytes = new Uint8Array(0);
    let status = headerStatus ? Number(headerStatus) : 0;
    let message = headerMessage;

    let offset = 0;
    while (offset + 5 <= body.length) {
      const flag = body[offset];
      const length = new DataView(
        body.buffer,
        body.byteOffset + offset + 1,
        4,
      ).getUint32(0, false);
      const start = offset + 5;
      const end = start + length;
      if (end > body.length) break;
      if (flag === MESSAGE_FRAME) {
        bytes = body.slice(start, end);
      } else if (flag === TRAILERS_FRAME) {
        const parsed = parseGrpcWebTrailers(new TextDecoder().decode(body.slice(start, end)));
        status = parsed.status;
        message = parsed.message;
      } else {
        throw new Error(`grpc-web 帧标志不支持: 0x${flag.toString(16)}`);
      }
      offset = end;
    }

    // 非 0 状态在这里就抛 —— 调用方不必各自记得检查 status
    if (status !== 0) {
      throw new GrpcWebError(status, message || `grpc-status ${status}`);
    }
    return { bytes, status, message };
  } finally {
    clearTimeout(timer);
  }
}