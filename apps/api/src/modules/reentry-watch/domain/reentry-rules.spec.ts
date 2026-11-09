import { trendReading, type Bar1m, type Direction } from '../../entry-engine/domain/entry-decision';
import { bankNiftyBars, istTs, niftyBars, niftyReversalBars } from './reentry-fixtures';
import {
  alertText, decideReentry, directionOf, moveInN, nameFromSymbol, noise15, noiseSessionOf, optionKindOf, REENTRY_WATCH, underlyingAt, type ReentryFacts, type ReentryVerdict,
  watchUnderlying,
} from './reentry-rules';

const MIN = 60_000;
const DAY = '2026-11-05';
const SESSION = new Date(istTs(DAY, '09:15'));

function facts(o: Partial<ReentryFacts> = {}): ReentryFacts {
  return {
    at: new Date(istTs(DAY, '10:30')),
    exitAt: new Date(istTs(DAY, '10:01')),
    lastReentryExitAt: null,
    inUniverse: true,
    sessionOpen: true,
    minutesToClose: 300,
    ref: 24402,
    price: 24440,
    noise: { n: 30, method: 'atr14-15m', buckets: 40 },
    trend: { lean: 'BULLISH', summary: 'bullish: test' },
    oi: null,
    reentriesForOriginal: 0,
    reentriesToday: 0,
    openOnUnderlying: 0,
    ...o,
  };
}

/** Walk one watch every 2 min from the exit to `until` over fixture bars; the first SIGNAL (and all verdicts). */
function replay(bars: Bar1m[], exitHhmm: string, original: Direction, until = '15:00') {
  const exitAt = new Date(istTs(DAY, exitHhmm));
  const ref = underlyingAt(bars, exitAt);
  const out: Array<{ at: Date; v: ReentryVerdict; price: number | null }> = [];
  for (let t = exitAt.getTime() + 2 * MIN; t <= istTs(DAY, until); t += 2 * MIN) {
    const at = new Date(t);
    const seen = bars.filter((b) => b.ts + MIN <= t);
    const trend = trendReading(seen, at, SESSION);
    const v = decideReentry(original, facts({ at, exitAt, ref, price: trend.price, noise: noise15(seen, at, noiseSessionOf("NFO")), trend, minutesToClose: Math.round((istTs(DAY, '15:30') - t) / MIN) }));
    out.push({ at, v, price: trend.price });
  }
  return { ref, out, first: out.find((x) => x.v.action === 'SIGNAL') ?? null };
}

const hhmm = (d: Date) => new Date(d.getTime() + 330 * MIN).toISOString().slice(11, 16);

