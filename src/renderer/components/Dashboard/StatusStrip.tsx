/**
 * 连接状态色块条(竖条)
 *
 * 把「连接状态」卡的迷你折线换成一条**状态竖条**: 每个时间片一根独立的
 * 竖条, 按该时间片的聚合状态着色, 横向铺满整个卡片宽度。
 *
 * ## 为什么不是折线
 *
 * 折线表达的是「数值连续变化」, 但连接状态是**离散状态**。
 * 一直在线时折线就是一条贴顶的直线(全 y=0), 看着像坏了;
 * 断网 30 秒在 6h 尺度上只是一个小抖动, 肉眼根本找不到 ——
 * 而"十几分钟前断过一次网"恰恰是用户最需要一眼看到的事。
 * 竖条把时间和状态一一对应, 断网的那几根直接变成红色。
 *
 * ## 聚合规则(最差状态优先)
 *
 * 一个色块覆盖一段时间片, 其颜色由**该片内出现过的最差状态**决定:
 *
 * | 条件 | 颜色 | 含义 |
 * |---|---|---|
 * | 出现过 **1 次** OFFLINE | 🔴 红 | Critical —— 只要断过就是断过 |
 * | 没断过, 但有 SEARCHING/BOOTING/高延迟 | 🟡 黄 | Warning —— 服务降级 |
 * | 100% 完美无异常 | 🟢 绿 | Online |
 * | **该时段完全没有采样** | ⬜ 灰 | Unknown —— 采集中断, 状态未知 |
 *
 * 关键点: **"1 秒钟断网"也算断网**。所以不能用"占比过半"来判断,
 * 必须"出现过即命中"。这是"最差状态优先"而不是"多数表决"。
 *
 * ## 灰色(Unknown)与 carry-forward 的分工
 *
 * 早先的实现里, 空 slot 一律沿用前一片状态 —— 理由是"连接状态是持续量,
 * 没采到新数据不等于状态变了"。这个假设**只在空隙很短时成立**:
 *
 * | 空隙长度 | 含义 | 处理 |
 * |---|---|---|
 * | < 3 个采集周期(90s) | 定时器抖动 / 偶发丢点 | carry-forward, 沿用前一片 |
 * | ≥ 90s | 采集器没在工作 ⇒ **状态不可知** | 灰色 Unknown |
 *
 * 90s 这个阈值与折线图共用同一份判据(`dataGaps.gapToleranceMs`),
 * 所以"折线断开的地方"和"色块变灰的地方"必然是同几段时间。
 * 否则会出现"折线断了但色块一片绿" —— 同一张仪表盘自相矛盾。
 *
 * ## 视觉规则
 *
 * - 每根竖条之间留 2px 缝隙: 既能看出时间分片, 又保证整体是一个
 *   连续的「条带」, 而不是散乱的方块。相邻同色**不合并** —— 每根独立,
 *   这样时间分辨率在视觉上是均匀的(条码状), 断网的连续几根自然连成一片红。
 * - 屏幕变窄时**减少块数**(粒度变粗), 绝不压缩 Gap ——
 *   Gap 一旦被压到 0, 分片感就没了, 那就退化成了纯色条, 失去意义。
 * - 两端只有极弱的灰色文本标注, 没有 X/Y 轴 —— 视觉焦点全在色块上。
 *
 * ## 时间对齐
 *
 * 竖条的时间范围与「延迟」卡的折线**共用同一份 history**, 所以 X 轴
 * 天然对齐: 看到红条, 往右看一眼延迟折线就有对应尖刺。
 */

import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { HistorySample } from '../../../storage/types';
import { findGaps, isInGap } from './dataGaps';
import { StatusTooltip, useStatusTooltip } from './StatusTooltip';

/** 状态语义色 —— 与仪表盘其它卡片的用色保持一致 */
export const STATUS_COLORS = {
  online: '#4ade80',    // 绿
  degraded: '#fbbf24',  // 黄(降级: 搜星中/启动中/高延迟)
  offline: '#ef4444',   // 红(断网)
  unknown: '#64748b',   // 中灰(采集中断 ⇒ 状态不可知)
  empty: '#334155',     // 暗灰(既无数据也无前情: 窗口开头就没有任何采样)
} as const;

/** 一个时间片的状态分类 */
export type StatusClass = 'online' | 'degraded' | 'offline' | 'unknown' | 'empty';

/**
 * 降级判定阈值 —— 与告警引擎(`src/alerting/manager.ts`)保持一致。
 *
 * - 延迟 > 100ms  ⇒ high_latency 规则命中
 * - SNR < 5 dB     ⇒ low_snr 规则命中
 * - 丢包率 > 10%  ⇒ high_packet_loss 规则命中
 */
