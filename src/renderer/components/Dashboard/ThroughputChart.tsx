/**
 * 吞吐量图表组件
 */

import ReactECharts from 'echarts-for-react';
import type { HistorySample } from '../../../storage/types';
import { useEffect, useState } from 'react';
import { formatTimeLabel } from '../../../core/telemetry';

interface ThroughputChartProps {
  height?: number;
  /** 由上层统一获取, 组件只负责渲染 */
  history: HistorySample[];
  isLoading?: boolean;
}

export function ThroughputChart({ height = 300, history, isLoading = false }: ThroughputChartProps) {
  const [chartData, setChartData] = useState<{
    time: string[];
    download: number[];
    upload: number[];
  }>({
    time: [],
    download: [],
    upload: [],
  });

  useEffect(() => {
    if (history.length === 0) return;

    const time: string[] = [];
    const download: number[] = [];
    const upload: number[] = [];

    history.forEach((data) => {
      const label = formatTimeLabel(data.timestamp);
      if (label) {
        time.push(label);
        download.push(data.downlinkThroughputBps / 1e6); // 转换为 Mbps
        upload.push(data.uplinkThroughputBps / 1e6);
      }
    });

    setChartData({ time, download, upload });
  }, [history]);

  const option = {
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
        const download = params[0];
        const upload = params[1];
        return `${time}<br/>${download.marker}下载: ${download.value.toFixed(1)} Mbps<br/>${upload.marker}上传: ${upload.value.toFixed(1)} Mbps`;
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
        sampling: 'lttb',
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
        sampling: 'lttb',
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
  };

  if (isLoading || chartData.time.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center text-muted-foreground"
      >
        {isLoading ? '加载中...' : '暂无数据'}
      </div>
    );
  }

  return <ReactECharts option={option} style={{ height }} />;
}