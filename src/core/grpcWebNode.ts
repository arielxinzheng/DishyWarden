/**
 * grpc-web unary 调用的 **Node 专用**实现（主进程用）。
 *
 * ## 为什么不用 fetch
 *
 * Node 18+ 的 `fetch`（undici）会**自动**加一个浏览��风格的头：
 *
 * ```
 * sec-fetch-mode: cors
 * ```
 *
 * 而 dish 有 "Referer guard" —— 带 Referer/Origin 的请求会回**空的 200**
 * （dishylink 实测：dish 会拒绝携带 Referer/Origin 的请求）。
 * 如果 guard 也覆盖 `sec-fetch-*`，那么：
 *
 * * 我们的**裸 TCP 探针**（verify-dish.ps1，不带这些头）→ 成功拿到数据 ✅
 * * 应用的 **fetch 请求**（带 `sec-fetch-mode`）→ 空 200 / 解析不出字段 ❌
 *
 * ⇒ 探针能通、应用却不通，排查起来极其误导。
 *
 * `node:http` 不会加任何浏览器头，我们可以**精确控制**请求头，
 * 让应用发出的请求和探针完全等价（探针能通 ⇒ 应用就该能通）。
 *
 * 渲染层不使用本文件（`grpcWeb.ts` 的 fetch 版仍保留给浏览器/单测使用）。
 */

import http from 'node:http';
import { encodeGrpcWebFrame, parseGrpcWebTrailers, GrpcWebError } from './grpcWeb';

const MESSAGE_FRAME = 0x00;
const TRAILERS_FRAME = 0x80;

/**
 * 发一次 grpc-web unary 调用（Node 环境，请求头完全可控）。
 *
 * @param url 形如 `http://192.168.100.1:9201/SpaceX.API.Device.Device/Handle`
 * @param payload 已编码的 protobuf 请求体
 */
export async function grpcWebUnaryNode(
  url: string,
  payload: Uint8Array,
  timeoutMs = 8000,
): Promise<{ bytes: Uint8Array; status: number; message: string }> {
  const target = new URL(url);
  const frame = encodeGrpcWebFrame(payload);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const req = http.request(
      {
        host: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: 'POST',
        // 明确列全请求头 —— 不带 referer/origin/sec-fetch-*，
        // 与 verify-dish.ps1 的裸 TCP 探针保持一致。
        headers: {
          host: target.host,
          'content-type': 'application/grpc-web+proto',
          accept: 'application/grpc-web+proto',
          'x-grpc-web': '1',
          te: 'trailers',
          'content-length': String(frame.length),
          'user-agent': 'DishyWarden',
          connection: 'close',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          finish(() => {
            const body = new Uint8Array(Buffer.concat(chunks));
            const headerStatus = res.headers['grpc-status'];
            const headerMessage = (res.headers['grpc-message'] as string) ?? '';

            if (!res.statusCode || res.statusCode >= 400) {
              reject(
                new GrpcWebError(
                  headerStatus ? Number(headerStatus) : res.statusCode ?? 0,
                  headerMessage || `HTTP ${res.statusCode}`,
                ),
              );
              return;
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
                const parsed = parseGrpcWebTrailers(
                  new TextDecoder().decode(body.slice(start, end)),
                );
                status = parsed.status;
                message = parsed.message;
              } else {
                reject(new Error(`grpc-web 帧标志不支持: 0x${flag.toString(16)}`));
                return;
              }
              offset = end;
            }

            if (status !== 0) {
              reject(new GrpcWebError(status, message || `grpc-status ${status}`));
              return;
            }
            resolve({ bytes, status, message });
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`grpc-web 请求超时 (${timeoutMs}ms)`));
    });
    req.on('error', (err) => {
      finish(() => reject(err));
    });

    req.write(Buffer.from(frame));
    req.end();
  });
}
