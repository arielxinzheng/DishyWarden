import { describe, it, expect } from 'vitest';
import { buildMockSummary } from './mockTelemetry';

describe('buildMockSummary (browser-dev mock usage estimate)', () => {
  it('bytes = avgBps × seconds ÷ 8 — must divide by 8 (bps→Bytes), not 8× inflated', () => {
    // Regression: the old code did `avgDownlink * seconds` (bits labelled as bytes),
    // which made the browser-dev "24H 用量" card show ~8× the real estimate.
    // The SQLite path (telemetryStore.summarize) always divided by 8; this must match.
    const s = buildMockSummary(86400);

    expect(s.estimatedDownBytes).toBeCloseTo((s.avgDownBps * 86400) / 8, -4);
    expect(s.estimatedUpBytes).toBeCloseTo((s.avgUpBps * 86400) / 8, -4);
  });

  it('down estimate falls within mock throughput range (50–150 Mbps × 24h ÷ 8)', () => {
    const s = buildMockSummary(86400);
    const gbDay = (mbps: number) => (mbps * 1e6 * 86400) / 8 / 1e9;

    expect(s.estimatedDownBytes / 1e9).toBeGreaterThan(gbDay(50));
    expect(s.estimatedDownBytes / 1e9).toBeLessThan(gbDay(150));
  });
});
