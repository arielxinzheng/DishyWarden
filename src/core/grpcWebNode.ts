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

    // ⭐ 持有响应流引用 —— 超时/出错时必须**连响应流一起销毁**。
    // 只 destroy(req) 的话：对端可能已经回了 headers、body 还在传输，
    // res 会变成"半开"的僵尸连接（agent 里占着 socket 不释放）。
    // 采集每 30s 一轮，几轮下来 socket 堆积 ⇒ 连接耗尽 ⇒
    // 表现为「数据已 N 分钟未更新」且日志里看不出原因。
    let resRef: http.IncomingMessage | null = null;

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
        resRef = res;
        watchResponseError(res);
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
      // 连响应流一起销毁 —— 否则会留下占着 socket 的半开连接
      resRef?.destroy();
      req.destroy(new Error(`grpc-web 请求超时 (${timeoutMs}ms)`));
    });
    req.on('error', (err) => {
      resRef?.destroy();
      finish(() => reject(err));
    });
    // 响应流本身出错（对方中途断开）也要让调用方知道，
    // 否则 Promise 永远挂着 ⇒ 该轮采集一直占着 collecting 标记。
    // （挂在 res 回调里，类型才收窄得住。）
    const watchResponseError = (res: http.IncomingMessage) => {
      res.on('error', (err: Error) => {
        finish(() => reject(err));
      });
    };

    req.write(Buffer.from(frame));
    req.end();
  });
}
