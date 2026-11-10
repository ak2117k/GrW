import { channelStatsForJudge, labelChain, noiseBlock, optionValue, packetMarketFacts, stopDistance, underlyingNoise } from './judge-noise';
import { bsAbsDelta, daysToExpiry, deltaReading, normCdf } from './option-delta';
import { SIGNAL_JUDGE_PROMPT_VERSION, SIGNAL_JUDGE_SYSTEM } from './judge';

const T0 = Date.parse('2026-11-02T04:00:00.000Z'); // 09:30 IST, a 5-min boundary
/** n 1-min bars, each 10 points high-low, flat closes ⇒ TR = 10 per bar, 5-min bucket TR = 10 too. */
const flat = (n: number, range = 10) => Array.from({ length: n }, (_, k) => ({ ts: T0 + k * 60_000, open: 100, high: 100 + range / 2, low: 100 - range / 2, close: 100 }));

describe('noise units — N1 / N5', () => {
  it('N1 = ATR14 of the 1-min bars; N5 = ATR14 of 5-min buckets with ≥ 15 buckets', () => {
    const n = underlyingNoise(flat(80));
    expect(n).toMatchObject({ n1: 10, n1Method: 'atr14-1m', n5: 10, n5Method: expect.stringMatching(/^atr14-5m/), bars: 80 });
  });
  it('a trending 5-min bucket is wider than its 1-min bars', () => {
    // each minute steps +2: 1-min TR = max(range 2, |gap|) ≈ 2–4; a 5-min bucket spans ~10.
    const up = Array.from({ length: 80 }, (_, k) => ({ ts: T0 + k * 60_000, open: 100 + 2 * k, high: 101 + 2 * k, low: 99 + 2 * k, close: 100 + 2 * k }));
    const n = underlyingNoise(up);
    expect(n.n1).toBe(3);
    expect(n.n5).toBe(11);
  });
  it('too few buckets → N5 = N1 × √5; too few bars → no unit', () => {
    expect(underlyingNoise(flat(30))).toMatchObject({ n1: 10, n5: 22.36, n5Method: 'atr14-1m × √5' });
    expect(underlyingNoise(flat(3))).toMatchObject({ n1: null, n5: null, bars: 3 });
  });
});

describe('stop distance in noise units (via delta)', () => {
  it('NIFTY 23000 CE: plan SL 240 and the cap-sized SL 272.25 in N1 / N5 of the index', () => {
    // price 302.95, |Δ| 0.87 (parity from the PE), N1 6 / N5 14 index points (illustrative units)
    const b = noiseBlock({
      side: 'BUY', price: 302.95, planSl: 240, cap: 2000, lotQty: 65, tick: 0.05,
      delta: { abs: 0.87, source: 'chain-parity (…)' },
      underlying: { n1: 6, n1Method: 'atr14-1m', n5: 14, n5Method: 'atr14-5m', bars: 120, symbol: 'Nifty 50', source: 'candles_1m Nifty 50' },
      premium: null,
    });
    expect(b.stops.cap?.stop).toBe(272.2);
    expect(b.stops.plan).toEqual({ stop: 240, premiumPts: 62.95, underlyingPts: 72.36, inN1: 12.06, inN5: 5.17, inPremiumN1: null });
    expect(b.stops.cap).toEqual({ stop: 272.2, premiumPts: 30.75, underlyingPts: 35.34, inN1: 5.89, inN5: 2.52, inPremiumN1: null });
    expect(b.read).toBe('N1 6 / N5 14 underlying pts; plan SL 240: 62.95 premium pts ≈ 72.36 underlying pts = 5.17×N5 (12.06×N1); cap-sized SL 272.2: 30.75 premium pts ≈ 35.34 underlying pts = 2.52×N5 (5.89×N1); |delta| 0.87 (chain-parity)');
  });
  it('a plan SL inside the cap is its own cap stop; no delta → premium points only', () => {
    const b = noiseBlock({ side: 'SELL', price: 100, planSl: 104, cap: 2000, lotQty: 50, tick: 0.05, delta: null, underlying: { n1: null, n1Method: null, n5: null, n5Method: null, bars: 0, symbol: null, source: 'x' }, premium: { n1: 2, method: 'atr14-1m', bars: 30 } });
    expect(b.stops.cap).toEqual(b.stops.plan);
    expect(b.stops.plan).toEqual({ stop: 104, premiumPts: 4, underlyingPts: null, inN1: null, inN5: null, inPremiumN1: 2 });
    expect(stopDistance({ price: 100, stop: null, absDelta: 1, n1: 1, n5: 1, premiumN1: null })).toBeNull();
  });
});