describe('re-entry rules', () => {
  it('direction of the original trade; symbol helpers (never a token)', () => {
    expect(directionOf('CE', 'BUY')).toBe('BULLISH');
    expect(directionOf('PE', 'BUY')).toBe('BEARISH');
    expect(directionOf('CE', 'SELL')).toBe('BEARISH');
    expect(directionOf('PE', 'SELL')).toBe('BULLISH');
    expect(optionKindOf('NIFTY09NOV2624400CE')).toBe('CE');
    expect(optionKindOf('CRUDEOIL17NOV268600PE')).toBe('PE');
    expect(optionKindOf('NIFTY25NOV26FUT')).toBeNull();
    expect(nameFromSymbol('BANKNIFTY23NOV2656900CE')).toBe('BANKNIFTY');
    expect(nameFromSymbol('CRUDEOILM19NOV26FUT')).toBe('CRUDEOILM');
    expect(nameFromSymbol('RELIANCE-EQ')).toBeNull();
    expect(moveInN('BEARISH', 100, 90, 5)).toBe(2);
  });

  it('N15 is the 15-minute ATR of the 1-minute bars (gap excluded); falls back to the 1m unit × √15', () => {
    const bars = niftyBars();
    const n = noise15(bars, new Date(istTs(DAY, "10:30")), noiseSessionOf("NFO"));
    expect(n?.method).toBe('atr14-15m');
    expect(n!.n).toBeGreaterThan(15);
    expect(n!.n).toBeLessThan(60);
    const only = bars.filter((b) => b.ts >= istTs(DAY, '09:15'));
    const early = noise15(only, new Date(istTs(DAY, '09:40')));
    expect(early?.method).toMatch(/× √15$/);
  });

  it('prod 2026-11-05: NSE pre-open index bars (09:00 bar 23,608–24,580) are not noise — the session window drops them', () => {
    const bars = niftyBars();
    const at = new Date(istTs(DAY, '12:01'));
    const clean = noise15(bars, at, noiseSessionOf('NFO'))!.n;
    const preOpen: Bar1m[] = [
      { ts: istTs(DAY, '09:00'), open: 24330, high: 24580, low: 23608, close: 24548, volume: 0 },
      ...Array.from({ length: 14 }, (_, k) => ({ ts: istTs(DAY, '09:00') + (k + 1) * MIN, open: 24400, high: 24450, low: 24370, close: 24378, volume: 0 })),
    ];
    const dirty = [...bars, ...preOpen];
    expect(noise15(dirty, at)!.n).toBeGreaterThan(clean * 1.5);
    expect(noise15(dirty, at, noiseSessionOf('NFO'))!.n).toBe(clean);
    expect(noiseSessionOf('MCX')).toEqual({ fromMin: 540, toMin: 1435 });
  });

  it('2026-11-05 NIFTY09NOV2624400CE (exit 10:01 @147.15): SAME-direction re-entry once the index resumes up', () => {
    const r = replay(niftyBars(), '10:01', 'BULLISH');
    expect(r.ref).toBeGreaterThan(24380);
    expect(r.ref).toBeLessThan(24420);
    expect(r.first).not.toBeNull();
    expect(r.first!.v).toMatchObject({ action: 'SIGNAL', direction: 'SAME', enter: 'BULLISH' });
    expect(r.first!.at.getTime()).toBeGreaterThanOrEqual(istTs(DAY, '10:11'));
    expect(r.first!.at.getTime()).toBeLessThan(istTs(DAY, '13:48'));
    expect(r.first!.price!).toBeGreaterThan(r.ref!);
    // Nothing inside the 10-min cooldown.
    expect(r.out.filter((x) => x.at.getTime() < istTs(DAY, '10:11')).every((x) => x.v.category === 'cooldown')).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`[fixture replay] NIFTY SAME at ${hhmm(r.first!.at)} IST, index ${r.first!.price} vs exit point ${r.ref} — ${r.first!.v.reasons[0]}`);
  });

  it('2026-11-05 BANKNIFTY23NOV2656900CE (exit 10:07 @745.75): SAME-direction re-entry as the index resumes up', () => {
    const r = replay(bankNiftyBars(), '10:07', 'BULLISH');
    expect(r.first).not.toBeNull();
    expect(r.first!.v).toMatchObject({ action: 'SIGNAL', direction: 'SAME', enter: 'BULLISH' });
    expect(r.first!.at.getTime()).toBeGreaterThanOrEqual(istTs(DAY, '10:17'));
    expect(r.first!.at.getTime()).toBeLessThan(istTs(DAY, '13:43'));
    // eslint-disable-next-line no-console
    console.log(`[fixture replay] BANKNIFTY SAME at ${hhmm(r.first!.at)} IST, index ${r.first!.price} vs exit point ${r.ref} — ${r.first!.v.reasons[0]}`);
  });

  it('reversal: a CE exited at 10:01, the index rolls over ⇒ OPPOSITE re-entry (buy PE) at ≥ 2 N15 with the trend bearish', () => {
    const r = replay(niftyReversalBars(), '10:01', 'BULLISH');
    expect(r.first).not.toBeNull();
    expect(r.first!.v).toMatchObject({ action: 'SIGNAL', direction: 'OPPOSITE', enter: 'BEARISH' });
    expect(r.first!.v.move!).toBeLessThanOrEqual(-REENTRY_WATCH.oppositeN);
    // Never a SAME signal on the way down.
    expect(r.out.some((x) => x.v.direction === 'SAME')).toBe(false);
  });

  it('OPPOSITE needs the trend flipped AND OI not against', () => {
    const down = { price: 24402 - 2.2 * 30 };
    expect(decideReentry('BULLISH', facts({ ...down, trend: { lean: 'NEUTRAL', summary: 'neutral' } })).category).toBe('opposite-trend');
    const against = decideReentry('BULLISH', facts({ ...down, trend: { lean: 'BEARISH', summary: 'bearish' }, oi: { verdict: 'AGAINST', want: 'BEARISH', summary: 'put writing' } }));
    expect(against).toMatchObject({ action: 'WAIT', category: 'opposite-oi' });
    const ok = decideReentry('BULLISH', facts({ ...down, trend: { lean: 'BEARISH', summary: 'bearish' }, oi: { verdict: 'AGREES', want: 'BEARISH', summary: 'call writing' } }));
    expect(ok).toMatchObject({ action: 'SIGNAL', direction: 'OPPOSITE', enter: 'BEARISH' });
    // 1.5 N against is not enough.
    expect(decideReentry('BULLISH', facts({ price: 24402 - 45, trend: { lean: 'BEARISH', summary: 'bearish' } })).category).toBe('no-move');
  });

  it('SAME needs ≥ 1 N15 beyond the exit point AND the trend in the original direction; a PE mirrors it', () => {
    expect(decideReentry('BULLISH', facts({ price: 24402 + 29 })).category).toBe('no-move');
    expect(decideReentry('BULLISH', facts({ price: 24402 + 31 })).action).toBe('SIGNAL');
    expect(decideReentry('BULLISH', facts({ price: 24402 + 31, trend: { lean: 'NEUTRAL', summary: 'neutral' } })).category).toBe('same-trend');
    // CRUDEOIL17NOV268600PE (11-04, exit 18:08): crude kept falling ⇒ SAME (buy PE).
    const crude = decideReentry('BEARISH', facts({ ref: 8600, price: 8540, noise: { n: 25, method: 'atr14-15m', buckets: 30 }, trend: { lean: 'BEARISH', summary: 'bearish' } }));
    expect(crude).toMatchObject({ action: 'SIGNAL', direction: 'SAME', enter: 'BEARISH' });
  });

  it('caps, cooldown, open position, session end, and the end of the watch', () => {
    expect(decideReentry('BULLISH', facts({ at: new Date(istTs(DAY, '10:09')) })).category).toBe('cooldown');
    expect(decideReentry('BULLISH', facts({ at: new Date(istTs(DAY, '10:11')) })).action).toBe('SIGNAL');
    // After a re-entry closes, the cooldown restarts from its exit.
    expect(decideReentry('BULLISH', facts({ lastReentryExitAt: new Date(istTs(DAY, '10:25')) })).category).toBe('cooldown');
    expect(decideReentry('BULLISH', facts({ reentriesForOriginal: 2 })).category).toBe('cap-original');
    expect(decideReentry('BULLISH', facts({ reentriesForOriginal: 1 })).action).toBe('SIGNAL');
    expect(decideReentry('BULLISH', facts({ reentriesToday: 5 })).category).toBe('cap-day');
    expect(decideReentry('BULLISH', facts({ reentriesToday: 4 })).category).not.toBe('cap-day');
    expect(decideReentry('BULLISH', facts({ openOnUnderlying: 1 })).category).toBe('position-open');
    expect(decideReentry('BULLISH', facts({ minutesToClose: 20 })).category).toBe('session-end');
    expect(decideReentry('BULLISH', facts({ minutesToClose: null })).category).toBe('session-unreadable');
    expect(decideReentry('BULLISH', facts({ sessionOpen: false })).action).toBe('ENDED');
    expect(decideReentry('BULLISH', facts({ at: new Date(istTs('2026-11-06', '10:30')) })).action).toBe('ENDED');
    expect(decideReentry('BULLISH', facts({ inUniverse: false })).action).toBe('SKIP');
    expect(decideReentry('BULLISH', facts({ ref: null })).category).toBe('no-data');
  });

  it('the Telegram line names the direction, the exit point and the paper fill', () => {
    const t = alertText({
      underlying: 'NIFTY', original: 'BULLISH', verdict: { direction: 'SAME', enter: 'BULLISH' }, exitAt: new Date(istTs(DAY, '10:01')),
      ref: 24402, price: 24452, opened: { tradingsymbol: 'NIFTY10NOV2624450CE', price: 152.3 },
    });
    expect(t).toBe('Re-entry (paper): NIFTY CE same direction — NIFTY 24,452 back above the 10:01 exit point 24,402 with the trend bullish; bought NIFTY10NOV2624450CE @ 152.3');
    const o = alertText({ underlying: 'NIFTY', original: 'BULLISH', verdict: { direction: 'OPPOSITE', enter: 'BEARISH' }, exitAt: new Date(istTs(DAY, '10:01')), ref: 24402, price: 24330, opened: null, note: 'no fresh LTP' });
    expect(o).toContain('NIFTY PE opposite direction — NIFTY 24,330 fell below the 10:01 exit point 24,402 with the trend bearish; not opened — no fresh LTP');
  });
});

describe('watchUnderlying', () => {
  it('watches Crude Mini on CRUDEOIL, the same price with a line and a chain (prod 2026-11-06: skipped as not-in-universe)', () => {
    expect(watchUnderlying('CRUDEOILM')).toBe('CRUDEOIL');
  });
  it('leaves everything else alone', () => {
    expect(watchUnderlying('CRUDEOIL')).toBe('CRUDEOIL');
    expect(watchUnderlying('NIFTY')).toBe('NIFTY');
    expect(watchUnderlying('RELIANCE')).toBe('RELIANCE');
  });
});
