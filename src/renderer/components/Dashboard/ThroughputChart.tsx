/**
 * 吞吐量图表组件
 *
 * ⚠️ 断流处理与折线图(LatencyChart)**共用同一套判据**(`dataGaps`):
 *    数据按等时间栅格铺开, 断流格子为 null ⇒ 折线物理断开 + 灰色"无数据"带。
 *    早期这里是 `history.forEach` 逐样本 push —— 样本数组里没有断流期间的
 *    任何条目, 于是断流前后两个点被直接连成一条直线, 31 分钟的采集中断
 *    在图上表现为"速度平滑下降又回升", 完全是假的。
 */

import ReactECharts from 'echarts-for-react';
import type { HistorySample } from '../../../storage/types';
import { useEffect, useMemo, useState } from 'react';
import { formatTimeLabel } from '../../../core/telemetry';
import { buildTimeGrid, findNullRuns, gapMarkArea } from './dataGaps';

interface ThroughputChartProps {
  height?: number;
  /** 由上层统一获取, 组件只负责渲染 */
  history: HistorySample[];
  /** 时间窗起止 (epoch ms) —— 栅格铺开的依据, 必填才能表达断流宽度 */
  fromMs: number;
  toMs: number;
  isLoading?: boolean;
}

export function ThroughputChart({
  height = 300,
  history,
  fromMs,
  toMs,
  isLoading = false,
}: ThroughputChartProps) {
  const [chartData, setChartData] = useState<{
    time: string[];
    download: Array<number | null>;
    upload: Array<number | null>;
    gaps: ReturnType<typeof findNullRuns>;
  }>({
    time: [],
    download: [],
    upload: [],
    gaps: [],
  });

  useEffect(() => {
    if (!(toMs > fromMs)) return;

    const grid = buildTimeGrid(history, fromMs, toMs);

    const time: string[] = [];
    const download: Array<number | null> = [];
    const upload: Array<number | null> = [];

    for (const cell of grid) {
      time.push(formatTimeLabel(cell.ts) ?? '');
      if (!cell.sample) {
        // 断流: 留 null, 折线在此断开(而不是 `?? 0` 画成"速度归零")
        download.push(null);
        upload.push(null);
        continue;
      }
      download.push(cell.sample.downlinkThroughputBps / 1e6); // 转换为 Mbps
      upload.push(cell.sample.uplinkThroughputBps / 1e6);
    }

    setChartData({ time, download, upload, gaps: findNullRuns(download) });
  }, [history, fromMs, toMs]);

  const option = useMemo(
    () => ({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(10, 10, 10, 0.95)',
      borderColor: '#333',
      textStyle: {
        color: '#fff',
      },
      formatter: (params: any) => {
        const time = params[0].axisValue;
        // 断流处 value 为 null —— 必须显式说"无数据",
        // 否则 toFixed 直接抛异常(整个图表白屏)
        const fmt = (p: any) =>
          p.value === null || p.value === undefined || Number.isNaN(p.value)
            ? '无数据'
            : `${p.value.toFixed(1)} Mbps`;
        return `${time}<br/>${params[0].marker}下载: ${fmt(params[0])}<br/>${params[1].marker}上传: ${fmt(params[1])}`;
      },
    },
    legend: {
      data: ['下载', '上传'],
      textStyle: {
        color: '#888',
      },
      top: 0,
    },
    grid: {
      left: '3%',
      right: '4%',
      bottom: '10%',
      top: '15%',
      containLabel: true,
    },
    xAxis: {
      type: 'category',
      data: chartData.time,
      boundaryGap: false,
      axisLine: {
        lineStyle: {
          color: '#444',
        },
      },
      axisLabel: {
        color: '#888',
        fontSize: 11,
        interval: Math.floor(chartData.time.length / 6),
      },
      splitLine: {
        show: false,
      },
    },
    yAxis: {
      type: 'value',
      name: '速度 (Mbps)',
      nameTextStyle: {
        color: '#888',
        fontSize: 12,
      },
      axisLine: {
        show: false,
      },
      axisLabel: {
        color: '#888',
        fontSize: 11,
      },
      splitLine: {
        lineStyle: {
          color: '#2a2a2a',
          type: 'dashed',
        },
      },
    },
    series: [
      {
        name: '下载',
        type: 'line',
        smooth: true,
        symbol: 'none',
        // lttb 抽稀会把断口的 null 当数值参与抽稀, 有机会把断口抹平;
        // 栅格上限 720 格本来也不需要抽稀
        connectNulls: false,
        // 灰带只挂在一条 series 上 —— 两条都挂会叠成两倍浓度
        markArea: gapMarkArea(chartData.gaps),
        itemStyle: {
          color: '#3b82f6',
        },
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
                color: 'rgba(59, 130, 246, 0.3)',
              },
              {
                offset: 1,
                color: 'rgba(59, 130, 246, 0.05)',
              },
            ],
          },
        },
        data: chartData.download,
      },
      {
        name: '上传',
        type: 'line',
        smooth: true,
        symbol: 'none',
        connectNulls: false,
        itemStyle: {
          color: '#f59e0b',
        },
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
                color: 'rgba(245, 158, 11, 0.3)',
              },
              {
                offset: 1,
                color: 'rgba(245, 158, 11, 0.05)',
              },
            ],
          },
        },
        data: chartData.upload,
      },
    ],
    }),
    [chartData],
  );

  if (isLoading) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center text-muted-foreground"
      >
        加载中...
      </div>
    );
  }

  // 整窗无数据也照常渲染 —— 满屏灰色「无数据」带比一句"暂无数据"
  // 更能说明"这段时间采集器没工作"
  return <ReactECharts option={option} style={{ height }} />;
}