export const DEGRADE_THRESHOLDS = {
  highLatencyMs: 100,
  lowSnr: 5,
  highPacketLoss: 0.1,
} as const;

/**
 * 把一个采样点归类。
 *
 * 优先用明细的 state(最准确); 没有 state 时用桶内各状态占比 ——
 * 占比给出的是"这个时间片里大部分时间是什么状态"。
 */
export function classifySample(sample: HistorySample): StatusClass {
  if (sample.state) {
    switch (sample.state) {
      case 'ONLINE':
        // 在线但**服务降级**(高延迟/信号弱/丢包)⇒ 黄, 不是绿。
        // 与告警引擎的 high_latency / low_snr / high_packet_loss 同口径。
        if (isDegraded(sample)) return 'degraded';
        return 'online';
      case 'SEARCHING':
      case 'BOOTING':
        return 'degraded';
      case 'OFFLINE':
        return 'offline';
      default:
        return 'degraded';
    }
  }

  // 分桶/聚合粒度: 用占比判断。任一"坏"状态占多数就不是 online。
  const off = sample.offlineRatio ?? 0;
  const deg = (sample.searchingRatio ?? 0) + (sample.bootingRatio ?? 0);
  const on = sample.onlineRatio ?? 0;

  if (off > 0) return 'offline';
  if (deg > 0) return 'degraded';
  if (on > 0) return 'online';
  return 'empty';
}

/** 在线但服务质量下降 */
function isDegraded(sample: HistorySample): boolean {
  const latency = sample.popPingLatencyMs;
  const snr = sample.snr;
  const drop = sample.popPingDropRate;

  if (Number.isFinite(latency) && latency > DEGRADE_THRESHOLDS.highLatencyMs) return true;
  if (Number.isFinite(snr) && snr < DEGRADE_THRESHOLDS.lowSnr) return true;
  if (Number.isFinite(drop) && drop > DEGRADE_THRESHOLDS.highPacketLoss) return true;

  return false;
}

/** 一根竖条 */
export interface StatusSegment {
  /** 归类 */
  klass: StatusClass;
  /** 该片占整条的比例 0..1 */
  width: number;
  /** 该片的起始时间 epoch ms */
  from: number;
  /** 该片的结束时间 epoch ms */
  to: number;
  /**
   * 该片内的断线**次数**(连续断网算一次)。
   * 用于悬浮提示 —— "包含 2 次断线"。
   */
  outageCount: number;
  /** 该片内的采样总数 */
  sampleCount: number;
  /** 该片内处于 online 的采样数 */
  onlineCount: number;
  /** 该片内处于降级(SEARCHING/BOOTING)的采样数 */
  degradedCount: number;
}

/**
 * 生成竖条分段。
 *
 * **每个 slot 一根, 相邻同类不合并** —— 合并会让时间分辨率在视觉上变得
 * 不均匀(一整段绿变成一根宽条, 断网的两根变成一根), 而用户要的是
 * "条码"式的均匀分格。
 *
 * @param history 历史采样(已按时间升序)
 * @param fromMs  条带起始时间
 * @param toMs    条带结束时间
 * @param slots   竖条数量(越多时间分辨率越高)
 */
