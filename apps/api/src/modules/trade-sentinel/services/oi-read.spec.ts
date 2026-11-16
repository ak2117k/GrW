import {
  classifyBuildUp,
  isStaleChain,
  oiRead,
  oiUnitsOf,
  wallTrend,
  type ChainSnap,
  type ChainStrike,
} from './oi-read';

const leg = (oi: number, ltp: number, oiChange: number | null = null) => ({ oi, ltp, oiChange });
const strike = (k: number, ce: ReturnType<typeof leg> | null, pe: ReturnType<typeof leg> | null): ChainStrike => ({
  strikePrice: k,
  ceData: ce,
  peData: pe,
});
const snap = (at: string, strikes: ChainStrike[], over: Partial<ChainSnap> = {}): ChainSnap => ({
  capturedAt: new Date(at),
  expiry: '2026-11-18',
  source: 'NSE',
  spot: 13.4,
  strikes,
  ...over,
});

// A small stock-option chain around spot 13.4 (strikes 10..16).
const baseline = snap('2026-11-13T09:59:00.000Z', [
  strike(10, leg(100, 3.4), leg(900, 0.05)),
  strike(11, leg(200, 2.5), leg(2000, 0.1)),
  strike(12, leg(400, 1.6), leg(2765, 0.3)),
  strike(13, leg(1000, 0.9), leg(1500, 0.6)),
  strike(14, leg(6100, 0.4), leg(300, 1.2)),
  strike(15, leg(3000, 0.2), leg(100, 2.0)),
  strike(16, leg(2500, 0.1), leg(50, 2.9)),
]);
const latest = snap('2026-11-16T05:30:00.000Z', [
  strike(10, leg(100, 3.5), leg(900, 0.05)),
  strike(11, leg(200, 2.6), leg(2000, 0.08)),
  strike(12, leg(400, 1.7), leg(3165, 0.25)), // puts +400, put premium down = writing
  strike(13, leg(2200, 0.8), leg(1188, 0.5)), // calls +1200, puts -312: flip to resistance
  strike(14, leg(6188, 0.3), leg(300, 1.1)), // calls +88 = steady (<5%)
  strike(15, leg(1200, 0.1), leg(100, 1.9)), // calls -1800, premium down = long unwinding
  strike(16, leg(2500, 0.05), leg(50, 2.8)),
]);

describe('oi-read helpers', () => {
  it('classifies build-up by OI change × premium change, FLAT under 2% of OI', () => {
    expect(classifyBuildUp(1100, 100, 0.5)).toBe('LONG_BUILDUP');
    expect(classifyBuildUp(1100, 100, -0.5)).toBe('SHORT_BUILDUP');
    expect(classifyBuildUp(900, -100, 0.5)).toBe('SHORT_COVERING');
    expect(classifyBuildUp(900, -100, -0.5)).toBe('LONG_UNWINDING');
    expect(classifyBuildUp(1000, 19, 0.5)).toBe('FLAT');
    expect(classifyBuildUp(1000, -19, -0.5)).toBe('FLAT');
  });

  it('leaves build-up null when the OI change or the premium change is unknown', () => {
    expect(classifyBuildUp(1000, null, 0.5)).toBeNull();
    expect(classifyBuildUp(1100, 100, null)).toBeNull();
  });

  it('wall trend: BUILT / ABANDONED beyond 5%, STEADY inside, UNKNOWN without a change', () => {
    expect(wallTrend(1100, 100)).toBe('BUILT');
    expect(wallTrend(900, -100)).toBe('ABANDONED');
    expect(wallTrend(1000, 40)).toBe('STEADY');
    expect(wallTrend(1000, null)).toBe('UNKNOWN');
  });

  it('names units by source and never guesses', () => {
    expect(oiUnitsOf('NSE')).toBe('contracts');
    expect(oiUnitsOf('HUB')).toBe('shares');
    expect(oiUnitsOf('ANGEL_ONE')).toBe('shares');
    expect(oiUnitsOf('ANGEL_ONE_WS')).toBe('shares');
    expect(oiUnitsOf('DB_INSTRUMENTS')).toBe('unknown');
  });

  it('treats an all-zero-LTP chain (pre-open, yesterday\'s OI) and an empty chain as stale', () => {
    expect(isStaleChain([strike(10, leg(500, 0), leg(700, 0))])).toBe(true);
    expect(isStaleChain([])).toBe(true);
    expect(isStaleChain([strike(10, leg(500, 0), leg(700, 0.1))])).toBe(false);
  });
});

