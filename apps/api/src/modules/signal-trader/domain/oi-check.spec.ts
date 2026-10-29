import { buildupOf, nearStrikes, oiCheck, oiVerdictOf, verdictOf, wantedLean, type ChainContractRef, type OiCheckInput, type OiRow } from './oi-check';
import { paperByOi } from './paper-summary';

const MIN = 60_000;
/** MCX session open 2026-10-29 09:00 IST. */
const OPEN = new Date('2026-10-29T03:30:00Z');
const STRIKES = Array.from({ length: 15 }, (_, i) => 5050 + i * 50); // 5050 … 5750, crude ~5400

const contracts: ChainContractRef[] = STRIKES.flatMap((s) => [
  { instrumentId: `CE${s}`, strike: s, optionType: 'CE' as const },
  { instrumentId: `PE${s}`, strike: s, optionType: 'PE' as const },
]);

/**
 * Snapshot rows every 3 min from the open to `until`, CE / PE OI per strike scaled by ce(t) / pe(t)
 * (t = minutes after the open). `broken` timestamps keep only the first 6 contracts (the prod quirk:
 * a bucket missing most strikes).
 */
function series(untilMin: number, ce: (t: number) => number, pe: (t: number) => number, broken: number[] = [], skipIds: (t: number) => string[] = () => []): OiRow[] {
  const rows: OiRow[] = [];
  for (let t = 0; t <= untilMin; t += 3) {
    const at = new Date(OPEN.getTime() + t * MIN);
    let n = 0;
    for (const c of contracts) {
      if (broken.includes(t) && n >= 6) break;
      if (skipIds(t).includes(c.instrumentId)) continue;
      n++;
      rows.push({ instrumentId: c.instrumentId, oi: Math.round((c.optionType === 'CE' ? 150_000 * ce(t) : 160_000 * pe(t))), at });
    }
  }
  return rows;
}

const input = (at: Date, want: 'BULLISH' | 'BEARISH', rows: OiRow[], center: number | null = 5410): OiCheckInput => ({
  at,
  want,
  sessionStart: OPEN,
  chain: { expiry: '2026-11-17', contracts, rows, center, centerSource: 'test' },
  futures: null,
});

describe('OI check — 2026-10-29 CRUDEOIL', () => {
  it('CE at 14:11 IST: near-money put OI unwound −22% since the open, calls flat → AGAINST (chain)', () => {
    const at = new Date('2026-10-29T08:41:00Z'); // 14:11 IST = open + 311 min
    // PE falls linearly to −22% by the last snapshot (309 min); 14:12 IST-equivalent bucket at 282 min is broken.
    const rows = series(309, () => 1, (t) => 1 - 0.22 * (t / 309), [282]);
    const c = oiCheck(input(at, wantedLean('CE', 'BUY'), rows));
    expect(c.verdict).toBe('AGAINST');
    expect(c.source).toBe('CHAIN');
    expect(c.chain!.strikes).toEqual([5150, 5200, 5250, 5300, 5350, 5400, 5450, 5500, 5550, 5600, 5650]);
    const open = c.chain!.windows.open!;
    expect(open.from).toBe(OPEN.toISOString());
    expect(open.to).toBe('2026-10-29T08:39:00.000Z');
    expect(open.cePct).toBe(0);
    expect(open.pePct).toBeCloseTo(-0.22, 3);
    expect(open.lean).toBe('BEARISH');
    // The broken 08:12Z bucket (6 contracts) is never a window end; the 30-min one is 08:09Z.
    expect(c.chain!.windows.ago!.from).toBe('2026-10-29T08:09:00.000Z');
    expect(c.chain!.windows.ago!.contracts).toBe(22);
    expect(c.chain!.note).toMatch(/1 snapshot\(s\) covering < 80%/);
    expect(c.summary).toMatch(/^AGAINST \(chain 2026-11-17, want bullish\)/);
  });

  it('put writing in the last 30 min (+14% puts) → AGAINST a PE (synthetic; the real 14:39 PE was AGREES at entry)', () => {
    const at = new Date('2026-10-29T09:09:00Z'); // 14:39 IST = open + 339 min
    // Puts unwind to −10% by 309 min (14:09), then are written back to +3% vs the open by 336 min.
    const pe = (t: number) => (t <= 309 ? 1 - 0.1 * (t / 309) : 0.9 + 0.13 * ((t - 309) / 27));
    const c = oiCheck(input(at, wantedLean('PE', 'BUY'), series(336, () => 1, pe)));
    expect(c.want).toBe('BEARISH');
    expect(c.chain!.windows.ago!.lean).toBe('BULLISH');
    expect(c.chain!.windows.ago!.pePct).toBeGreaterThan(0.1);
    expect(c.chain!.windows.open!.lean).toBe('NEUTRAL');
    expect(c.verdict).toBe('AGAINST');
  });
});

