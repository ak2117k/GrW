import type { AiJob } from '../ai-job';
import { AiBudgetExceeded, BudgetMeter } from './budget-meter';

/** Deterministic PRNG (mulberry32) so the property test is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function meter(opts: { cap?: number; spent?: number; now?: () => Date } = {}) {
  const spentToday = jest.fn().mockResolvedValue(opts.spent ?? 0);
  const m = new BudgetMeter({
    capInr: opts.cap ?? 100,
    reserveShare: 0.25,
    spentToday,
    now: opts.now ?? (() => new Date('2026-10-12T06:00:00Z')),
  });
  return { m, spentToday };
}

describe('BudgetMeter', () => {
  it('refuses a non-review job past cap*(1-reserve) but lets a review job use the full cap', async () => {
    const { m } = meter();
    await m.refresh();
    m.reserve('decision.judge', 70);
    expect(() => m.reserve('decision.judge', 6)).toThrow(AiBudgetExceeded);
    expect(() => m.reserve('sentinel.judge', 30.01)).toThrow(AiBudgetExceeded);
    expect(() => m.reserve('sentinel.judge', 30)).not.toThrow();
  });

  it('allows a non-review job exactly up to 75% of the cap', async () => {
    const { m } = meter();
    await m.refresh();
    expect(() => m.reserve('news.impact', 75)).not.toThrow();
    expect(() => m.reserve('news.impact', 0.0001)).toThrow(AiBudgetExceeded);
  });

  it('counts spend already recorded today', async () => {
    const { m } = meter({ spent: 90 });
    await m.refresh();
    expect(() => m.reserve('news.impact', 1)).toThrow(AiBudgetExceeded);
    expect(() => m.reserve('review.overnight', 10)).not.toThrow();
    expect(() => m.reserve('review.overnight', 0.01)).toThrow(AiBudgetExceeded);
  });

  it('settle replaces the reservation with the actual cost', async () => {
    const { m } = meter();
    await m.refresh();
    const r = m.reserve('news.impact', 70);
    r.settle(5);
    expect(() => m.reserve('news.impact', 70)).not.toThrow();
    expect(() => m.reserve('news.impact', 0.01)).toThrow(AiBudgetExceeded);
  });

  it('release frees the reservation entirely', async () => {
    const { m } = meter();
    await m.refresh();
    const r = m.reserve('news.impact', 75);
    r.release();
    expect(() => m.reserve('news.impact', 75)).not.toThrow();
  });

  it('a reservation settles or releases at most once', async () => {
    const { m } = meter();
    await m.refresh();
    const r = m.reserve('news.impact', 50);
    r.settle(10);
    r.release();
    r.settle(10);
    expect(() => m.reserve('news.impact', 65)).not.toThrow();
    expect(() => m.reserve('news.impact', 0.01)).toThrow(AiBudgetExceeded);
  });

  it('refreshes spend only once per IST day', async () => {
    let now = new Date('2026-10-12T06:00:00Z');
    const { m, spentToday } = meter({ now: () => now });
    await m.refresh();
    await m.refresh();
    expect(spentToday).toHaveBeenCalledTimes(1);
    now = new Date('2026-10-12T18:29:59Z'); // 23:59:59 IST, same day
    await m.refresh();
    expect(spentToday).toHaveBeenCalledTimes(1);
    now = new Date('2026-10-12T18:30:00Z'); // 00:00 IST next day
    await m.refresh();
    expect(spentToday).toHaveBeenCalledTimes(2);
  });

  it('day rollover at 00:00 IST resets committed spend and reservations', async () => {
    let now = new Date('2026-10-12T18:00:00Z'); // 23:30 IST
    const spentToday = jest.fn().mockResolvedValueOnce(70).mockResolvedValueOnce(0);
    const m = new BudgetMeter({ capInr: 100, reserveShare: 0.25, spentToday, now: () => now });
    await m.refresh();
    m.reserve('news.impact', 5).settle(5);
    expect(() => m.reserve('news.impact', 1)).toThrow(AiBudgetExceeded);
    now = new Date('2026-10-12T18:30:00Z'); // 00:00 IST
    // Until the new day's spend is loaded the meter fails closed rather than
    // reusing yesterday's ledger or assuming zero.
    expect(() => m.reserve('news.impact', 1)).toThrow(AiBudgetExceeded);
    await m.refresh();
    expect(() => m.reserve('news.impact', 75)).not.toThrow();
    expect(() => m.reserve('news.impact', 0.01)).toThrow(AiBudgetExceeded);
  });

  it('a reservation from the previous IST day does not touch the new day ledger', async () => {
    let now = new Date('2026-10-12T18:00:00Z');
    const { m } = meter({ now: () => now });
    await m.refresh();
    const stale = m.reserve('news.impact', 50);
    now = new Date('2026-10-12T18:30:00Z');
    await m.refresh();
    stale.settle(50);
    expect(() => m.reserve('news.impact', 75)).not.toThrow();
  });

  it('concurrent refresh calls load spend once', async () => {
    const { m, spentToday } = meter();
    await Promise.all([m.refresh(), m.refresh(), m.refresh()]);
    expect(spentToday).toHaveBeenCalledTimes(1);
  });

  it('a failed load propagates and is retried on the next refresh', async () => {
    const spentToday = jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(0);
    const m = new BudgetMeter({ capInr: 100, reserveShare: 0.25, spentToday, now: () => new Date('2026-10-12T06:00:00Z') });
    await expect(m.refresh()).rejects.toThrow('db down');
    expect(() => m.reserve('news.impact', 1)).toThrow(AiBudgetExceeded);
    await m.refresh();
    expect(() => m.reserve('news.impact', 1)).not.toThrow();
  });

  it('refuses everything (fails closed) when spend has never been loaded', () => {
    const { m } = meter();
    expect(() => m.reserve('sentinel.judge', 1)).toThrow(AiBudgetExceeded);
  });

  it('refuses a negative or non-finite worst case', async () => {
    const { m } = meter();
    await m.refresh();
    expect(() => m.reserve('news.impact', Number.NaN)).toThrow(AiBudgetExceeded);
    expect(() => m.reserve('news.impact', -1)).toThrow(AiBudgetExceeded);
  });

  /**
   * Review Focus 2: under ANY interleaving of reserve / settle / release, committed + reserved
   * never exceeds the cap. Actual cost is bounded by the worst case (it is, by construction).
   */
  it('property: committed + reserved never exceeds the cap (500 seeded interleavings)', async () => {
    const jobs: AiJob[] = ['sentinel.judge', 'review.overnight', 'decision.judge', 'news.impact', 'picks.next-day'];
    for (let seed = 1; seed <= 500; seed++) {
      const rnd = prng(seed);
      const cap = 10 + rnd() * 200;
      const { m } = meter({ cap, spent: rnd() * cap * 0.5 });
      await m.refresh();
      const open: Array<{ worst: number; r: ReturnType<BudgetMeter['reserve']> }> = [];
      for (let step = 0; step < 60; step++) {
        const op = rnd();
        if (op < 0.55 || open.length === 0) {
          const job = jobs[Math.floor(rnd() * jobs.length)];
          const worst = rnd() * cap * 0.4;
          try {
            open.push({ worst, r: m.reserve(job, worst) });
          } catch (e) {
            expect(e).toBeInstanceOf(AiBudgetExceeded);
          }
        } else {
          const i = Math.floor(rnd() * open.length);
          const [o] = open.splice(i, 1);
          if (rnd() < 0.6) o.r.settle(rnd() * o.worst);
          else o.r.release();
        }
        const s = m.snapshot();
        expect(s.committedInr + s.reservedInr).toBeLessThanOrEqual(cap + 1e-9);
      }
    }
  });
});