export function buildStatusSegments(
  history: HistorySample[],
  fromMs: number,
  toMs: number,
  slots: number
): StatusSegment[] {
  if (slots <= 0 || toMs <= fromMs) return [];

  const span = toMs - fromMs;
  const slotMs = span / slots;

  // 每个 slot 收集落在它区间内的所有采样 —— 聚合需要全部, 不能只取最后一个
  const buckets: HistorySample[][] = Array.from({ length: slots }, () => []);

  for (const sample of history) {
    const ts = sample.timestamp;
    if (!Number.isFinite(ts) || ts < fromMs || ts > toMs) continue;
    // 用区间判断而不是除法 —— 除法在边界上会因浮点误差把采样甩到
    // 相邻 slot, 造成"明明连续在线却冒出灰条"。
    const idx = Math.min(slots - 1, Math.max(0, Math.floor((ts - fromMs) / slotMs)));
    buckets[idx].push(sample);
  }

  // ⚠️ **必须覆盖完整时间轴** —— 没有采样的 slot 也要占位。
  //    早期版本把空 slot 直接丢掉, 结果:
  //    1. 竖条宽度加起来 < 100%, 条带不满宽, 右侧留一段空白
  //    2. 有数据的部分被压缩到左边 ⇒ 与右侧折线的 X 轴**对不齐**
  //      (折线按"第几个点"定位, 竖条按"绝对时间"定位, 压缩后就错位)
  //
  // 空 slot 分两种情况,**绝不能用同一种颜色糊过去**:
  //
  //   ① 空隙 < 3 个采集周期 ⇒ 定时器抖动, 状态没变 ⇒ carry-forward
  //      (每次都画灰的话, 连续在线也会被切成一堆灰绿灰绿的碎条)
  //   ② 空隙 ≥ 3 个采集周期 ⇒ 采集器没在工作, **状态根本不可知** ⇒ 灰色
  //      (原来是 carry-forward, 于是采集器挂掉 31 分钟画成一片健康的绿)
  //
  // 判据来自 `dataGaps.findGaps`, 与折线断开的判据是**同一份** ——
  // 折线断开的地方, 这里必然变灰。
  const gaps = findGaps(history, fromMs, toMs);

  const segments: StatusSegment[] = [];
  let carryKlass: StatusClass | null = null;
  let carryStats = { outageCount: 0, sampleCount: 0, onlineCount: 0, degradedCount: 0 };

  for (let i = 0; i < slots; i++) {
    const list = buckets[i];
    const from = fromMs + i * slotMs;
    const to = fromMs + (i + 1) * slotMs;

    if (!list.length) {
      // 用 slot **中心点**判归属 —— 用边界判会在两段 gap 的接壤处
      // 因半开半闭的约定反复横跳。
      if (isInGap(gaps, (from + to) / 2)) {
        segments.push({
          klass: 'unknown',
          from, to,
          width: slotMs / span,
          // 断流期间没有任何采样, 统计全部归零 —— 别把上一片的
          // "2 次断线"带进来, 那是另一段时间的事。
          outageCount: 0,
          sampleCount: 0,
          onlineCount: 0,
          degradedCount: 0,
        });
        // ⚠️ 不更新 carryKlass: 断流之后如果又出现一个短空 slot,
        //    它应该延续**断流之前**的真实状态, 而不是延续"未知"。
        continue;
      }

      // 短抖动 ⇒ 延续上一片的状态与统计(状态不变 ⇒ 断线次数也不变)
      segments.push({
        klass: carryKlass ?? 'empty',
        from, to,
        width: slotMs / span,
        ...carryStats,
      });
      continue;
    }

    // ---- 聚合: 最差状态优先 ----
    const classes = list.map(classifySample);
    const offlineCount = classes.filter((c) => c === 'offline').length;
    const degradedCount = classes.filter((c) => c === 'degraded').length;
    const onlineCount = classes.filter((c) => c === 'online').length;

    // 断线"次数": 连续的 OFFLINE 算一次, 中间被别的状态打断才算新的
    let outageCount = 0;
    let prevOffline = false;
    for (const c of classes) {
      const isOffline = c === 'offline';
      if (isOffline && !prevOffline) outageCount++;
      prevOffline = isOffline;
    }

    // 只要出现过 1 次 OFFLINE ⇒ 红; 否则有降级 ⇒ 黄; 否则绿
    const klass: StatusClass =
      offlineCount > 0 ? 'offline'
      : degradedCount > 0 ? 'degraded'
      : onlineCount > 0 ? 'online'
      : 'empty';

    carryKlass = klass;
    carryStats = { outageCount, sampleCount: list.length, onlineCount, degradedCount };

    segments.push({
      klass,
      from, to,
      width: slotMs / span,
      outageCount,
      sampleCount: list.length,
      onlineCount,
      degradedCount,
    });
  }

  return segments;
}

export interface StatusStripProps {
  /** 历史采样 */
  history: HistorySample[];
  /** 时间范围起止 (epoch ms) */
  fromMs: number;
  toMs: number;
  /** 竖条数量 —— 决定时间分辨率 */
  slots?: number;
  /**
   * 竖条高度(px) —— 必须与右侧图表的绘图区高度一致,
   * 否则底部基线不对齐, 视线横扫时就会错位。
   */
  height?: number;
}

/**
 * 时间范围 → 切片方案。
 *
 * 块数**固定**(不随卡片宽度变), 因为块数表达的是"时间分辨率":
 * 24h→48块(每块30分钟) / 6h→36块(10分钟) / 1h→30块(2分钟) / 15m→30块(30秒)
 *
 * 屏幕变窄时**减少块数**(粒度变粗), 而不是压缩 Gap ——
 * Gap 一旦被压到 0, 分片感就没了, 那就退化成了纯色条, 失去意义。
 * 这个取舍在 Dashboard 里用 `fitStatusSlots()` 实现。
 */
