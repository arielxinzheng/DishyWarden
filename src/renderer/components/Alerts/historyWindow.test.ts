/**
 * historyWindow.ts 单元测试
 *
 * 覆盖：日期键换算、默认 7 天窗口、日期分割线的**语义标签**（不是成句文案）。
 *
 * 国际化改造后这一层的返回值变成了语义码（`{ kind: 'today' }`），
 * 文案在视图层翻译 —— 这里守住"逻辑层不产出任何语言的成句字符串"这条边界。
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WINDOW_DAYS,
  dayKeyOf,
  dayLabelOf,
  defaultRange,
  formatLocaleOf,
  formatMonthDay,
  groupByDay,
  startOfDayIso,
  endOfDayIso,
  ymdOf,
  ymdRangeToIso,
} from './historyWindow';

/** 本地时间构造的样本，避免 UTC 时区导致日期漂移 */
function localIso(
  y: number,
  m: number,
  d: number,
  h = 0,
  min = 0,
  s = 0,
  ms = 0
): string {
  return new Date(y, m - 1, d, h, min, s, ms).toISOString();
}

describe('historyWindow.ts - 日期键换算', () => {
  it('ymdOf 按本地日历日输出补零的 YYYY-MM-DD', () => {
    expect(ymdOf(new Date(2026, 10, 5, 23, 30).getTime())).toBe('2026-11-05');
    expect(ymdOf(new Date(2026, 0, 9, 1, 0).getTime())).toBe('2026-01-09');
  });

  it('dayKeyOf 解析 ISO 时间戳', () => {
    expect(dayKeyOf(localIso(2026, 11, 5, 9))).toBe('2026-11-05');
  });

  it('dayKeyOf 遇到脏数据返回空串而不是抛错', () => {
    expect(dayKeyOf('not-a-date')).toBe('');
    expect(dayKeyOf('')).toBe('');
  });

  it('formatMonthDay 按 locale 格式化，不拼接固定汉字', () => {
    expect(formatMonthDay('2026-11-05', 'zh-CN')).toBe('11月5日');
    expect(formatMonthDay('2026-11-05', 'en-US')).toBe('Nov 5');
  });

  it('formatLocaleOf 把未翻译的语言收敛到有字典的 locale', () => {
    expect(formatLocaleOf('zh-CN')).toBe('zh-CN');
    expect(formatLocaleOf('zh-Hans')).toBe('zh-CN');
    expect(formatLocaleOf('en-US')).toBe('en');
    expect(formatLocaleOf('ja')).toBe('en');
    expect(formatLocaleOf('ko-KR')).toBe('en');
  });

  it('formatMonthDay 对非法输入返回空串', () => {
    expect(formatMonthDay('', 'zh-CN')).toBe('');
    expect(formatMonthDay('2026-11', 'zh-CN')).toBe('');
    expect(formatMonthDay('2026-aa-bb', 'zh-CN')).toBe('');
  });
});

describe('historyWindow.ts - 分割线标签语义', () => {
  const now = new Date(2026, 10, 5, 12, 0, 0).getTime();

  it('今天', () => {
    expect(dayLabelOf('2026-11-05', now)).toEqual({ kind: 'today', dayKey: '2026-11-05' });
  });

  it('昨天', () => {
    expect(dayLabelOf('2026-11-04', now)).toEqual({ kind: 'yesterday', dayKey: '2026-11-04' });
  });

  it('更早的日期回退成具体日期', () => {
    expect(dayLabelOf('2026-11-03', now)).toEqual({ kind: 'date', dayKey: '2026-11-03' });
  });

  it('日期键为空时是 unknown', () => {
    expect(dayLabelOf('', now)).toEqual({ kind: 'unknown', dayKey: '' });
  });

  it('返回值里没有任何成句文案', () => {
    const label = dayLabelOf('2026-11-05', now);
    expect(JSON.stringify(label)).not.toMatch(/今日|昨日|未知/);
  });
});

describe('historyWindow.ts - 时间窗口', () => {
  const now = new Date(2026, 10, 5, 12, 0, 0).getTime();

  it('默认窗口是含今天在内的 7 个自然日，起点为今天 00:00 往前推 6 天', () => {
    const range = defaultRange(now);
    const expectedStart = new Date(2026, 9, 30, 0, 0, 0, 0).toISOString();
    expect(DEFAULT_WINDOW_DAYS).toBe(7);
    expect(range.from).toBe(expectedStart);
    expect(range.to).toBe(new Date(now).toISOString());
  });

  it('startOfDayIso / endOfDayIso 覆盖整天两端', () => {
    expect(startOfDayIso('2026-11-05')).toBe(new Date(2026, 10, 5, 0, 0, 0, 0).toISOString());
    expect(endOfDayIso('2026-11-05')).toBe(
      new Date(2026, 10, 5, 23, 59, 59, 999).toISOString()
    );
  });

  it('ymdRangeToIso 把日期区间转成含尾整天的 ISO 区间', () => {
    expect(ymdRangeToIso({ from: '2026-11-01', to: '2026-11-03' })).toEqual({
      from: new Date(2026, 10, 1, 0, 0, 0, 0).toISOString(),
      to: new Date(2026, 10, 3, 23, 59, 59, 999).toISOString(),
    });
  });
});

describe('historyWindow.ts - 按日分组', () => {
  const now = new Date(2026, 10, 5, 12, 0, 0).getTime();

  it('按 last_seen 的本地日期相邻聚合，不重排', () => {
    const items = [
      { id: 'a', last_seen: localIso(2026, 11, 5, 11) },
      { id: 'b', last_seen: localIso(2026, 11, 5, 9) },
      { id: 'c', last_seen: localIso(2026, 11, 4, 18) },
      { id: 'd', last_seen: localIso(2026, 11, 3, 7) },
    ];
    const groups = groupByDay(items, now);

    expect(groups.map((g) => g.dayKey)).toEqual(['2026-11-05', '2026-11-04', '2026-11-03']);
    expect(groups.map((g) => g.label.kind)).toEqual(['today', 'yesterday', 'date']);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(groups[2]!.items.map((i) => i.id)).toEqual(['d']);
  });

  it('空列表返回空分组', () => {
    expect(groupByDay([], now)).toEqual([]);
  });

  it('同一天被隔开时会分成两段（只做相邻聚合）', () => {
    const items = [
      { id: 'a', last_seen: localIso(2026, 11, 5, 11) },
      { id: 'b', last_seen: localIso(2026, 11, 4, 18) },
      { id: 'c', last_seen: localIso(2026, 11, 5, 9) },
    ];
    const groups = groupByDay(items, now);
    expect(groups).toHaveLength(3);
    expect(groups[2]!.dayKey).toBe('2026-11-05');
    expect(groups[2]!.label.kind).toBe('today');
  });
});
