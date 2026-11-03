/**
 * `ProbeRunner.stop()` 的生命周期测试
 *
 * ## 为什么需要这条测试
 *
 * `stop()` 原本只清定时器, **在飞的那次探测还在跑** ——
 * `runProbe()` 是异步的(带超时, 最长几秒), 它 resolve 之后
 * `probeAndRecord` 仍会 `emit('result')`。
 *
 * 退出时序:
 *   1. `before-quit` ⇒ `stopBackgroundServices()` ⇒ `probeRunner.stop()`
 *   2. 此时窗口/渲染进程可能已被销毁
 *   3. 在飞的那次探测 resolve ⇒ emit ⇒ 往已销毁的 frame 推
 *      ⇒ "Error sending from webFrameMain: Render frame was disposed"
 *
 * ⇒ `stop()` 之后**不应该**再有 `result` 事件。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProbeRunner } from './probeRunner';
import type { ProbeConfig } from '../config/manager';

const config: ProbeConfig = {
  traceTarget: 'example.com',
  nodes: [
    {
      id: 'n1',
      name: '测试节点',
      target: '127.0.0.1',
      type: 'icmp',
      intervalSec: 3600,   // 极长 ⇒ 不会自然触发第二次, 只测首次
      timeoutSec: 5,
      enabled: true,
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProbeRunner.stop()', () => {
  it('停止后不再发出 result 事件', async () => {
    const runner = new ProbeRunner(config);
    const onResult = vi.fn();
    runner.on('result', onResult);

    runner.start();
    // 首次探测是**立即**发起的(start 里 void this.probeAndRecord(node))
    await new Promise(r => setTimeout(r, 150));

    // 立刻停掉 —— 在飞的探测还没 resolve
    runner.stop();

    // 等足够久, 让在飞的那次探测 resolve
    await new Promise(r => setTimeout(r, 3000));

    expect(onResult).not.toHaveBeenCalled();
  }, 20000);

  it('停止后再 start() 能恢复正常', async () => {
    const runner = new ProbeRunner(config);
    const onResult = vi.fn();
    runner.on('result', onResult);

    runner.start();
    runner.stop();
    await new Promise(r => setTimeout(r, 200));

    // 重启 ⇒ stopped 标记被清掉 ⇒ 探测能重新发事件
    runner.start();
    await new Promise(r => setTimeout(r, 3000));

    expect(onResult).toHaveBeenCalled();
    runner.stop();
  }, 20000);
});
