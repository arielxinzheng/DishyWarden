/**
 * 延迟与丢包走势图表组件
 * 支持Public/PoP/Gateway三种模式切换，显示延迟、丢包率和卫星切换事件
 */

import ReactECharts from 'echarts-for-react';
import { useTranslation } from 'react-i18next';
import { formatTimeLabel } from '../../../core/telemetry';
import type { HistorySample } from '../../../storage/types';
import type { HandoffEvent } from '../../../core/outageAnalyzer';
import {
  LATENCY_DIMENSIONS,
  DEFAULT_MODE,
  showsSatelliteHandoffs,
  type LatencyMode,
} from './latencyModes';
import {
  computeLatencyAxisScale,
  computeLatencyPeak,
  quantizeAxisMax,
} from './latencyAxis';
import {
  resolveHandoffsVisible,
  withToggledOverride,
  type HandoffOverrides,
  type TimeRangeKey,
} from './handoffVisibility';
import { buildTimeGrid, findNullRuns, gapMarkArea, type IndexRun } from './dataGaps';
import { useEffect, useRef, useState } from 'react';

interface LatencyChartProps {
  height?: number;
  /** 由上层统一获取, 组件只负责渲染, 不再自己发起查询 */
  history: HistorySample[];
  isLoading?: boolean;
  /**
   * 图表时间窗 —— 必须与「状态色块条」**完全一致**。
   *
   * 为什么不让组件自己算 `Date.now() - range`:
   *   状态条和折线要视觉对齐(看到红块, 往右看折线就有尖刺),
   *   两个组件各自取 now 会差出几百毫秒 ⇒ 断流的灰带和灰块错位。
   *   由上层派生一次、两边共用, 是 X 轴对齐的前提。
   */
  fromMs: number;
  toMs: number;
  /**
   * 全局时间范围 —— 决定卫星切换标记的**默认**可见性。
   *
   * 15m 默认开(事件稀疏), 1H/6H 默认关(事件密集会糊住折线)。
   * 用户手动点过图例后, 以用户的选择为准。
   */
  timeRange?: TimeRangeKey;
  /**
   * 卫星切换事件(来自 dishGetHistory 的 outages)。
   *
   * ## 为什么需要这个 prop
   *
   * 之前切换点是从 `satelliteId` 的变化推出来的 ——
   * 但**协议里根本没有 satelliteId 字段**(DishyMock 的 proto 没有,
   * 真实设备也不提供), 实测该字段恒为 0 ⇒ `0 !== 0` 永远不成立
   * ⇒ **图上一个切换点都不会出现**。
   *
   * 真正可靠的数据源是 `dishGetHistory` 返回的 `outages[]`:
   * 设备在卫星切换时会记一条中断(cause = HANDOFF / SWITCHING /
   * NO_DOWNLINK 等), 这才是「切换事件」的权威来源。
   */
  handoffs?: HandoffEvent[];
}

