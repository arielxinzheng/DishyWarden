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