describe('intrinsic from SPOT, not the future', () => {
  it('NIFTY 23000 CE at 302.95 with spot 23304.9 (fut 23365): 0.64% under spot intrinsic is normal, not stale', () => {
    const v = optionValue({ kind: 'CE', strike: 23000, ltp: 302.95, spot: 23304.9, spotSource: 'chain snapshot spot', future: 23365, daysToExpiry: 1.16 });
    expect(v).toMatchObject({ intrinsicFromSpot: 304.9, timeValue: -1.95, belowIntrinsicPct: 0.64, belowIntrinsicNormal: true, future: 23365 });
    expect(v?.read).toBe('quote 302.95 is 0.64% below spot intrinsic 304.9 — normal for a deep-ITM option near expiry (bid/ask, no carry), NOT a stale quote');
    expect(String(v?.futureIs)).toMatch(/NEVER use it for intrinsic/);
  });
  it('over 1% under intrinsic is flagged; OTM is all time value; non-options / no spot → none', () => {
    expect(optionValue({ kind: 'PE', strike: 500, ltp: 40, spot: 455, spotSource: null, future: null, daysToExpiry: 3 })).toMatchObject({ intrinsicFromSpot: 45, belowIntrinsicNormal: false, read: expect.stringMatching(/check liquidity/) });
    expect(optionValue({ kind: 'CE', strike: 500, ltp: 4, spot: 455, spotSource: null, future: null, daysToExpiry: 3 })?.read).toBe('out of the money: all 4 is time value');
    expect(optionValue({ kind: 'FUT', strike: null, ltp: 4, spot: 455, spotSource: null, future: null, daysToExpiry: 3 })).toBeNull();
  });
  it('the packet facts read the structure spot first; the chain block is labelled in place', () => {
    const market = {
      chain: { status: 'present' as const, source: 'c', value: { spot: 23304.9, fut: 23365 } as Record<string, unknown> },
      market: { status: 'present' as const, source: 'm', value: { vix: 15.65, spot: 23299.65 } },
      structure: { status: 'present' as const, source: 's', value: { spot: 23304.9, spotSource: 'chain' } },
    };
    expect(packetMarketFacts(market)).toEqual({ spot: 23304.9, spotSource: 'structure spot (chain)', future: 23365, vix: 15.65 });
    labelChain(market);
    expect(market.chain.value).toMatchObject({ spotIs: expect.stringMatching(/SPOT/), futIs: expect.stringMatching(/FUTURE/) });
  });
});

describe('channel record: small samples', () => {
  it('the incident row: n 8 / right 0 / wrong 1 is the LAST SESSION; 7 scored over 20 sessions → not evidence', () => {
    const s = channelStatsForJudge({ n: 8, right: 0, wrong: 1, hitRate: 0, rolling20: 0.714, rolling20Right: 5, rolling20Wrong: 2 });
    expect(s).toMatchObject({ sessionScored: 1, scoredCalls: 7, sampleSufficient: false });
    expect(String(s?.read)).toMatch(/NOT evidence/);
  });
  it('8 scored calls suffice; without rolling fields the session counts; no stats → null', () => {
    expect(channelStatsForJudge({ n: 3, right: 1, wrong: 0, rolling20Right: 5, rolling20Wrong: 3 })).toMatchObject({ scoredCalls: 8, sampleSufficient: true });
    expect(channelStatsForJudge({ n: 9, right: 6, wrong: 3 })).toMatchObject({ scoredCalls: 9, scoredCallsBasis: expect.stringMatching(/last session/), sampleSufficient: true });
    expect(channelStatsForJudge(null)).toBeNull();
  });
});

describe('option delta when no greek was read', () => {
  it('Black-Scholes from spot: NIFTY 23000 CE, spot 23304.9, 1.16 d, σ 21% ≈ 0.87 (the parity read was 0.8701)', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(bsAbsDelta({ spot: 23304.9, strike: 23000, kind: 'CE', days: 1.16, iv: 21.17 })).toBeCloseTo(0.87, 2);
    expect(daysToExpiry('2026-11-03', new Date('2026-11-02T06:17:42Z'))).toBeCloseTo(1.15, 2);
  });
  it('the ladder: read greek → parity → heuristic (named, with its σ source); a future is 1:1', () => {
    const now = new Date('2026-11-02T06:17:42Z');
    const base = { kind: 'CE', spot: 23304.9, strike: 23000, expiry: '2026-11-03', now, index: true, vix: 15.65 };
    expect(deltaReading({ ...base, read: 0.9 })).toEqual({ abs: 0.9, source: 'chain' });
    expect(deltaReading({ ...base, otherLegDelta: -0.1299 })?.abs).toBe(0.8701);
    expect(deltaReading(base)?.source).toMatch(/^moneyness-heuristic .*σ 15\.7% = India VIX; not a quote/);
    expect(deltaReading({ ...base, kind: 'FUT' })?.abs).toBe(1);
    expect(deltaReading({ ...base, spot: null })).toBeNull();
  });
});

describe('judge prompt v5', () => {
  it('is stamped and carries the three rules', () => {
    expect(SIGNAL_JUDGE_PROMPT_VERSION).toBe('signal-judge-v6');
    expect(SIGNAL_JUDGE_SYSTEM).toMatch(/never guess "inside noise": market\.noise/);
    expect(SIGNAL_JUDGE_SYSTEM).toMatch(/intrinsic value is from the SPOT .* NEVER the future/);
    expect(SIGNAL_JUDGE_SYSTEM).toMatch(/up to ~1% below spot intrinsic near expiry is NORMAL/);
    expect(SIGNAL_JUDGE_SYSTEM).toMatch(/sampleSufficient is false \(fewer than 8 scored calls\) the record is NOT evidence/);
  });
});