describe('OI check — rules', () => {
  const at = new Date('2026-10-29T08:41:00Z');

  it('agreeing chain → AGREES; windows that disagree with each other → MIXED; no lean → MIXED', () => {
    expect(oiCheck(input(at, 'BULLISH', series(309, () => 1, (t) => 1 + 0.2 * (t / 309)))).verdict).toBe('AGREES');
    // Puts unwound all day (bearish since open) but written hard in the last 30 min (bullish).
    const pe = (t: number) => (t <= 279 ? 1 - 0.3 * (t / 279) : 0.7 + 0.15 * ((t - 279) / 30));
    expect(oiCheck(input(at, 'BULLISH', series(309, () => 1, pe))).verdict).toBe('MIXED');
    expect(oiCheck(input(at, 'BULLISH', series(309, () => 1, () => 1))).verdict).toBe('MIXED');
  });

  it('like-for-like: strikes missing from the latest snapshot are left out of both sides (no fake unwinding)', () => {
    const rows = series(309, () => 1, () => 1, [], (t) => (t === 309 ? ['PE5400', 'CE5400'] : []));
    const c = oiCheck(input(at, 'BULLISH', rows));
    expect(c.chain!.windows.open!.contracts).toBe(20);
    expect(c.chain!.windows.open!.pePct).toBe(0);
    expect(c.chain!.windows.open!.lean).toBe('NEUTRAL');
  });

  it('NO_DATA: no snapshots, a stale latest snapshot, no centre price, nothing at all', () => {
    expect(oiCheck({ at, want: 'BULLISH', sessionStart: OPEN, chain: null, futures: null })).toMatchObject({ verdict: 'NO_DATA', source: 'NONE' });
    const stale = oiCheck(input(at, 'BULLISH', series(250, () => 1, (t) => 1 - 0.2 * (t / 250))));
    expect(stale.verdict).toBe('NO_DATA');
    expect(stale.chain!.note).toMatch(/older than 15 min/);
    expect(oiCheck(input(at, 'BULLISH', series(309, () => 1, () => 0.5), null)).summary).toMatch(/no underlying price/);
  });

  it('futures buildup when the chain is unavailable: OI and price over the same windows', () => {
    const futRows: OiRow[] = [];
    const prices: Array<{ at: Date; close: number }> = [];
    for (let t = 0; t <= 309; t += 3) futRows.push({ instrumentId: 'FUT', oi: Math.round(1_000_000 * (1 + 0.05 * (t / 309))), at: new Date(OPEN.getTime() + t * MIN) });
    for (let t = 0; t <= 310; t++) prices.push({ at: new Date(OPEN.getTime() + t * MIN), close: 1000 - 20 * (t / 310) });
    const i: OiCheckInput = { at, want: 'BULLISH', sessionStart: OPEN, chain: null, futures: { instrumentId: 'FUT', symbol: 'RELIANCE25NOVFUT', rows: futRows, prices, priceSource: 'candles_1m RELIANCE25NOVFUT' } };
    const c = oiCheck(i);
    expect(c.source).toBe('FUTURES');
    expect(c.futures!.windows.open!.buildup).toBe('SHORT_BUILDUP');
    expect(c.verdict).toBe('AGAINST');
    expect(oiCheck({ ...i, want: 'BEARISH' }).verdict).toBe('AGREES');
    // No price near the snapshots → buildup unknown → NO_DATA, OI numbers still kept.
    const noPrice = oiCheck({ ...i, futures: { ...i.futures!, prices: [] } });
    expect(noPrice.verdict).toBe('NO_DATA');
    expect(noPrice.futures!.windows.open!.oiPct).toBeCloseTo(0.05, 3);
  });

  it('buildups, wanted direction, verdict combination and stored-verdict parsing', () => {
    expect(buildupOf(0.02, 0.005)).toBe('LONG_BUILDUP');
    expect(buildupOf(0.02, -0.005)).toBe('SHORT_BUILDUP');
    expect(buildupOf(-0.02, 0.005)).toBe('SHORT_COVERING');
    expect(buildupOf(-0.02, -0.005)).toBe('LONG_UNWINDING');
    expect(buildupOf(0.005, 0.01)).toBe('NEUTRAL');
    expect(wantedLean('CE', 'BUY')).toBe('BULLISH');
    expect(wantedLean('PE', 'BUY')).toBe('BEARISH');
    expect(wantedLean('CE', 'SELL')).toBe('BEARISH');
    expect(wantedLean('PE', 'SELL')).toBe('BULLISH');
    expect(wantedLean('FUT', 'SELL')).toBe('BEARISH');
    expect(wantedLean('EQ', 'BUY')).toBe('BULLISH');
    expect(verdictOf('BULLISH', ['BULLISH', 'NEUTRAL'])).toBe('AGREES');
    expect(verdictOf('BULLISH', ['BEARISH', null])).toBe('AGAINST');
    expect(verdictOf('BULLISH', [null, null])).toBe('NO_DATA');
    expect(nearStrikes([100, 200, 300], 260, 1)).toEqual([200, 300]);
    expect(oiVerdictOf({ verdict: 'AGAINST' })).toBe('AGAINST');
    expect(oiVerdictOf(null)).toBe('NO_DATA');
  });

  it('a throwing input is NO_DATA with the error, never thrown', () => {
    const bad = { at, want: 'BULLISH', sessionStart: OPEN, chain: { expiry: 'x', contracts: null, rows: [], center: 1, centerSource: '' }, futures: null } as unknown as OiCheckInput;
    expect(oiCheck(bad)).toMatchObject({ verdict: 'NO_DATA', source: 'NONE', error: expect.any(String) });
  });
});

describe('paper P&L by OI verdict', () => {
  it('buckets like the judge split; a missing verdict is NO_DATA', () => {
    const tr = (entry: number, exit: number | null, qty: number) => ({ status: exit === null ? 'OPEN' : 'CLOSED', side: 'BUY', quantity: qty, entryPrice: entry, exitPrice: exit, pnl: 10 });
    const s = paperByOi([
      { oiVerdict: 'AGAINST', trade: tr(100, 80, 10) },
      { oiVerdict: 'AGAINST', trade: tr(100, 90, 10) },
      { oiVerdict: 'AGREES', trade: tr(100, 120, 10) },
      { oiVerdict: 'NO_DATA', trade: tr(100, null, 1) },
      { oiVerdict: 'MIXED', trade: null },
    ]);
    expect(s.AGAINST).toMatchObject({ n: 2, losses: 2, gross: -300, winRate: 0 });
    expect(s.AGREES).toMatchObject({ n: 1, wins: 1, gross: 200 });
    expect(s.NO_DATA).toMatchObject({ n: 1, open: 1, openMark: 10 });
    expect(s.MIXED.n).toBe(0);
  });
});
