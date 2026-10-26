/**
 * 延迟与丢包走势图表组件
 * 支持Public/PoP/Gateway三种模式切换，显示延迟、丢包率和卫星切换事件
 */

import ReactECharts from 'echarts-for-react';
import { formatTimeLabel } from '../../../core/telemetry';
import type { HistorySample } from '../../../storage/types';
import { useEffect, useState } from 'react';

interface LatencyChartProps {
  height?: number;
  /** 由上层统一获取, 组件只负责渲染, 不再自己发起查询 */
  history: HistorySample[];
  isLoading?: boolean;
}

type LatencyMode = 'public' | 'pop' | 'gateway';

/**
 * 延迟维度可选项。
 *
 * dish history 只提供 PoP 延迟这一路数据, 公网/网关维度目前没有采集源。
 * 这里显式标成 available:false, 而不是叠一个随机数去画一条看着像真的假曲线。
 * 将来接入 ICMP / traceroute 采集后, 把对应项改成 true 就能启用。
 */
const LATENCY_DIMENSIONS: Array<{ id: LatencyMode; label: string; available: boolean }> = [
  { id: 'public', label: 'Public', available: false },
  { id: 'pop', label: 'PoP', available: true },
  { id: 'gateway', label: 'Gateway', available: false },
];

const DEFAULT_MODE: LatencyMode = LATENCY_DIMENSIONS.find((d) => d.available)?.id ?? 'pop';

export function LatencyChart({ height = 260, history, isLoading = false }: LatencyChartProps) {
  const [mode, setMode] = useState<LatencyMode>(DEFAULT_MODE);
  const [chartData, setChartData] = useState<{ 
    time: string[]; 
    latency: number[];
    loss: number[];
    satellites: Array<[number, number]>;
  }>({
    time: [],
    latency: [],
    loss: [],
    satellites: [],
  });

  useEffect(() => {
    if (history.length === 0) return;

    const time: string[] = [];
    const latency: number[] = [];
    const loss: number[] = [];
    const satellites: Array<[number, number]> = [];

    // 卫星切换点 = satelliteId 发生变化的采样。
    // 分桶/小时聚合结果不带 satelliteId, 这些范围下就不标切换点(不猜)。
    let prevSatelliteId: number | undefined;

    history.forEach((data) => {
      const label = formatTimeLabel(data.timestamp);
      if (!label) return;

      const latencyValue = data.popPingLatencyMs;
      const index = time.length;

      time.push(label);
      latency.push(latencyValue);
      // 丢包率（0..1 → 百分比），缺失样本按 0 处理
      loss.push((data.popPingDropRate ?? 0) * 100);

      if (prevSatelliteId !== undefined && data.satelliteId !== undefined && data.satelliteId !== prevSatelliteId) {
        satellites.push([index, latencyValue]);
      }
      if (data.satelliteId !== undefined) prevSatelliteId = data.satelliteId;
    });

    setChartData({ time, latency, loss, satellites });
  }, [history]);

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
        let result = `${params[0].axisValue}<br/>`;
        params.forEach((item: any) => {
          if (item.seriesName === '延迟') {
            result += `${item.marker}延迟: ${item.value.toFixed(1)} ms<br/>`;
          } else if (item.seriesName === '丢包率') {
            result += `${item.marker}丢包率: ${item.value.toFixed(2)}%<br/>`;
          } else if (item.seriesName === '卫星切换') {
            result += `★ 卫星切换<br/>`;
          }
        });
        return result;
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
        min: 20,
        max: 100,
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
        },
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
        name: '延迟',
        type: 'line',
        smooth: true,
        symbol: 'none',
        data: chartData.latency,
        lineStyle: {
          color: '#4ade80',
          width: 2.5,
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
        name: '丢包率',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbol: 'none',
        data: chartData.loss,
        lineStyle: {
          color: '#ef4444',
          width: 1.5,
          type: 'dashed',
        },
      },
      {
        name: '卫星切换',
        type: 'scatter',
        data: chartData.satellites,
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

  return (
    <div>
      {/* 模式切换按钮 */}
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-accent-green" />
          延迟与丢包走势
        </h3>
        <div className="flex items-center gap-1 bg-muted/40 border border-border rounded-md p-1">
          {LATENCY_DIMENSIONS.map((dim) => (
            <button
              key={dim.id}
              onClick={() => dim.available && setMode(dim.id)}
              disabled={!dim.available}
              title={dim.available ? undefined : '该维度暂未接入采集源'}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                mode === dim.id
                  ? 'bg-accent-green/20 text-accent-green'
                  : dim.available
                    ? 'text-muted-foreground hover:text-foreground'
                    : 'text-muted-foreground/40 cursor-not-allowed'
              }`}
            >
              {dim.label}
            </button>
          ))}
        </div>
      </div>

      {/* 图例标签 */}
      <div className="flex gap-1 mb-1 text-[11px]">
        <span className="px-2 py-0.5 rounded bg-accent-green/15 text-accent-green">
          延迟 (ms)
        </span>
        <span className="px-2 py-0.5 rounded bg-danger-red/15 text-danger-red">
          丢包率 (%)
        </span>
        <span className="px-2 py-0.5 rounded bg-warning-orange/15 text-warning-orange">
          ★ 卫星切换
        </span>
      </div>

      {/* ECharts图表 */}
      <ReactECharts option={option} style={{ height }} />

      {/* 底部状态信息 */}
      <div className="mt-2 flex items-center gap-2 text-xs text-slate-400 border-t border-slate-700/40 pt-2">
        <span className="w-2 h-2 rounded-full bg-accent-green shrink-0" />
        <span>
          当前 {mode === 'public' ? '公网' : mode === 'pop' ? 'PoP' : '网关'}延迟: {' '}
          {chartData.latency.length > 0 ? chartData.latency[chartData.latency.length - 1].toFixed(1) : '—'} ms，
          丢包率: {chartData.loss.length > 0 ? chartData.loss[chartData.loss.length - 1].toFixed(2) : '—'}%
        </span>
      </div>
    </div>
  );
}