export const SLICE_PLANS: Record<string, { slots: number; slotMs: number }> = {
  '24h': { slots: 48, slotMs: 30 * 60 * 1000 },
  '6h': { slots: 36, slotMs: 10 * 60 * 1000 },
  '1h': { slots: 30, slotMs: 2 * 60 * 1000 },
  '15m': { slots: 30, slotMs: 30 * 1000 },
};

/**
 * 在给定可用宽度下, 能放多少块而不压缩 Gap。
 *
 * @param availableWidth 条带可用宽度 px
 * @param gap            块之间的缝隙 px(固定, 不压缩)
 * @param maxSlots       该时间范围推荐的块数
 * @param stepDown       每次减少的块数(方案里 48→36→30 的步长)
 */
export function fitStatusSlots(
  availableWidth: number,
  gap: number,
  maxSlots: number,
  stepDown: number
): number {
  // 每块至少要能看出是一条独立的竖条 —— 宽 3px 是下限
  const MIN_BAR_WIDTH = 3;
  let slots = maxSlots;
  while (slots > 1) {
    const needed = slots * MIN_BAR_WIDTH + (slots - 1) * gap;
    if (needed <= availableWidth) break;
    slots = Math.max(1, slots - stepDown);
  }
  return slots;
}

/** 块之间的缝隙(px) —— 固定值, 绝不压缩 */
export const STATUS_GAP = 2;

export function StatusStrip({
  history,
  fromMs,
  toMs,
  slots = 36,
  height = 32,
}: StatusStripProps) {
  const { t, i18n } = useTranslation();
  const segments = buildStatusSegments(history, fromMs, toMs, slots);
  const { content, handlers, close } = useStatusTooltip();

  if (!segments.length) {
    return (
      // 高度与右侧 SVG 图表区一致(CHART_HEIGHT=32), 底部落在同一基线上。
      <div
        className="mt-3 w-full rounded-sm bg-slate-800/60"
        style={{ height }}
      />
    );
  }

  return (
    <>
      {/* 高度与右侧 SVG 图表区一致(CHART_HEIGHT=32), 底部落在同一基线上。
          图例文字由 MetricCard 统一渲染 —— 六张卡共用一行, 保证留白一致。 */}
      <div
        className="mt-3 flex w-full items-stretch"
        style={{ height, gap: `${STATUS_GAP}px` }}
      >
        {segments.map((seg, i) => (
          // min-w-[1px]: flex-1 在空间不足时会把块压成 0 宽, 条带就消失了。
          // 1px 是"还能看见一根线"的下限。
          <div
            key={i}
            className="h-full min-w-[1px] flex-1 cursor-help"
            style={{
              backgroundColor: STATUS_COLORS[seg.klass],
              opacity: seg.klass === 'empty' ? 0.5 : 1,
            }}
            {...handlers(statusTitle(seg, t, i18n.language))}
          />
        ))}
      </div>

      {/* 自定义浮层 —— 原生 title 在 Electron 里经常不弹、样式也不可控 */}
      <StatusTooltip content={content} onClose={close} />
    </>
  );
}

/**
 * 悬浮提示 —— 展示该色块对应的具体时间段和聚合信息。
 *
 * 例:
 *   时间：14:00 - 14:24 | 状态：包含 2 次断线
 *   时间：14:24 - 14:48 | 状态：100% 在线
 *
 * 时间用**当前界面语言**的时/分格式, 模板与插值值都走字典 ——
 * 不在逻辑层拼句子。
 */
function statusTitle(seg: StatusSegment, t: TFunction, lng: string): string {
  const fmt = (ts: number) =>
    new Date(ts).toLocaleTimeString(lng, {
      hour: '2-digit',
      minute: '2-digit',
    });

  const time = `${fmt(seg.from)} - ${fmt(seg.to)}`;

  if (seg.klass === 'offline') {
    return t('dashboard:status.tooltip_offline', { time, count: seg.outageCount });
  }

  if (seg.klass === 'degraded') {
    return t('dashboard:status.tooltip_degraded', {
      time,
      degraded: seg.degradedCount,
      samples: seg.sampleCount,
    });
  }

  if (seg.klass === 'online') {
    return t('dashboard:status.tooltip_online', { time });
  }

  if (seg.klass === 'unknown') {
    // 明确说"不知道", 而不是让用户以为那条灰带是"某种已知状态"
    return t('dashboard:status.tooltip_unknown', { time });
  }

  return t('dashboard:status.tooltip_empty', { time });
}
