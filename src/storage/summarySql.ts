/**
 * 区间流量估算 SQL —— 独立成纯模块，让 vitest 在不加载原生 SQLite
 * 模块（锁死在 Electron ABI）的情况下也能回归
 * 这段 LAG/封顶逻辑，见 summarySql.test.ts。
 *
 * ## 语义：按样本计流量，而不是按窗口外推
 *
 * 每个样本按它和**前一样本的实际间隔**计入流量（bps × 秒 ÷ 8 = 字节），
 * 间隔封顶为 `cap`（= 2 × 标称采集间隔）：
 *
 *   - 正常连续采集：gap ≈ 标称间隔，结果与「均值 × 覆盖时长」一致；
 *   - 漏采一两拍：gap ≤ cap，仍全额计入，不丢流量；
 *   - **停机/重启的大间隙**（gap 远大于 cap）：每个间隙后的首拍最多只计
 *     cap 秒 —— 应用没在跑的那几个小时**不再被外推成持续流量**。
 *
 * 旧实现是 `SUM(bps) × (last-first)/(n-1) / 8`，即「均值 × 首尾跨度」：
 * 应用只跑了 2.5h 而窗口跨 22.4h 时，间隔被算成 ~635s，
 * 24h 用量虚高约 21 倍（实测显示 1512 GB，实际观测约 72 GB）。
 *
 * 窗口内首样本没有 LAG（前一样本在窗口外），回退为标称间隔：
 * 它代表的一个采样间隔的流量仍然计入。
 *
 * ## 参数顺序
 *
 *   ?1 = nominalSec  标称采集间隔（秒）；也是无 LAG 时的回退间隔
 *   ?2 = capSec      单样本间隔封顶（秒），调用方传 2 × nominalSec
 *   ?3 = fromMs      窗口起点（epoch ms，含）
 *   ?4 = toMs        窗口终点（epoch ms，含）
 */
export const ESTIMATED_BYTES_SQL = `
SELECT
  COALESCE(SUM(down_bps * dt) / 8.0, 0) AS down_bytes,
  COALESCE(SUM(up_bps * dt) / 8.0, 0)   AS up_bytes
FROM (
  SELECT down_bps, up_bps,
         MIN(COALESCE((ts - LAG(ts) OVER (ORDER BY ts)) / 1000.0, ?), ?) AS dt
  FROM telemetry_samples
  WHERE ts >= ? AND ts <= ?
)
`;