describe('oiRead', () => {
  it('returns null for a stale latest snapshot', () => {
    const stale = snap('2026-11-16T03:40:00.000Z', [strike(13, leg(1000, 0), leg(1500, 0))]);
    expect(oiRead(stale, baseline, 13.4)).toBeNull();
  });

  it('returns null without any spot (walls cannot be sided)', () => {
    expect(oiRead({ ...latest, spot: null }, baseline, 0)).toBeNull();
  });

  it('computes change vs the previous-session baseline, with premium change and build-up', () => {
    const r = oiRead(latest, baseline, 13.4)!;
    expect(r.changeBasis).toBe('baseline');
    expect(r.baselineAsOf).toBe('2026-11-13T09:59:00.000Z');
    expect(r.asOf).toBe('2026-11-16T05:30:00.000Z');
    expect(r.units).toBe('contracts');
    const s12 = r.strikes.find((s) => s.strike === 12)!;
    expect(s12.putOiChg).toBe(400);
    expect(s12.putLtpChg).toBe(-0.05);
    expect(s12.putBuildUp).toBe('SHORT_BUILDUP');
    const s15 = r.strikes.find((s) => s.strike === 15)!;
    expect(s15.callOiChg).toBe(-1800);
    expect(s15.callBuildUp).toBe('LONG_UNWINDING');
    const s14 = r.strikes.find((s) => s.strike === 14)!;
    expect(s14.callBuildUp).toBe('FLAT'); // +88 on 6188 < 2%
  });

  it('picks the top-2 call-OI strikes above spot as resistance and top-2 put-OI below as support', () => {
    const r = oiRead(latest, baseline, 13.4)!;
    expect(r.resistance.map((w) => w.strike)).toEqual([14, 16]);
    expect(r.resistance[0]).toEqual({ strike: 14, oi: 6188, oiChg: 88, trend: 'STEADY' });
    // 13 has the biggest call OI below 14 but is BELOW spot — never resistance.
    expect(r.resistance.some((w) => w.strike === 13)).toBe(false);
    expect(r.support.map((w) => w.strike)).toEqual([12, 11]);
    expect(r.support[0]).toEqual({ strike: 12, oi: 3165, oiChg: 400, trend: 'BUILT' });
    expect(r.zone).toEqual({ support: 12, resistance: 14, widthPct: 14.93, spotPositionPct: 70 });
  });

  it('totals and PCR (put/call OI) with change vs the baseline PCR', () => {
    const r = oiRead(latest, baseline, 13.4)!;
    expect(r.totals.callOi).toBe(12788);
    expect(r.totals.putOi).toBe(7703);
    expect(r.totals.callOiChg).toBe(12788 - 13300);
    expect(r.totals.putOiChg).toBe(7703 - 7615);
    expect(r.totals.pcr).toBe(0.6);
    expect(r.totals.pcrChange).toBe(Math.round((0.6 - 7615 / 13300) * 100) / 100);
  });

  it('writes a plain read naming walls, the flip strike, flow and PCR', () => {
    const r = oiRead(latest, baseline, 13.4)!;
    expect(r.read).toContain('Resistance 14 (6,188, steady), then 16 (2,500, steady).');
    expect(r.read).toContain('13 turning into resistance (calls +1,200, puts −312 — put writers left).');
    expect(r.read).toContain('Support 12 (3,165, built +400)');
    expect(r.read).toMatch(/Total call OI −512 with near-spot call prices down = long unwinding, not fresh writing\./);
    expect(r.read).toContain('PCR 0.60');
    expect(r.read).toContain('OI in contracts; changes vs last session close');
  });

  it('falls back to the chain\'s own oiChange without a baseline (no premium change → build-up null)', () => {
    const chainOnly = snap('2026-11-16T05:30:00.000Z', [
      strike(12, leg(400, 1.7, 0), leg(3165, 0.25, 400)),
      strike(14, leg(6188, 0.3, -900), leg(300, 1.1, 0)),
    ]);
    const r = oiRead(chainOnly, null, 13.4)!;
    expect(r.changeBasis).toBe('chain');
    expect(r.baselineAsOf).toBeNull();
    expect(r.support[0]).toMatchObject({ strike: 12, oiChg: 400, trend: 'BUILT' });
    expect(r.resistance[0]).toMatchObject({ strike: 14, oiChg: -900, trend: 'ABANDONED' });
    const s14 = r.strikes.find((s) => s.strike === 14)!;
    expect(s14.callLtpChg).toBeNull();
    expect(s14.callBuildUp).toBeNull();
    expect(r.read).toContain("chain's own OI change");
  });

  it('reports no change at all when neither a baseline nor chain oiChange exists', () => {
    const bare = snap('2026-11-16T05:30:00.000Z', [
      { strikePrice: 12, ceData: { oi: 400, ltp: 1.7 }, peData: { oi: 3165, ltp: 0.25 } },
      { strikePrice: 14, ceData: { oi: 6188, ltp: 0.3 }, peData: { oi: 300, ltp: 1.1 } },
    ]);
    const r = oiRead(bare, null, 13.4)!;
    expect(r.changeBasis).toBe('none');
    expect(r.totals.callOiChg).toBeNull();
    expect(r.resistance[0].trend).toBe('UNKNOWN');
    expect(r.read).toContain('no OI change available');
  });

  it('ignores a stale baseline and falls back to the chain change', () => {
    const staleBase = snap('2026-11-13T03:40:00.000Z', [strike(12, leg(1, 0), leg(1, 0))]);
    const r = oiRead(latest, staleBase, 13.4)!;
    expect(r.changeBasis).not.toBe('baseline');
    expect(r.baselineAsOf).toBeNull();
  });

  it('never mixes units: a baseline from a different source is dropped', () => {
    const hubBase = { ...baseline, source: 'HUB' };
    const r = oiRead(latest, hubBase, 13.4)!;
    expect(r.baselineAsOf).toBeNull();
    expect(r.changeBasis).not.toBe('baseline');
  });

  it('limits the strike window to 6 each side of spot', () => {
    const many = snap(
      '2026-11-16T05:30:00.000Z',
      Array.from({ length: 30 }, (_, i) => strike(100 + i * 10, leg(1000 + i, 1), leg(1000 - i, 1))),
      { spot: 245 },
    );
    const r = oiRead(many, null, 245)!;
    expect(r.strikes).toHaveLength(12);
    expect(r.strikes[0].strike).toBe(190);
    expect(r.strikes[11].strike).toBe(300);
  });
});
