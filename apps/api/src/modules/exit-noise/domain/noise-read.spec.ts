import type { ChainContractRef, OiRow } from '../../signal-trader/domain/oi-check';
import {
  chainComponent,
  futuresComponent,
  moveComponent,
  noiseRead,
  noiseVerdictOf,
  volumeComponent,
  vwapComponent,
  type NoiseComponent,
  type NoiseReadInput,
} from './noise-read';

const MIN = 60_000;
const STRIKES = Array.from({ length: 11 }, (_, i) => 74_000 + i * 100); // 74000 … 75000
const contracts: ChainContractRef[] = STRIKES.flatMap((s) => [
  { instrumentId: `CE${s}`, strike: s, optionType: 'CE' as const },
  { instrumentId: `PE${s}`, strike: s, optionType: 'PE' as const },
]);

/** One capture run: the CE / PE totals spread evenly over the 11 near strikes. */
function snapshot(at: Date, ceTotal: number, peTotal: number): OiRow[] {
  return contracts.map((c) => ({ instrumentId: c.instrumentId, oi: (c.optionType === 'CE' ? ceTotal : peTotal) / STRIKES.length, at }));
}

/**
 * Prod 2026-10-30, SENSEX26N0574500CE (BUY, paper): the AI trigger "SENSEX BELOW 74459.1" fired on the
 * 74458.33 print at 11:25 IST. The near-strike chain (74000–75000, expiry 2026-11-05) over the dip:
 * 11:21 → 11:24 IST, CALL OI 2,913,480 → 2,899,040 (−0.5%), PUT OI 2,768,520 → 2,855,480 (+3.1%). The
 * adverse move from the best point was ~1 N. No SENSEX future in oi_snapshots, no level book VWAP, and
 * the index has no volume.
 */
const EXIT = new Date('2026-10-30T05:55:20.000Z');
const SENSEX: NoiseReadInput = {
  at: EXIT,
  want: 'BULLISH',
  underlying: 74_458.33,
  n: 25.83,
  bestUnderlying: 74_484.16,
  chain: {
    expiry: '2026-11-05',
    contracts,
    rows: [
      ...snapshot(new Date('2026-10-30T05:51:15.710Z'), 2_913_480, 2_768_520),
      ...snapshot(new Date('2026-10-30T05:54:15.712Z'), 2_899_040, 2_855_480),
    ],
  },
  futures: null,
  vwap: null,
  volume: null,
};

const leanOf = (cs: NoiseComponent[], name: string) => cs.find((c) => c.name === name)?.lean;

describe('noise read — prod 2026-10-30 SENSEX26N0574500CE', () => {
  it('bullish CE, put OI +3.1%, call OI −0.5%, move 1 N → NOISE', () => {
    const r = noiseRead(SENSEX);
    expect(r.verdict).toBe('NOISE');
    expect(leanOf(r.components, 'MOVE')).toBe('NOISE');
    expect(leanOf(r.components, 'CHAIN')).toBe('NOISE');
    expect(leanOf(r.components, 'FUTURES')).toBeNull();
    expect(leanOf(r.components, 'VWAP')).toBeNull();
    expect(leanOf(r.components, 'VOLUME')).toBeNull();
    const move = r.components.find((c) => c.name === 'MOVE')!;
    expect(move.values).toMatchObject({ moveN: 1, points: 25.83 });
    const chain = r.components.find((c) => c.name === 'CHAIN')!;
    expect(chain.values).toMatchObject({ expiry: '2026-11-05', contracts: 22, cePct: -0.005, pePct: 0.0314 });
    expect(chain.values!.leanPct).toBeCloseTo((86_960 + 14_440) / 5_682_000, 4);
    expect(r.summary).toMatch(/^NOISE 2–0 \(want bullish\) move noise: move 1 N/);
    expect(r.summary).toContain('PE +3.1% CE -0.5%');
  });

  it('the same chain under a bearish position (long PE) is REAL: put writers defend the low it needs broken', () => {
    const r = noiseRead({ ...SENSEX, want: 'BEARISH', bestUnderlying: 74_458.33 - 3.5 * 25.83 });
    expect(leanOf(r.components, 'CHAIN')).toBe('REAL');
    expect(leanOf(r.components, 'MOVE')).toBe('REAL');
    expect(r.verdict).toBe('REAL');
  });
});

