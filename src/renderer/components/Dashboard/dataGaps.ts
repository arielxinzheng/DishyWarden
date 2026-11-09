/**
 * 数据缺失(断流)判定 —— 「折线断开」与「灰色 Unknown 色块」的**唯一判据来源**。
 *
 * ## 要解决的问题
 *
 * 历史库只存「有数据的时刻」。采集器挂掉 31 分钟, 那 31 分钟在数据里
 * **完全不存在** —— 于是两处渲染都会撒谎:
 *
 * | 位置 | 断流期间现在的行为 | 后果 |
 * |---|---|---|
 * | 折线图 | 断流前后两个点被直接连成一条直线 | 看着像"什么都没发生"; 字段缺失时被 `?? 0` 兜底, 画出"延迟归零"的假曲线 |
 * | 状态色块条 | 空 slot 沿用前一片状态(carry-forward) | 断流 31 分钟画成一片健康的绿色 |
 *
 * ## 设计
 *
 * 判据集中在这一层, 两个组件**只消费不重算** —— 否则会出现
 * "色块条是灰的、折线却连着"这种同一张仪表盘自相矛盾的情况。
 *
 * 判据基于**时间**而不是「有没有值」: 相邻样本间隔超过 `toleranceMs`
 * 就是断流。tolerance = 采集心跳(30s) × 3 —— 容忍连续丢两个周期,
 * 第三个周期还没数据就不是抖动, 是真的断了。
 *
 * ## 三种使用方式
 *
 * ```
 *   history (稀疏, 只含有数据的时刻)
 *     │
 *     ├─ buildTimeGrid()   → 等时间间隔栅格, 空格子的 sample 为 null
 *     │                      ⇒ 折线图: null 断开, 宽度严格等于真实时长
 *     │
 *     ├─ findGaps()        → 连续缺失区间 [from, to]
 *     │                      ⇒ 色块条: slot 落在 gap 内 ⇒ 灰色 Unknown
 *     │
 *     ├─ gapMarkArea()     → 「无数据」灰带配置(延迟图/吞吐图共用)
 *     │
 *     └─ assessStaleness() → 尾部断流有多久
 *                            ⇒ 顶部"数据陈旧"提示
 * ```
 *
 * 三者共用同一套 tolerance, 所以图上断开的长度、
 * 色块条变灰的段数、横幅说的分钟数**必然一致**。
 */

import type { HistorySample } from '../../../storage/types';

/**
 * 采集心跳 —— 采集器每 30s 落一次盘。
 *
 * 与 `storage/schema.ts` 的 `SAMPLE_INTERVAL_MS` 同口径, 但那边是存储层常量,
 * 渲染层不该 import 它(带上 better-sqlite3 的类型依赖)。改采集周期时
 * 两处要一起看。
 */
export const SAMPLE_CADENCE_MS = 30_000;

/**
 * 容许连续丢几个心跳才算断流。
 *
 * 3 个 ⇒ 90s。为什么不是 2 个(60s):
 *   偶发的 IPC 抖动 + 采集器 30s 定时器漂移, 会出现"偶尔少一个点",
 *   60s 阈值会把这种正常抖动画成灰尘点, 图上一片锯齿状灰斑。
 * 为什么不是 5 个(150s):
 *   1h 视图下 150s 已经是整个图的 1/24, 断流开始得画出来。
 */
export const GAP_TOLERANCE_FACTOR = 3;

/** 栅格上限 —— 6h / 30s = 720。再多 x 轴标签就挤爆了, 只会自动加粗格子 */
export const MAX_GRID_CELLS = 720;

/** 推断出的采样间隔下限 / 上限 —— 防止脏数据(dt=0 / dt=1天)把栅格拉爆 */
const MIN_STEP_MS = 1_000;
const MAX_STEP_MS = 5 * 60_000;

/** 一段连续缺失的区间(epoch ms, 左闭右开) */
export interface GapSpan {
  /** 缺失起点 —— 通常是**上一个有样本的时刻** */
  from: number;
  /** 缺失终点 —— 通常是**下一个有样本的时刻**, 或窗口右边界 */
  to: number;
}

/* ------------------------------------------------------------------ *
 * 判据
 * ------------------------------------------------------------------ */

/**
 * 从数据本身推断采样间隔(相邻样本时间差的中位数)。
 *
 * 为什么不用固定 30s:
 *   `queryHistory` 会按时间跨度自动分桶(6h 范围桶宽 36s),
 *   样本间隔不是恒定的 30s。用中位数跟随实际粒度, 阈值才不会误判。
 *
 * 为什么用**中位数**而不是均值:
 *   一个 31 分钟的断流会把均值拉高十几倍 ⇒ 阈值跟着变大 ⇒
 *   下一段 5 分钟的断流就检测不出来了。中位数对少数极大值免疫。
 *
 * @param history 已按时间升序排列的样本
 */
