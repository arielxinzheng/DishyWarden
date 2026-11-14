import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { grpcWebUnaryNode } from './grpcWebNode';
import { encodeGrpcWebFrame } from './grpcWeb';

/** 起一个假 grpc-web 服务，返回 [消息帧][trailers 帧]，并记录收到的头 */
function startFakeServer(status = 0): Promise<{
  port: number;
  headers: Record<string, string | string[] | undefined>;
  close: () => void;
}> {
  return new Promise((resolve) => {
    const headers: Record<string, string | string[] | undefined> = {};
    const server = http.createServer((req, res) => {
      Object.assign(headers, req.headers);
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const payload = Buffer.from([0x0a, 0x02, 0x68, 0x69]);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(payload.length, 0);
        const msg = Buffer.concat([Buffer.from([0x00]), len, payload]);
        const tr = Buffer.from(`grpc-status: ${status}\r\ngrpc-message: fake\r\n`, 'ascii');
        const trLen = Buffer.alloc(4);
        trLen.writeUInt32BE(tr.length, 0);
        const trailers = Buffer.concat([Buffer.from([0x80]), trLen, tr]);
        const out = Buffer.concat([msg, trailers]);
        res.writeHead(200, {
          'content-type': 'application/grpc-web+proto',
          'content-length': String(out.length),
        });
        res.end(out);
      });
    });
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, headers, close: () => server.close() });
    });
  });
}

describe('grpcWebUnaryNode', () => {
  it('请求里不含 referer/origin/sec-fetch-*（dish 的 Referer guard）', async () => {
    const fake = await startFakeServer(0);
    try {
      await grpcWebUnaryNode(
        `http://127.0.0.1:${fake.port}/SpaceX.API.Device.Device/Handle`,
        Buffer.from([0x08, 0x01]),
        5000,
      );
      const names = Object.keys(fake.headers).map((h) => h.toLowerCase());
      for (const banned of ['referer', 'origin', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest']) {
        expect(names, `不应带 ${banned}`).not.toContain(banned);
      }
      expect(String(fake.headers['content-type'])).toContain('grpc-web+proto');
      expect(String(fake.headers['x-grpc-web'])).toBe('1');
    } finally {
      fake.close();
    }
  });

  it('解析消息帧与 trailers 帧', async () => {
    const fake = await startFakeServer(0);
    try {
      const out = await grpcWebUnaryNode(
        `http://127.0.0.1:${fake.port}/x`,
        Buffer.from([0x08, 0x01]),
        5000,
      );
      expect(out.status).toBe(0);
      expect(Buffer.from(out.bytes).toString('hex')).toBe('0a026869');
    } finally {
      fake.close();
    }
  });

  it('grpc-status 非 0 时抛 GrpcWebError', async () => {
    const fake = await startFakeServer(12);
    try {
      await expect(
        grpcWebUnaryNode(`http://127.0.0.1:${fake.port}/x`, Buffer.from([0x08, 0x01]), 5000),
      ).rejects.toMatchObject({ grpcStatus: 12 });
    } finally {
      fake.close();
    }
  });

  it('帧编码与 fetch 版共用同一套实现', () => {
    // 0x00 标志 + 4 字节大端长度(2) + 负载 08 01
    expect(Buffer.from(encodeGrpcWebFrame(Buffer.from([0x08, 0x01]))).toString('hex')).toBe(
      '00000000020801',
    );
  });
});
