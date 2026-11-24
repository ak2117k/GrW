import { readChart, supertrend, type ChartBar } from '../../exit-discipline/chart-read';
import { istMinuteOf } from '../../exit-discipline/session-bars';
import { MemoryCandleRepo } from '../../market-hub/testing/memory-candle-repo';
import { BANKNIFTY_23NOV_1M, BANKNIFTY_REF, ist, PRIOR_DAYS, syntheticHistory, type M1 } from '../../market-hub/testing/banknifty-2026-11-23-preopen';
import type { InstrumentRef } from '../../market-hub/hub.types';
import { ChartConfirmReader, type UnderlyingLookup } from './chart-confirm.reader';

const lookup = (exchange: string, name: string): UnderlyingLookup => ({
  tracker: async () => ({ symbol: `${name}25NOV64000PE`, exchange, token: 'opt' }),
  contract: async () => ({ name }),
  nearestFuture: async () => ({ exchange: 'MCX', token: 'fut', symbol: `${name}FUT` }),
  cashRef: async () => null,
});

async function repoWith(ref: InstrumentRef, bars: Parameters<MemoryCandleRepo['upsert']>[2]) {
  const repo = new MemoryCandleRepo();
  await repo.upsert('1m', ref, bars, 'tick');
  return repo;
}

/**
 * The OLD reader's bars: every stored 1m row (no session filter — the repo filters now, so the raw rows are bucketed
 * here) in clock-aligned buckets (origin 09:15 IST, a multiple of 5 and 15 min), with only the "closed" filter.
 */
function unfiltered(raw: readonly M1[], step: number, now: Date): ChartBar[] {
  const ms = step * 60_000;
  const from = now.getTime() - 5 * 86_400_000;
  const buckets = new Map<number, ChartBar>();
  for (const r of [...raw].sort((a, b) => a.ts - b.ts)) {
    if (r.ts < from || r.ts >= now.getTime()) continue;
    const k = Math.floor(r.ts / ms) * ms;
    const c = buckets.get(k);
    if (!c) buckets.set(k, { ts: k, open: r.open, high: r.high, low: r.low, close: r.close });
    else Object.assign(c, { high: Math.max(c.high, r.high), low: Math.min(c.low, r.low), close: r.close });
  }
  return [...buckets.values()].filter((x) => x.ts + ms <= now.getTime()).sort((a, b) => a.ts - b.ts);
}

describe('ChartConfirmReader — session bars only (2026-11-23 BANKNIFTY pre-open)', () => {
  const ref = BANKNIFTY_REF as unknown as InstrumentRef;
  const now = new Date(ist('2026-11-23 09:21'));

  it('bars5 / bars15 hold no pre-open, night or post-close bucket; bars15 ends at the previous session before 09:30', async () => {
    const raw = [...syntheticHistory(PRIOR_DAYS), ...BANKNIFTY_23NOV_1M];
    const repo = await repoWith(ref, raw);
    const old15 = unfiltered(raw, 15, now);
    expect(old15[old15.length - 1].ts).toBe(ist('2026-11-23 09:00')); // the bug: the auction bucket is the last closed bar
    const d = await new ChartConfirmReader(repo, lookup('NFO', 'BANKNIFTY')).read('t1', now);
    expect(d).not.toBeNull();
    expect(d!.ref).toMatchObject({ exchange: 'NSE', token: '99926009' });
    for (const b of [...d!.bars5, ...d!.bars15]) {
      const m = istMinuteOf(b.ts);
      expect(m >= 555 && m < 930).toBe(true);
    }
    expect(d!.bars15[d!.bars15.length - 1].ts).toBe(ist('2026-11-20 15:15'));
    expect(d!.bars5.map((b) => b.ts).slice(-1)).toEqual([ist('2026-11-23 09:15')]); // 09:15–09:20 closed
    expect(d!.bars15.length % 25).toBe(0); // whole sessions only (N15_LOOKBACK_DAYS = 5 calendar days: 18–20 Nov)
    expect(d!.n15).not.toBeNull();
  });

  it('readChart: the "closed bar beyond invalidation" and Supertrend checks no longer see the auction', async () => {
    const raw = [...syntheticHistory(PRIOR_DAYS), ...BANKNIFTY_23NOV_1M];
    const repo = await repoWith(ref, raw);
    const d = (await new ChartConfirmReader(repo, lookup('NFO', 'BANKNIFTY')).read('t1', now))!;
    const old5 = unfiltered(raw, 5, now);
    const old15 = unfiltered(raw, 15, now);
    // A PE (bear) position, invalidation 64,950 above: the 09:00 bucket closed 65,012 (an indicative price) ⇒ old = against.
    const base = { bull: false, underlyingNow: 64197.55, invalidation: 64950, bestUnderlying: null, n15: null, k15: 1.5 };
    const before = readChart({ ...base, bars5: old5.filter((b) => b.ts < ist('2026-11-23 09:15')), bars15: old15 });
    expect(before.measured.close15).toBe(65012.05);
    expect(before.reasons.join(' ')).toContain('closed beyond the invalidation 64950');
    const after = readChart({ ...base, bars5: d.bars5, bars15: d.bars15 });
    expect(after.measured.close15).not.toBe(65012.05);
    expect(after.reasons.join(' ')).not.toContain('closed beyond the invalidation 64950');
    // In this fixture the off-session buckets (auction + flat copies) flip the 15m Supertrend UP (against the PE); session bars read DOWN.
    expect([before.measured.supertrend15, after.measured.supertrend15]).toEqual(['UP', 'DOWN']);
    expect(after.against).toBe(false);
    // Supertrend is computed from the session bars only.
    expect(after.measured.supertrendLine15).toBe(supertrend(d.bars15)!.line);
    expect(supertrend(old15)!.line).not.toBe(after.measured.supertrendLine15);
  });

  it('MCX is unchanged: the 09:00 bucket is a session bucket', async () => {
    const mref = { exchange: 'MCX', token: 'fut', symbol: 'CRUDEOILFUT' } as unknown as InstrumentRef;
    const bars = Array.from({ length: 60 }, (_, i) => ({ ts: ist('2026-11-23 09:00') + i * 60_000, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 }));
    const repo = await repoWith(mref, bars);
    const d = (await new ChartConfirmReader(repo, lookup('MCX', 'CRUDEOIL')).read('t2', new Date(ist('2026-11-23 10:00'))))!;
    expect(d.bars15.map((b) => b.ts)).toEqual([ist('2026-11-23 09:00'), ist('2026-11-23 09:15'), ist('2026-11-23 09:30'), ist('2026-11-23 09:45')]);
    expect(d.bars5[0].ts).toBe(ist('2026-11-23 09:00'));
  });
});