export function inferStepMs(history: HistorySample[]): number {
  if (history.length < 2) return SAMPLE_CADENCE_MS;

  const deltas: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const delta = history[i].timestamp - history[i - 1].timestamp;
    if (Number.isFinite(delta) && delta > 0) deltas.push(delta);
  }
  if (deltas.length === 0) return SAMPLE_CADENCE_MS;

  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  return Math.min(MAX_STEP_MS, Math.max(MIN_STEP_MS, median));
}

/** 断流阈值 —— 相邻样本超过这个间隔就判定中间缺数据 */
export function gapToleranceMs(stepMs: number = SAMPLE_CADENCE_MS): number {
  return Math.max(SAMPLE_CADENCE_MS, stepMs) * GAP_TOLERANCE_FACTOR;
}

/**
 * 找出窗口内所有连续缺失区间。
 *
 * 三类边界:
 *   ① 头部 —— `fromMs` 到第一条样本(新装库 / 刚切到更长的时间范围)
 *   ② 中间 —— 相邻样本之间
 *   ③ 尾部 —— 最后一条样本到 `toMs`(**采集器挂掉时最常出现的形态**)
 *
 * ⚠️ 区间端点刻意用「有样本的时刻」而不是「样本时刻 ± 半个周期」:
 *    这样折线的断开点正好落在数据末端, 不会在断流前先凭空少一截。
 *
 * @param history   已按时间升序排列的样本
 * @param fromMs    窗口起点
 * @param toMs      窗口终点(一般是 now)
 * @param tolerance 断流阈值, 默认由数据自身粒度推断
 */
export function findGaps(
  history: HistorySample[],
  fromMs: number,
  toMs: number,
  tolerance: number = gapToleranceMs(inferStepMs(history)),
): GapSpan[] {
  if (!(toMs > fromMs)) return [];

  // 整窗无数据 ⇒ 整窗就是一段缺失(不能返回空数组: 空数组意味着"没有断流")
  if (history.length === 0) return [{ from: fromMs, to: toMs }];

  const gaps: GapSpan[] = [];

  const first = history[0].timestamp;
  if (Number.isFinite(first) && first - fromMs > tolerance) {
    gaps.push({ from: fromMs, to: first });
  }

  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].timestamp;
    const cur = history[i].timestamp;
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) continue;
    if (cur - prev > tolerance) gaps.push({ from: prev, to: cur });
  }

  const last = history[history.length - 1].timestamp;
  if (Number.isFinite(last) && toMs - last > tolerance) {
    gaps.push({ from: last, to: toMs });
  }

  return gaps;
}

