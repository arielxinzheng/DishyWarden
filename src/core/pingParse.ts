/**
 * ping 输出解析 —— macOS / Linux / Windows 通用。
 *
 * ## 为什么要单独抽出来
 *
 * 三平台的 ping 输出长得完全不一样，而且 **Windows 是本地化的**：
 *
 *   macOS:   round-trip min/avg/max/stddev = 1.2/2.3/3.4/0.5 ms
 *            3 packets transmitted, 3 packets received, 0.0% packet loss
 *   Linux:   rtt min/avg/max/mdev = 1.2/2.3/3.4/0.5 ms
 *            3 packets transmitted, 3 received, 0% packet loss (time 0ms)
 *   Windows: 最短 = 0ms，最长 = 2ms，平均 = 1ms
 *            已发送 = 3，已接收 = 3，丢失 = 0 (0% 丢失)
 *
 * ## Windows 的两个坑
 *
 * 1. **中文系统**：标签是中文（平均/丢失），不是 Average/loss。
 * 2. **编码错乱**：中文 Windows 的 ping 输出是 GBK，Node 按 UTF-8 解码后
 *    中文全部变成 U+FFFD 乱码 —— 任何依赖中文标签的正则都会失效。
 *
 * 所以这里的正则**只锚定 ASCII 结构**（`=`、`ms`、`(`、`%`、数字），
 * 不认任何语言的文字。乱码只发生在高位字节，ASCII 部分原样保留，
 * 因此这些模式在英文、中文、乱码三种输出上同样成立。
 */

export interface PingStats {
  /** 平均往返时延(ms)；解析不出来为 null */
  rttMs: number | null;
  /** 丢包率 0~1；解析不出来为 null（调用方决定兜底口径） */
  lossRatio: number | null;
}

/**
 * 解析 ping 输出的平均延迟与丢包率。
 *
 * 顺序设计：先 Unix（两种格式形状一致），再 Windows；
 * Windows 延迟取**最后一个** `= Xms` —— 摘要行（平均）在所有
 * 回复行（时间=Xms）之后，所以"最后一个"就是平均值。
 */
export function parsePingStats(output: string): PingStats {
  return {
    rttMs: parsePingRtt(output),
    lossRatio: parsePingLoss(output),
  };
}

/** 平均延迟(ms) */
export function parsePingRtt(output: string): number | null {
  // macOS / Linux: "round-trip min/avg/max/stddev = 1.2/2.3/3.4/0.5 ms"
  //               "rtt min/avg/max/mdev = 1.2/2.3/3.4/0.5 ms"
  // 两种平台的形状一样：四个斜杠分隔的小数，第二个是 avg。
  const unix = output.match(/=\s*[\d.]+\/([\d.]+)\/[\d.]+\/[\d.]+\s*ms/);
  if (unix) return parseFloat(unix[1]);

  // Windows 摘要行: "Average = 2ms" / "平均 = 2ms"（中文标签可能是乱码）
  // 取最后一个 `= Xms`；`<1ms` 按 1 算（Windows 打印小于 1ms 的方式）。
  const all = [...output.matchAll(/=\s*<(\d+)\s*ms|=\s*(\d+)\s*ms/g)];
  if (all.length === 0) return null;
  const last = all[all.length - 1]!;
  const value = last[1] ?? last[2];
  return value ? parseInt(value, 10) : null;
}

/** 丢包率(0~1) */
export function parsePingLoss(output: string): number | null {
  // macOS / Linux: "0.0% packet loss" / "0% packet loss"
  const unix = output.match(/([\d.]+)%\s*packet loss/);
  if (unix) return parseFloat(unix[1]) / 100;

  // Windows: "(0% loss)" / "(0% 丢失)" —— 只锚定括号和百分号，
  // 对英文、中文、GBK 乱码三种输出同样成立。
  const win = output.match(/\((\d+)%/);
  if (win) return parseInt(win[1], 10) / 100;

  return null;
}