export function LatencyChart({
  height = 260,
  history,
  isLoading = false,
  fromMs,
  toMs,
  handoffs = [],
  timeRange = '1h',
}: LatencyChartProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<LatencyMode>(DEFAULT_MODE);
  /**
   * 用户对卫星切换标记的**手动**选择, **按时间范围分别记忆**。
   *
   * 某个键不存在 = 用户还没在这个范围点过图例 ⇒ 用该范围的默认值
   * (`15m` 开 / `1h`、`6h` 关)。
   *
   * 为什么按范围分别记:
   *   - 用户点图例必须**立刻见效** —— 点了没反应是坏的
   *   - 但每个范围要保留自己的默认值 —— 否则在 15m 里点一下,
   *     切到 1H 就会看到一堆密集的 ★ 糊住折线
   */
  const [handoffOverrides, setHandoffOverrides] = useState<HandoffOverrides>({});

  /**
   * 卫星切换标记当前是否显示。
   *
   * 三层判据(见 handoffVisibility.ts):
   *   ① 延迟维度 —— Local(网关)模式**永远不显示**(本地链路不经卫星)
   *   ② 时间范围 —— 15m 默认开, 1H/6H 默认关
   *   ③ 用户手动 —— 该范围点过图例就以用户的选择为准
   */
  const handoffsVisible = resolveHandoffsVisible(timeRange, handoffOverrides);
  /** 图层是否要画 —— Local 模式一律不画 */
  const showHandoffSeries = showsSatelliteHandoffs(mode) && handoffsVisible;
  /**
   * Y 轴目标量程（顶格 + 刻度间隔）。
   *
   * 两者必须**一起**定 —— 间隔是顶格的函数(ECharts 用 nice(span/splitNumber)),
   * 顶格变了间隔就会跳, 刻度整排重排, 过渡就不是"平滑拉伸"而是闪烁。
   */
  const [targetScale, setTargetScale] = useState(() => computeLatencyAxisScale(0));
  /**
   * Y 轴**当前显示**的顶格。
   *
   * 用 rAF 缓动追向目标 ⇒ 标签切换 / 峰值变化时是"平滑拉伸",
   * 而不是 ECharts 直接跳变。
   */
  const [axisMax, setAxisMax] = useState<number>(() => computeLatencyAxisScale(0).max);
  /**
   * 动画的**连续**进度值(不量化)。
   *
   * ⚠️ 必须与 `axisMax` 分开 ——
   *   之前把量化后的值直接拿去缓动, 于是每帧的 diff 都是"跳一整格",
   *   4 帧就跑完了, 看着是"跳变"而不是"拉伸"。
   *   分开之后: 连续值负责缓动曲线, 显示值负责取整 ——
   *   观感是平滑的台阶(每格一个间隔), 而不是几级瞬跳。
   */
  const animValueRef = useRef<number>(computeLatencyAxisScale(0).max);
  /**
   * 上一次**落定**时的刻度间隔。
   *
   * 用来在下一段过渡开始时选一个「不细于两端」的间隔:
   * 缩小方向(如 200 → 10)若用目标的 2ms 细间隔, 会瞬出 85 个刻度 ——
   * 既挤爆标签, ECharts 还会因避让而丢掉 0 标签。
   */
  const settledIntervalRef = useRef<number>(computeLatencyAxisScale(0).interval);
  /**
   * 本次过渡期间**钉死**的刻度间隔。
   *
   * 钉死 ⇒ 整个动画过程中网格线原地不动, 只有顶边在移动。
   * 落定后交还给目标量程的自然间隔(见下面的 effectiveInterval)。
   */
  const [pinnedInterval, setPinnedInterval] = useState<number>(
    () => computeLatencyAxisScale(0).interval,
  );
  /** 上一个目标量程 —— 用于识别「开始了一段新过渡」 */
  const lastTargetRef = useRef<{ max: number; interval: number }>(targetScale);
  const [chartData, setChartData] = useState<{
    time: string[];
    latency: Array<number | null>;
    loss: Array<number | null>;
    satellites: Array<[number, number]>;
    /** 断流区间(栅格下标) —— 用来画"无数据"灰带 */
    gaps: IndexRun[];
  }>({
    time: [],
    latency: [],
    loss: [],
    satellites: [],
    gaps: [],
  });

  useEffect(() => {
    if (!(toMs > fromMs)) return;

    // 等时间栅格: 每个采样周期一格, 没数据的格子 sample = null。
    //
    // ⚠️ 为什么不再 `history.forEach` 逐样本画点 ——
    //    样本数组只包含**有数据的时刻**, 断流期间一个条目都没有。
    //    逐点 push 的话, 断流前后两个点会被 ECharts 直接连成一条直线,
    //    视觉上"什么都没发生"; 更糟的是字段缺失时原来走 `?? 0` 兜底,
    //    会把"没采到"画成"延迟 0ms" —— 那是极速, 是最严重的误导。
    //
    //    改栅格之后: 断流区是一段 null ⇒ 折线**物理断开**,
    //    且断口宽度严格等于真实时长(31 分钟就占 31 分钟的图面宽)。
    const grid = buildTimeGrid(history, fromMs, toMs);

    const time: string[] = [];
    const latency: Array<number | null> = [];
    const loss: Array<number | null> = [];
    const satellites: Array<[number, number]> = [];

    // 栅格的时间戳, 用来把 handoff 时间映射到 x 轴下标
    const sampleTimestamps: number[] = grid.map((cell) => cell.ts);

    for (const cell of grid) {
      time.push(formatTimeLabel(cell.ts) ?? '');
      if (!cell.sample) {
        // 断流: 两个序列都留 null, 折线在此断开
        latency.push(null);
        loss.push(null);
        continue;
      }
      latency.push(pickLatency(cell.sample, mode));
      loss.push(toLossPercent(cell.sample.popPingDropRate));
    }

    // 卫星切换点。
    //
    // 数据源是 `dishGetHistory` 的 outages[] —— 设备在切换时记一条中断。
    //
    // ⚠️ 原来靠 `satelliteId` 变化来判, 但**协议里没有这个字段**
    // (DishyMock 的 proto 没有, 真实设备也不提供), 实测恒为 0
    // ⇒ `0 !== 0` 永远不成立 ⇒ 图上一个点都不出现。
    //
    // 把 handoff 的时间戳映射到最近的采样下标(采样间隔 30s, 切换更密,
    // 所以取**最近**的那个点, 而不是等一个精确匹配)。
    //
    // ⚠️ Local(网关)模式下**必须清空** —— 本地链路不经卫星,
    // 标切换点是语义错误(会把本地故障误指向卫星)。
    //
    // ⚠️ 用户点掉图例时也必须清空 —— 需求是"星星瞬间消失",
    // 只把 series 的 `show` 设成 false 的话, ECharts 仍会把它
    // 算进 tooltip 的命中测试, 而且数据留在 option 里,
    // 下一次 setOption 判定 series 列表变化时容易闪回。
    // 清空数据 + 关图层, 两道都做。
    if (
      showHandoffSeries &&
      handoffs.length > 0 &&
      sampleTimestamps.length > 0
    ) {
      const usedIndices = new Set<number>();
      for (const h of handoffs) {
        let bestIndex = -1;
        let bestDelta = Infinity;
        for (let i = 0; i < sampleTimestamps.length; i++) {
          const delta = Math.abs(sampleTimestamps[i] - h.timestamp);
          if (delta < bestDelta) {
            bestDelta = delta;
            bestIndex = i;
          }
        }
        // 超出采样窗口(比如 handoff 比历史还新)就不画
        if (bestIndex < 0 || bestDelta > 5 * 60 * 1000) continue;
        // ⚠️ 断流处的格子没有延迟值可挂 —— 星星标在 null 上会被
        //    ECharts 静默丢弃, 但 tooltip 命中测试仍会算它,
        //    所以显式跳过。
        const y = latency[bestIndex];
        if (y === null) continue;
        // 同一个采样点只标一次(避免密集切换叠成一个粗点)
        if (usedIndices.has(bestIndex)) continue;
        usedIndices.add(bestIndex);
        satellites.push([bestIndex, y]);
      }
    }

    setChartData({ time, latency, loss, satellites, gaps: findNullRuns(latency) });

    // Y 轴目标量程: 按当前可见数据的峰值取整(最小值恒为 0)
    // 顶格与刻度间隔一起算 —— 间隔是顶格的函数, 分开算会各自漂移。
    // 峰值计算会跳过 null(断流处), 见 latencyAxis.computeLatencyPeak。
    setTargetScale(computeLatencyAxisScale(computeLatencyPeak(latency)));
  }, [history, mode, handoffs, showHandoffSeries, fromMs, toMs]);

  // 目标量程变化 ⇒ 开始新的一段过渡, 锁定这次的刻度间隔。
  //
  // ⚠️ 只在**目标变化**时算一次 —— 若放进动画 effect 里,
  //   interval 会每帧被重算, 钉死就失效了。
  //
  // ⚠️ 用 `settledIntervalRef` 而不是「累积的最大值」——
  //   累积会让间隔只增不减(50 → 100 → 200 …), 用几个来回后
  //   顶格 10ms 的图也会用 200ms 的间隔, 标签只剩 [0, 10]。
  useEffect(() => {
    if (lastTargetRef.current.max === targetScale.max) return;
    lastTargetRef.current = targetScale;
    const pinned = Math.max(settledIntervalRef.current, targetScale.interval);
    setPinnedInterval(pinned);
  }, [targetScale]);

  /**
   * Y 轴顶格的平滑过渡。
   *
   * 用 rAF 每帧把显示值向目标逼近(指数缓动), 到位后停在精确值上 ——
   * 最终标签一定落在阶梯值上, 中途只是过渡。
   *
   * 为什么不用 ECharts 的 universalTransition:
   * 它只对**数据**做过渡, 坐标轴的 min/max 是直接赋值的, 会跳变。
   */
  useEffect(() => {
    const targetMax = targetScale.max;
    // 量化用**钉死的间隔**, 不用目标间隔 ——
    //   缩小方向若用目标间隔, 中途的 max 会落在细间隔的格点上,
    //   顶边标签碎成 2/4/6…; 钉死则全程都是同一把尺子。
    const interval = pinnedInterval;
    if (targetMax === axisMax) return;

    let raf = 0;
    const step = () => {
      // 1) 连续值缓动(指数衰减, 每帧走完剩余量的 15%)
      const next = animValueRef.current + (targetMax - animValueRef.current) * 0.15;
      animValueRef.current = Math.abs(targetMax - next) < 0.01 ? targetMax : next;

      // 2) 显示值量化到刻度间隔的整数倍
      //
      //    ⚠️ 必须量化, 不能让 max 停在非整刻度上 ——
      //    ECharts 会把 extent[1](顶边)额外塞进刻度列表,
      //    于是会出现:
      //      max=10.40 → labels=[0,2,4,6,8,10,**10**]  ← 顶部标签重复
      //      max=171.5 → labels=[**2**,4,...,170]        ← 底部 0 标签消失
      //    量化后 max 永远是间隔的整数倍 ⇒ 顶边就是最后一个刻度,
      //    不会重复也不会丢 0。
      setAxisMax(quantizeAxisMax(animValueRef.current, interval, targetMax));

      if (animValueRef.current !== targetMax) {
        raf = requestAnimationFrame(step);
      } else {
        // 落定 ⇒ 记住这段量程的自然间隔, 供下一段过渡选间隔用。
        settledIntervalRef.current = targetScale.interval;
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [targetScale, axisMax, pinnedInterval]);

  /**
   * 实际生效的刻度间隔。
   *
   * - 过渡中 ⇒ 用钉死的 `pinnedInterval`(网格线原地不动)
   * - 落定后 ⇒ 用目标量程的自然间隔(与 ECharts 自己算的一致)
   */
  const effectiveInterval =
    axisMax === targetScale.max ? targetScale.interval : pinnedInterval;

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#111a28',
      borderColor: '#334155',
      textStyle: {
        color: '#e2e8f0',
      },
      formatter: (params: any) => {
        const items: any[] = Array.isArray(params) ? params : [params];
        const axisValue = items.length > 0 ? items[0].axisValue : '';
        const rows: string[] = [];

        for (const item of items) {
          // ⚠️ 断流处的值是 null —— 直接 `.toFixed()` 会在渲染期抛异常,
          //    异常会冒到 ErrorBoundary 把整页换成白屏。
          if (item.value === null || item.value === undefined) continue;

          // ⚠️ 用 **seriesIndex** 而不是 seriesName 识别序列 ——
          //    seriesName 已本地化, 拿中文/英文名做 if 判断会在切语言后失效。
          if (item.seriesIndex === 0) {
            rows.push(
              t('dashboard:chart.tooltip_latency', {
                marker: item.marker,
                value: Number(item.value).toFixed(1),
              }),
            );
          } else if (item.seriesIndex === 1) {
            rows.push(
              t('dashboard:chart.tooltip_loss', {
                marker: item.marker,
                value: Number(item.value).toFixed(2),
              }),
            );
          } else if (item.seriesIndex === 2) {
            rows.push(t('dashboard:chart.tooltip_handoff'));
          }
        }

        // 该时刻一个值都没有 ⇒ 明确说"数据缺失", 别留一个空 tooltip
        if (rows.length === 0) {
          return `${axisValue}<br/>${t('dashboard:chart.tooltip_no_data')}`;
        }
        return `${axisValue}<br/>${rows.join('<br/>')}`;
      },
    },
    grid: {
      left: 46,
      right: 46,
      top: 18,
      bottom: 30,
    },
    xAxis: {
      type: 'category',
      data: chartData.time,
      axisLine: {
        lineStyle: {
          color: '#334155',
        },
      },
      axisLabel: {
        color: '#64748b',
        fontSize: 10,
      },
    },
    yAxis: [
      {
        type: 'value',
        name: 'ms',
        // ⚠️ 最小值**恒为 0** —— 底部必须是 0ms, 否则视觉上会暗示
        //   "延迟从来没低于 20ms"。之前硬编码 min: 20 是错的。
        min: 0,
        // 顶格按可见数据的峰值动态取整(见 latencyAxis.ts)
        max: axisMax,
        // ⚠️ 刻度间隔**必须显式钉死** ——
        //   ECharts 默认按 nice((max-min)/splitNumber) 现算间隔,
        //   而 max 在动画途中是连续变化的小数 ⇒ 间隔会一路跳
        //   (实测 10→50 的过渡里跳了 6 次: 2→3→5→10→20→30→50),
        //   刻度整排重排 —— 看着像闪烁, 不是平滑拉伸。
        //   钉死间隔后网格线原地不动, 只有顶边在移动。
        interval: effectiveInterval,
        nameTextStyle: {
          color: '#64748b',
        },
        splitLine: {
          lineStyle: {
            color: '#1e293b',
          },
        },
        axisLabel: {
          color: '#64748b',
          // 过渡途中的值已取整, 这里再兜一层, 保证标签是整数
          formatter: (value: number) => String(Math.round(value)),
        },
        // 轴范围变化时平滑过渡(ECharts 侧再加一道, 与 rAF 缓动叠加)
        animation: true,
        animationDuration: 300,
        animationEasing: 'cubicOut',
      },
      {
        type: 'value',
        name: '%',
        min: 0,
        max: 5,
        splitLine: {
          show: false,
        },
        axisLabel: {
          color: '#ef4444',
        },
      },
    ],
    series: [
      {
        name: t('dashboard:chart.latency_series'),
        type: 'line',
        smooth: true,
        symbol: 'none',
        // ⚠️ **必须显式关掉** —— 断流处是 null, 连起来就等于
        //    "假装没有中断, 直接从断流前连到断流后"。
        //    关掉之后折线在 null 处物理断开, 留白即"无数据"。
        connectNulls: false,
        data: chartData.latency,
        lineStyle: {
          color: '#4ade80',
          width: 2.5,
        },
        // 断流底纹 —— 灰色半透明带 + "无数据"标注。
        //
        // 为什么光靠"折线断开"不够: 断开只说明"这里没有线",
        // 但用户分不清是"没数据"还是"图表坏了"。灰带把这段区间
        // **显式圈出来**, 语义就确定了。
        //
        // 配置本身在 `dataGaps.gapMarkArea` —— 吞吐图用的是同一份,
        // 免得两个图的灰带颜色/最小宽度各自漂移。
        markArea: gapMarkArea(chartData.gaps, t('dashboard:chart.no_data_short')),
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              {
                offset: 0,
                color: 'rgba(74,222,128,.25)',
              },
              {
                offset: 1,
                color: 'rgba(74,222,128,0)',
              },
            ],
          },
        },
      },
      {
        name: t('dashboard:chart.loss_series'),
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbol: 'none',
        // 同上: 断流处必须断开, 否则会画出一条"跨断流区"的假丢包曲线
        connectNulls: false,
        data: chartData.loss,
        lineStyle: {
          color: '#ef4444',
          width: 1.5,
          type: 'dashed',
        },
      },
      {
        name: t('dashboard:chart.handoff_series'),
        type: 'scatter',
        data: chartData.satellites,
        // ⚠️ 图层显隐有两道闸:
        //   ① Local(网关)模式 —— 本地链路不经卫星, 标切换点是语义错误
        //   ② 用户点掉图例 —— 需求是"星星瞬间消失"
        // 数据也已在上面的 effect 里清空(见 `showHandoffSeries` 判据),
        // 这里再关掉图层本身 —— 双保险, 避免 setOption 判定 series 列表
        // 变化时闪回。
        show: showHandoffSeries,
        symbolSize: 11,
        itemStyle: {
          color: '#f59e0b',
          borderColor: '#fff',
          borderWidth: 1,
          shadowBlur: 8,
          shadowColor: '#f59e0b',
        },
      },
    ],
  };

  /**
   * 最后一个**有值**的点。
   *
   * 不能用 `series[series.length - 1]` —— 断流时末尾全是 null,
   * 那样底部会显示 "NaN ms"。这里回退到最近一次真实采集,
   * 它可能就是几十分钟前的值 —— 所以陈旧提示必须和它一起出现
   * (见 Dashboard 顶部的"数据陈旧"横幅)。
   */
  const lastIdx = lastNonNullIndex(chartData.latency);
  const lastLossIdx = lastNonNullIndex(chartData.loss);
  const lastLatency = lastIdx >= 0 ? chartData.latency[lastIdx] : null;
  const lastLoss = lastLossIdx >= 0 ? chartData.loss[lastLossIdx] : null;
  const hasAnySample = lastLatency !== null || lastLoss !== null;

  /** 末尾空档一直延伸到窗口右边界 ⇒ 采集仍在中断中 */
  const trailingGap =
    chartData.time.length > 0 &&
    chartData.gaps.some((run) => run.to === chartData.time.length - 1);

  /** 最后一条数据的时刻标签 —— 断流时用来说明"这些数字是什么时候的" */
  const lastSampleLabel = chartData.time[lastIdx >= 0 ? lastIdx : lastLossIdx] ?? '—';

  // 整窗一个样本都没有 ⇒ 不画空图。整屏灰带会让人以为渲染坏了,
  // 明确写"暂无数据"更诚实。
  if (isLoading || !hasAnySample) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center text-muted-foreground"
      >
        {isLoading ? t('common:loading') : t('dashboard:chart.no_data')}
      </div>
    );
  }

  return (
    <div>
      {/* 模式切换按钮 */}
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-accent-green" />
          {t('dashboard:chart.latency_title')}
        </h3>
        <div className="flex items-center gap-1 bg-muted/40 border border-border rounded-md p-1">
          {LATENCY_DIMENSIONS.map((dim) => (
            <button
              key={dim.id}
              onClick={() => dim.available && setMode(dim.id)}
              disabled={!dim.available}
              title={dim.available ? undefined : t('dashboard:chart.mode_unavailable')}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                mode === dim.id
                  ? 'bg-accent-green/20 text-accent-green'
                  : dim.available
                    ? 'text-muted-foreground hover:text-foreground'
                    : 'text-muted-foreground/40 cursor-not-allowed'
              }`}
            >
              {t(`dashboard:${dim.labelKey}`)}
            </button>
          ))}
        </div>
      </div>

      {/* 图例标签 */}
      <div className="flex gap-1 mb-1 text-[11px]">
        <span className="px-2 py-0.5 rounded bg-accent-green/15 text-accent-green">
          {t('dashboard:chart.latency_ms')}
        </span>
        <span className="px-2 py-0.5 rounded bg-danger-red/15 text-danger-red">
          {t('dashboard:chart.loss_pct')}
        </span>
        {/*
          卫星切换图例 —— **可点击**切换显隐。

          Local(网关)模式不显示该图例 —— 与图上的 series 保持一致
          (本地链路不经卫星, 标切换点是语义错误)。

          点击行为:
            开着 → 星星瞬间消失, 文字置灰 + 删除线
            关着 → 星星重新浮现, 文字恢复高亮
        */}
        {showsSatelliteHandoffs(mode) && (
          <button
            type="button"
            onClick={() =>
              setHandoffOverrides(
                withToggledOverride(handoffOverrides, timeRange, handoffsVisible),
              )
            }
            aria-pressed={handoffsVisible}
            title={
              handoffsVisible
                ? t('dashboard:chart.handoff_hide')
                : t('dashboard:chart.handoff_show')
            }
            /*
             * 关闭态的视觉：**整体降级**, 不加删除线。
             *
             * 为什么不用删除线: 删除线让文字"碎掉", 读起来像
             * 「这个功能被废弃了」, 而不是「我暂时把它藏起来了」。
             * 用户随时能点回来, 文字要保持干净完整。
             *
             * 为什么用 opacity 而不是固定暗灰色:
             *   - 关闭态要「与背景融为一体」⇒ 半透明正好,
             *     固定色还得挑一个跟卡片背景匹配的颜色, 换主题就失配
             *   - hover 提亮到 70% 时, 用 opacity 才能**连续过渡**
             *     (固定色 → 固定色没有中间态)
             *
             * hover 一定要留:
             *   全暗的按钮看着像 disabled(不可点), 用户不敢点。
             *   提亮 + cursor-pointer 明确表达「我只是隐藏了, 随时能点亮」。
             *
             * ⚠️ 颜色用 `accent-yellow`(#f59e0b) 而不是 `warning-orange` ——
             *   `accent-yellow` 与图上星标的 itemStyle 色**完全一致**,
             *   图例和星星是同一个色, 视觉上才对应。
             *   而 `warning-orange` 在本项目里曾因 Tailwind v4 不加载
             *   tailwind.config.js 而**整个失效**(见 index.css 的 @theme 注释)。
             */
            className={`px-2 py-0.5 rounded cursor-pointer select-none
              transition-opacity duration-150
              focus:outline-none focus-visible:ring-2 focus-visible:ring-ring
              ${
                handoffsVisible
                  ? 'bg-accent-yellow/15 text-accent-yellow opacity-100'
                  : // 关闭态: 30% 基础透明度, hover 提到 70%
                    'bg-muted/40 text-accent-yellow opacity-30 hover:opacity-70'
              }`}
          >
            {t('dashboard:chart.handoff_legend')}
          </button>
        )}
      </div>

      {/* ECharts图表 */}
      <ReactECharts option={option} style={{ height }} />

      {/* 底部状态信息 */}
      <div className="mt-2 flex items-center gap-2 text-xs text-slate-400 border-t border-slate-700/40 pt-2">
        {/* 圆点跟随"最新数据是否还在更新" —— 绿=正在采集, 灰=已断流 */}
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            trailingGap ? 'bg-slate-500' : 'bg-accent-green'
          }`}
        />
        <span>
          {trailingGap
            ? t('dashboard:chart.trailing_gap', {
                time: lastSampleLabel,
                latency: formatMs(lastLatency),
                loss: formatPct(lastLoss),
              })
            : t(`dashboard:chart.current_${mode}`, {
                latency: formatMs(lastLatency),
                loss: formatPct(lastLoss),
              })}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 纯函数
 * ------------------------------------------------------------------ */

/**
 * 按当前维度取延迟值。
 *
 * ⚠️ **缺失必须返回 null, 绝不能兜成 0** ——
 *   0ms 的语义是"极速", 把"这个维度没采到"画成"好得离谱",
 *   而且会把 Y 轴峰值和整条折线一起污染。
 */
function pickLatency(sample: HistorySample, mode: LatencyMode): number | null {
  const raw =
    mode === 'gateway'
      ? sample.localGatewayLatencyMs
      : mode === 'public'
        ? sample.publicPingLatencyMs
        : sample.popPingLatencyMs;

  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** 丢包率 0..1 → 百分比。缺失同样返回 null, 理由同上 */
function toLossPercent(rate: number | undefined): number | null {
  return typeof rate === 'number' && Number.isFinite(rate) ? rate * 100 : null;
}

/** 最后一个非 null 值的下标; 全空返回 -1 */
function lastNonNullIndex(values: Array<number | null>): number {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== null) return i;
  }
  return -1;
}

/** 底栏展示用 —— null 显示为破折号, 而不是 NaN */
function formatMs(value: number | null): string {
  return value === null ? '—' : value.toFixed(1);
}

function formatPct(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}