/** 某个时刻是否落在缺失区间内 */
export function isInGap(gaps: GapSpan[], ts: number): boolean {
  for (const gap of gaps) {
    if (ts >= gap.from && ts < gap.to) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 折线图: 等时间栅格
 * ------------------------------------------------------------------ */

/** 栅格的一格 */
export interface GridCell {
  /** 该格的**时间点** —— 用作 x 轴标签, 与样本存在与否无关 */
  ts: number;
  /** 命中的样本; null = 这个时刻没有数据(断流) */
  sample: HistorySample | null;
}

/**
 * 把稀疏样本铺成等时间间隔的栅格。
 *
 * ⚠️ 为什么不能继续用 `history.forEach` 逐样本画点:
 *    样本数组里没有断流期间的任何条目, 逐点 push 就等于
 *    「假装断流从未发生, 直接跨过去连线」。栅格的空格子 = null,
 *    ECharts 遇到 null 会把折线**物理断开**, 且断口宽度严格等于真实时长
 *    (31 分钟的断流就占 31 分钟的图面宽, 不会被压成一根竖线)。
 *
 * @param history   已按时间升序排列的样本
 * @param fromMs    窗口起点
 * @param toMs      窗口终点
 * @param maxCells  渲染上限(超过则加粗格子, 而不是丢点)
 */
export function buildTimeGrid(
  history: HistorySample[],
  fromMs: number,
  toMs: number,
  maxCells: number = MAX_GRID_CELLS,
): GridCell[] {
  if (!(toMs > fromMs) || maxCells < 1) return [];

  const span = toMs - fromMs;
  // 格子宽度 = max(推断的采样间隔, 窗口/maxCells)
  //   - 采样间隔更宽 ⇒ 与数据同密度, 一格一个样本, 行为与改造前一致
  //   - 窗口/maxCells 更宽 ⇒ 数据太密, 按上限抽稀
  const step = Math.max(inferStepMs(history), span / maxCells);
  const count = Math.min(maxCells, Math.max(1, Math.round(span / step)));

  const cells: GridCell[] = Array.from({ length: count }, (_, i) => ({
    ts: fromMs + i * step,
    sample: null,
  }));

  for (const sample of history) {
    const ts = sample.timestamp;
    if (!Number.isFinite(ts) || ts < fromMs || ts > toMs) continue;
    const index = Math.min(count - 1, Math.max(0, Math.round((ts - fromMs) / step)));
    // 一格只放一个样本; 已被占用则丢弃后来的
    // (桶宽 ≈ 采样间隔时几乎不会冲突, 冲突了就说明两个样本挤进一格, 随便留一个)
    if (!cells[index].sample) cells[index].sample = sample;
  }

  return cells;
}

/* ------------------------------------------------------------------ *
 * 栅格 → 渲染用的下标区间
 * ------------------------------------------------------------------ */

/** 序列中一段连续的下标区间(左闭右闭), 用**下标**而不是时间戳 */
export interface IndexRun {
  from: number;
  to: number;
}

/**
 * 找出一维序列里所有连续的 null 段(即断流段)。
 *
 * 为什么用「下标」而不是「时间戳」:
 *   ECharts 的 `markArea` 挂在**类目轴**上, 定位方式是"第几个点",
 *   给它时间戳会被当成类目值去匹配(而类目值我们用的是格式化后的
 *   时间字符串, 匹配不上)。而这一层刚好知道哪几格是空的。
 *
 * @param items 与 x 轴一一对应的序列, null 表示该点无数据
 */
export function findNullRuns<T>(items: Array<T | null>): IndexRun[] {
  const runs: IndexRun[] = [];
  let start = -1;

  for (let i = 0; i < items.length; i++) {
    if (items[i] === null) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push({ from: start, to: i - 1 });
      start = -1;
    }
  }
  if (start >= 0) runs.push({ from: start, to: items.length - 1 });

  return runs;
}

/**
 * 「无数据」灰带的 ECharts 配置 —— 两个图表**共用这一份**。
 *
 * 为什么提到这一层:
 *   延迟图和吞吐图都要在断流处画灰带。各自写一份 markArea 的话,
 *   颜色/标签/最小宽度会在两次改动后漂开 —— 最典型的是
 *   「一段 5 分钟的断流, 一张图有灰带另一张没有」。
 *
 * ## i18n
 *
 * 灰带标签是**用户可见文案**, 本文件是纯逻辑层, 不能写死中文 ——
 * 由渲染层把翻译好的文字传进来(`label`)。两个图表都调用同一份配置,
 * 所以两个图上的灰带标签必然一致。
 *
 * ⚠️ 单格断流(`to === from`)画不出带子(宽度为 0), 过滤掉;
 *    这种情况靠折线本身断开表达就够。
 *
 * @param runs  连续 null 段(下标区间)
 * @param label 渲染层翻译好的「无数据」标签; 空串表示不显示标签
 */
export function gapMarkArea(runs: IndexRun[], label = '') {
  return {
    silent: true,
    itemStyle: { color: 'rgba(148, 163, 184, 0.12)' },
    label: { show: true, position: 'insideTop' as const, color: '#94a3b8', fontSize: 10 },
    data: runs
      .filter((run) => run.to > run.from)
      .map((run) => [
        // ⚠️ 类目轴上写**数字**表示"第几个点"(下标), 不是取值。
        //    x 轴的类目值是我们格式化后的时间字符串, 拿时间戳匹配不上。
        { xAxis: run.from, name: run.to - run.from >= 4 ? label : '' },
        { xAxis: run.to },
      ]),
  };
}

/* ------------------------------------------------------------------ *
 * 数据陈旧状态
 * ------------------------------------------------------------------ */

export interface Staleness {
  /** 最后一条样本的时刻; null = 整个窗口都没数据 */
  lastTs: number | null;
  /** 距今多久没有数据(ms)。整窗无数据时 = 整个窗口长度 */
  silentMs: number;
  /** 是否已超过断流阈值 */
  isStale: boolean;
  /** 使用的断流阈值(ms) —— 供 UI 说明"超过 X 才提示" */
  toleranceMs: number;
}

/**
 * 评估"尾部断流"—— 数据有多旧。
 *
 * 这是**最重要的一个信号**: 采集器挂掉时, 仪表盘顶部那些大数字
 * (延迟/丢包/速度)全部来自最后一次成功采集, 看起来完全正常。
 * 只有显式提示"数据已 31 分钟未更新"才不会误导。
 */
export function assessStaleness(
  history: HistorySample[],
  nowMs: number,
  toleranceMs: number = gapToleranceMs(inferStepMs(history)),
): Staleness {
  const lastTs = history.length > 0 ? history[history.length - 1].timestamp : null;

  if (lastTs === null || !Number.isFinite(lastTs)) {
    return {
      lastTs: null,
      silentMs: toleranceMs,
      isStale: true,
      toleranceMs,
    };
  }

  const silentMs = Math.max(0, nowMs - lastTs);
  return { lastTs, silentMs, isStale: silentMs > toleranceMs, toleranceMs };
}