describe('noise read components', () => {
  it('MOVE: < 2 N noise, 2–3 N neutral, ≥ 3 N real; NO_DATA without the best point or N', () => {
    const m = (best: number) => moveComponent({ want: 'BULLISH', underlying: 100, n: 10, bestUnderlying: best }).lean;
    expect(m(119)).toBe('NOISE');
    expect(m(125)).toBe('NEUTRAL');
    expect(m(130)).toBe('REAL');
    // The underlying above the best point (no adverse move at all) is noise.
    expect(m(95)).toBe('NOISE');
    expect(moveComponent({ want: 'BULLISH', underlying: 100, n: null, bestUnderlying: 120 }).lean).toBeNull();
    expect(moveComponent({ want: 'BULLISH', underlying: 100, n: 10, bestUnderlying: null }).lean).toBeNull();
    // Bearish: the underlying RISING is adverse.
    expect(moveComponent({ want: 'BEARISH', underlying: 130, n: 10, bestUnderlying: 100 }).lean).toBe('REAL');
  });

  it('CHAIN: call writing + put unwinding under a bullish position is REAL; a flat chain is NEUTRAL', () => {
    const rows = [...snapshot(new Date(EXIT.getTime() - 7 * MIN), 2_900_000, 2_800_000), ...snapshot(new Date(EXIT.getTime() - MIN), 3_000_000, 2_700_000)];
    expect(chainComponent({ ...SENSEX, chain: { ...SENSEX.chain!, rows } }).lean).toBe('REAL');
    const flat = [...snapshot(new Date(EXIT.getTime() - 7 * MIN), 2_900_000, 2_800_000), ...snapshot(new Date(EXIT.getTime() - MIN), 2_901_000, 2_801_000)];
    expect(chainComponent({ ...SENSEX, chain: { ...SENSEX.chain!, rows: flat } }).lean).toBe('NEUTRAL');
  });

  it('CHAIN: "then" is the earliest snapshot within 9 min of the exit; a stale "now" or a single snapshot is NO_DATA', () => {
    const rows = [
      ...snapshot(new Date(EXIT.getTime() - 12 * MIN), 1_000_000, 1_000_000), // outside the window
      ...snapshot(new Date(EXIT.getTime() - 7 * MIN), 2_979_080, 2_729_780),
      ...snapshot(new Date(EXIT.getTime() - 4 * MIN), 2_913_480, 2_768_520),
      ...snapshot(new Date(EXIT.getTime() - MIN), 2_899_040, 2_855_480),
    ];
    const c = chainComponent({ ...SENSEX, chain: { ...SENSEX.chain!, rows } });
    expect(c.values!.from).toBe(new Date(EXIT.getTime() - 7 * MIN).toISOString());
    expect(c.lean).toBe('NOISE');
    const stale = chainComponent({ ...SENSEX, at: new Date(EXIT.getTime() + 10 * MIN) });
    expect(stale.lean).toBeNull();
    expect(stale.note).toMatch(/older than 6 min/);
    const one = chainComponent({ ...SENSEX, chain: { ...SENSEX.chain!, rows: snapshot(new Date(EXIT.getTime() - MIN), 1, 1) } });
    expect(one.lean).toBeNull();
    expect(chainComponent({ ...SENSEX, chain: null }).note).toMatch(/no option chain/);
  });

  it('FUTURES: price against + OI up = REAL, price against + OI down = NOISE, price not against = NEUTRAL', () => {
    const f = (oi: [number, number], px: [number, number], want: 'BULLISH' | 'BEARISH' = 'BULLISH') => {
      const t0 = new Date(EXIT.getTime() - 6 * MIN), t1 = new Date(EXIT.getTime() - MIN);
      return futuresComponent({
        at: EXIT, want,
        futures: {
          symbol: 'NIFTY25NOV26FUT', instrumentId: 'F', priceSource: 'oi_snapshots.ltp',
          rows: [{ instrumentId: 'F', oi: oi[0], at: t0 }, { instrumentId: 'F', oi: oi[1], at: t1 }],
          prices: [{ at: t0, close: px[0] }, { at: t1, close: px[1] }],
        },
      });
    };
    expect(f([1_000_000, 1_010_000], [23_000, 22_980]).lean).toBe('REAL');
    expect(f([1_000_000, 990_000], [23_000, 22_980]).lean).toBe('NOISE');
    expect(f([1_000_000, 1_010_000], [23_000, 23_020]).lean).toBe('NEUTRAL');
    expect(f([1_000_000, 1_010_000], [23_000, 23_020], 'BEARISH').lean).toBe('REAL');
    expect(f([1_000_000, 1_001_000], [23_000, 22_980]).lean).toBe('NEUTRAL');
    expect(futuresComponent({ at: EXIT, want: 'BULLISH', futures: null }).lean).toBeNull();
  });

  it('VWAP: on the position\'s side = NOISE, ≥ 0.5 N beyond = REAL, a different scale = NO_DATA', () => {
    const v = (vwap: number, want: 'BULLISH' | 'BEARISH' = 'BULLISH') => vwapComponent({ want, underlying: 23_000, n: 10, vwap: { value: vwap, source: 'test' } }).lean;
    expect(v(22_990)).toBe('NOISE');
    expect(v(23_002)).toBe('NEUTRAL');
    expect(v(23_010)).toBe('REAL');
    expect(v(23_010, 'BEARISH')).toBe('NOISE');
    expect(v(230)).toBeNull();
    expect(vwapComponent({ want: 'BULLISH', underlying: 23_000, n: 10, vwap: null }).lean).toBeNull();
  });

  it('VOLUME: the last 5 bars vs the 20 before — heavy = REAL, light = NOISE; too few bars = NO_DATA', () => {
    const bars = (dip: number) => Array.from({ length: 25 }, (_, i) => ({ at: new Date(EXIT.getTime() - (25 - i) * MIN), volume: i >= 20 ? dip : 1000 }));
    expect(volumeComponent({ at: EXIT, volume: { bars: bars(2000), source: 'test' } }).lean).toBe('REAL');
    expect(volumeComponent({ at: EXIT, volume: { bars: bars(500), source: 'test' } }).lean).toBe('NOISE');
    expect(volumeComponent({ at: EXIT, volume: { bars: bars(1100), source: 'test' } }).lean).toBe('NEUTRAL');
    expect(volumeComponent({ at: EXIT, volume: { bars: bars(1000).slice(15), source: 'test' } }).lean).toBeNull();
  });

  it('verdict: majority of the leaning components; a tie or all-neutral is MIXED; nothing read is NO_DATA', () => {
    const c = (lean: NoiseComponent['lean']): NoiseComponent => ({ name: 'MOVE', lean, note: '' });
    expect(noiseVerdictOf([c('NOISE'), c('NOISE'), c('REAL')])).toBe('NOISE');
    expect(noiseVerdictOf([c('REAL'), c('NEUTRAL'), c(null)])).toBe('REAL');
    expect(noiseVerdictOf([c('REAL'), c('NOISE')])).toBe('MIXED');
    expect(noiseVerdictOf([c('NEUTRAL'), c(null)])).toBe('MIXED');
    expect(noiseVerdictOf([c(null), c(null)])).toBe('NO_DATA');
  });

  it('never throws: nothing readable is NO_DATA, a malformed input is NO_DATA with the error', () => {
    const empty = noiseRead({ at: EXIT, want: 'BULLISH', underlying: null, n: null, bestUnderlying: null, chain: null, futures: null, vwap: null, volume: null });
    expect(empty.verdict).toBe('NO_DATA');
    expect(empty.components).toHaveLength(5);
    const bad = noiseRead({ ...SENSEX, chain: { expiry: 'x', contracts: null as never, rows: [] } });
    expect(bad.verdict).toBe('NO_DATA');
    expect(bad.error).toBeTruthy();
  });
});
