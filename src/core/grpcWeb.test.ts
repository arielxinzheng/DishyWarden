/**
 * grpc-web 传输层单元测试。
 *
 * 真机上 9201 的 grpc-web 通道只能在有 dish 的环境验证，
 * 但**帧编解码**是纯逻辑，这里用本地 http server 覆盖。
 */

import { describe, it, expect } from 'vitest';
import http from 'node:http';
import {
  encodeGrpcWebFrame,
  parseGrpcWebTrailers,
  grpcWebUnary,
  GrpcWebError,
} from './grpcWeb';

/** 构造一个 grpc-web 响应：消息帧 + trailers 帧 */
function buildWebResponse(payload: Buffer, status = 0, message = ''): Buffer {
  const msgFrame = Buffer.alloc(5 + payload.length);
  msgFrame[0] = 0x00;
  msgFrame.writeUInt32BE(payload.length, 1);
  payload.copy(msgFrame, 5);

  const trailerText = `grpc-status: ${status}\r\ngrpc-message: ${encodeURIComponent(message)}\r\n`;
  const trailerBuf = Buffer.from(trailerText, 'ascii');
  const trailerFrame = Buffer.alloc(5 + trailerBuf.length);
  trailerFrame[0] = 0x80;
  trailerFrame.writeUInt32BE(trailerBuf.length, 1);
  trailerBuf.copy(trailerFrame, 5);

  return Buffer.concat([msgFrame, trailerFrame]);
}

describe('grpc-web 帧编码', () => {
  it('消息帧 = 0x00 + 4 字节大端长度 + 负载', () => {
    const payload = Buffer.from([0x08, 0x01]);
    const frame = encodeGrpcWebFrame(payload);
    expect(frame[0]).toBe(0x00);
    expect(new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, false)).toBe(2);
    expect(Buffer.from(frame.slice(5))).toEqual(payload);
  });
});

describe('grpc-web trailers 解析', () => {
  it('取 grpc-status / grpc-message', () => {
    const parsed = parseGrpcWebTrailers('grpc-status: 12\r\ngrpc-message: boom\r\n');
    expect(parsed.status).toBe(12);
    expect(parsed.message).toBe('boom');
  });

  it('缺字段时 status 为 0', () => {
    expect(parseGrpcWebTrailers('other: 1\r\n').status).toBe(0);
  });
});

describe('grpcWebUnary', () => {
  it('解析消息帧 + trailers 帧', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/grpc-web+proto' });
      res.end(buildWebResponse(Buffer.from([0x0a, 0x02, 0x68, 0x69]), 0, ''));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    try {
      const out = await grpcWebUnary(`http://127.0.0.1:${port}/x`, Buffer.from([0x08, 0x01]));
      expect(out.status).toBe(0);
      expect(Buffer.from(out.bytes)).toEqual(Buffer.from([0x0a, 0x02, 0x68, 0x69]));
    } finally {
      server.close();
    }
  });

  it('非 0 状态要抛 GrpcWebError（带 code）', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/grpc-web+proto' });
      res.end(buildWebResponse(Buffer.alloc(0), 12, 'unimplemented'));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    try {
      await expect(
        grpcWebUnary(`http://127.0.0.1:${port}/x`, Buffer.from([0x08, 0x01])),
      ).rejects.toBeInstanceOf(GrpcWebError);
    } finally {
      server.close();
    }
  });

  it('HTTP 错误且无 body 时按 HTTP 状态码抛', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    try {
      await expect(
        grpcWebUnary(`http://127.0.0.1:${port}/x`, Buffer.from([0x08, 0x01])),
      ).rejects.toBeInstanceOf(GrpcWebError);
    } finally {
      server.close();
    }
  });
});
