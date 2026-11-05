/**
 * 场景 A 判定的回归测试 —— isFirstInstallFailure
 *
 * 判定逻辑见 firstInstall.ts 头注释。这里钉死四个边界:
 *   1. 真首次安装(连接失败 + 零数据) → true
 *   2. 运行中断连(连接失败 + 有历史) → false, 走原有降级 UI
 *   3. 正常首帧(连接成功 + 库还没写入) → false, 不闪引导页
 *   4. 库统计拿不到(IPC 失败) → false, 安全侧降级
 */
import { describe, it, expect } from 'vitest';
import { isFirstInstallFailure } from './firstInstall';

describe('isFirstInstallFailure — 场景 A: 首次安装采集失败', () => {
  it('连接失败 + 库为空 → 判定首次安装(渲染引导页)', () => {
    expect(isFirstInstallFailure(true, { sampleCount: 0 })).toBe(true);
  });

  it('连接失败 + 库有历史 → 不是首次安装(运行中断连, 显示陈旧横幅而非引导页)', () => {
    // 运行中拔电 30 分钟: error && !telemetry 满足, 但历史库非空
    expect(isFirstInstallFailure(true, { sampleCount: 2880 })).toBe(false);
  });

  it('连接正常 → 永不进入引导页(即使库是空的, 30s 后就有数据)', () => {
    // 应用刚启动, 第一次采样还没落库, 但 gRPC 已通
    expect(isFirstInstallFailure(false, { sampleCount: 0 })).toBe(false);
  });

  it('库统计拿不到(null) → 降级为非首次安装, 不抢占原有错误 UI', () => {
    // get-storage-stats 失败/非 Electron: 拿不到证据时不抢占路由
    expect(isFirstInstallFailure(true, null)).toBe(false);
  });

  it('边界: sampleCount=1(恰好一条记录) → 不是首次安装', () => {
    // 只要成功采集过一次就说明环境曾经配通过, 问题在设备侧而非安装侧
    expect(isFirstInstallFailure(true, { sampleCount: 1 })).toBe(false);
  });
});
