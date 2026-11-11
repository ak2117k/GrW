import {
  cutLossFromPacket,
  cutLossK15,
  cutLossLevel,
  cutLossLoosen,
  invalidationCap,
  n15FromBars,
  purposeOf,
  type CutLossLevelInput,
} from './cut-loss-yardstick';

/**
 * Prod 2026-11-11 paper BANKNIFTY23NOV2660800CE (long call, wants UP): best underlying 60791.95, N1 41.8,
 * K 2, thesis invalidation 59741.25; N15 at 09:53 IST ≈ 107.71 (candles_1m rolled to 15m). The AI's 60708
 * is exactly K·N1 below best; the yardstick puts it at 60791.95 − 1.5 × 107.71 = 60630.38.
 */
const BNF: CutLossLevelInput = {
  instrument: 'UNDERLYING', op: 'BELOW', price: 60708, exposure: 'BULLISH', purpose: 'CUT_LOSS',
  floorArmUnderlying: null, bestUnderlying: 60791.95, underlyingNow: 60774, n1: 41.8, k: 2, n15: 107.71, k15: 1.5, invalidation: 59741.25,
};

describe('cutLossK15 (TRIGGER_CUT_LOSS_N15)', () => {
  it('defaults to 1.5; 0/off turns it off; junk or out of range falls back', () => {
    expect(cutLossK15({})).toBe(1.5);
    expect(cutLossK15({ TRIGGER_CUT_LOSS_N15: '2' })).toBe(2);
    expect(cutLossK15({ TRIGGER_CUT_LOSS_N15: 'off' })).toBeNull();
    expect(cutLossK15({ TRIGGER_CUT_LOSS_N15: '0' })).toBeNull();
    expect(cutLossK15({ TRIGGER_CUT_LOSS_N15: 'x' })).toBe(1.5);
    expect(cutLossK15({ TRIGGER_CUT_LOSS_N15: '9' })).toBe(1.5);
  });
});

describe('purposeOf (trigger-check purpose)', () => {
  it('green or an armed floor protects profit; flat/red/unknown cuts a loss', () => {
    expect(purposeOf(10, false)).toBe('PROTECT_PROFIT');
    expect(purposeOf(-10, true)).toBe('PROTECT_PROFIT');
    expect(purposeOf(-10, false)).toBe('CUT_LOSS');
    expect(purposeOf(null, false)).toBe('CUT_LOSS');
  });
});

describe('n15FromBars', () => {
  // 2026-11-11 IST session bars start 09:15 IST = 03:45 UTC.
  const at = (ist: string) => Date.parse(`2026-11-11T${ist}:00+05:30`);
  const bar = (ist: string, high: number, low: number, close = (high + low) / 2, open = close) => ({ ts: at(ist), open, high, low, close });

  it('ATR14 of the last 14 closed session bars; the previous close counts within a day', () => {
    const bars = Array.from({ length: 16 }, (_, i) => {
      const m = 555 + i * 15;
      const hh = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      return bar(`${hh}:${mm}`, 110, 100, 105);
    });
    const r = n15FromBars(bars, 'NSE', at('13:45'));
    expect(r).toMatchObject({ n: 10, bars: 14, method: 'atr14-15m' });
  });

  it('drops the NSE pre-open bucket and the bar still forming; the overnight gap is not a 15-minute swing', () => {
    const bars = [
      { ts: Date.parse('2026-11-10T15:00:00+05:30'), open: 100, high: 110, low: 100, close: 105 },
      { ts: Date.parse('2026-11-10T15:15:00+05:30'), open: 100, high: 110, low: 100, close: 105 },
      bar('09:00', 2000, 100), // pre-open: dropped
      bar('09:15', 510, 500, 505), // gap from 105: H−L only = 10
      bar('09:30', 515, 505, 510),
      bar('09:45', 520, 510, 515),
      bar('10:00', 900, 100), // still forming at 10:05: dropped
    ];
    const r = n15FromBars(bars, 'NSE', at('10:05'));
    expect(r).toMatchObject({ n: 10, bars: 5, method: 'mean-tr-15m' });
  });

  it('fewer than 5 closed bars ⇒ null; junk bars are ignored', () => {
    expect(n15FromBars([bar('09:15', 110, 100), bar('09:30', 110, 100)], 'NSE', at('12:00'))).toBeNull();
    expect(n15FromBars([{ ts: NaN, open: 1, high: 1, low: 1, close: 1 }], 'NSE', at('12:00'))).toBeNull();
  });

  it('MCX keeps evening bars (09:00–23:55)', () => {
    const bars = ['19:00', '19:15', '19:30', '19:45', '20:00'].map((t) => bar(t, 141300, 141100, 141200));
    expect(n15FromBars(bars, 'MCX', at('20:30'))).toMatchObject({ n: 200, bars: 5 });
  });
});

describe('cutLossLevel', () => {
  it('BANKNIFTY 2026-11-11: the AI sat on K·N1 (84 pts); the minimum is 1.5 N15 (161.6 pts) from the best point', () => {
    expect(cutLossLevel(BNF)).toEqual({
      applies: true, skip: null, price: 60630.38, widenedFrom: 60708, ref: 60791.95, refSource: 'BEST',
      gapN1: 83.6, gapN15: 161.57, minDistance: 161.57, minLevel: 60630.38, invalidation: 59741.25, cappedByInvalidation: false,
    });
  });

  it('a level already wider than the minimum is left alone', () => {
    expect(cutLossLevel({ ...BNF, price: 60500 })).toMatchObject({ price: 60500, widenedFrom: null, applies: true });
  });

  it('never past the invalidation: a closer invalidation IS the level', () => {
    expect(cutLossLevel({ ...BNF, invalidation: 60700 })).toMatchObject({ price: 60700, widenedFrom: 60708, cappedByInvalidation: true });
    // A proposal already at/over the invalidation is unchanged.
    expect(cutLossLevel({ ...BNF, price: 60690, invalidation: 60700 })).toMatchObject({ price: 60690, widenedFrom: null, cappedByInvalidation: false });
  });

  it('an invalidation on the wrong side of the reference is ignored', () => {
    expect(cutLossLevel({ ...BNF, invalidation: 60900 })).toMatchObject({ price: 60630.38, invalidation: null });
  });

  it('the reference is the floor arm, else best, else now — as widenExitTrigger', () => {
    expect(cutLossLevel({ ...BNF, floorArmUnderlying: 60800 })).toMatchObject({ refSource: 'FLOOR_ARM', ref: 60800 });
    expect(cutLossLevel({ ...BNF, bestUnderlying: null })).toMatchObject({ refSource: 'NOW', ref: 60774, price: 60612.43 });
  });

  it('no N15 (off, or no bars) ⇒ K × N1 alone, today\'s rule', () => {
    // 60708 is already 0.35 past K·N1 (60708.35): unchanged, exactly as widenExitTrigger left it.
    expect(cutLossLevel({ ...BNF, n15: null })).toMatchObject({ gapN15: null, minDistance: 83.6, minLevel: 60708.35, price: 60708, widenedFrom: null });
    expect(cutLossLevel({ ...BNF, n15: null, price: 60750 })).toMatchObject({ price: 60708.35, widenedFrom: 60750 });
    expect(cutLossLevel({ ...BNF, k15: null })).toMatchObject({ gapN15: null, minDistance: 83.6 });
  });

  it('a short / bearish exposure mirrors: ABOVE, ref + gap (GOLD 141000 PE 2026-11-10)', () => {
    const gold = cutLossLevel({
      instrument: 'UNDERLYING', op: 'ABOVE', price: 141150, exposure: 'BEARISH', purpose: 'CUT_LOSS', floorArmUnderlying: null,
      bestUnderlying: 141018, underlyingNow: 140989, n1: 57.93, k: 2, n15: 326.21, k15: 1.5, invalidation: 141860,
    });
    expect(gold).toMatchObject({ price: 141507.31, widenedFrom: 141150, minDistance: 489.31 });
  });

  it.each([
    ['PREMIUM', { instrument: 'PREMIUM' as const }, 'NOT_UNDERLYING'],
    ['PROTECT_PROFIT', { purpose: 'PROTECT_PROFIT' as const }, 'PROTECT_PROFIT'],
    ['not protective', { op: 'ABOVE' as const }, 'NOT_PROTECTIVE'],
    ['no exposure', { exposure: null }, 'NO_EXPOSURE'],
    ['no reference', { bestUnderlying: null, underlyingNow: null }, 'NO_REFERENCE'],
    ['no noise unit', { n1: null, n15: null }, 'NO_NOISE_UNIT'],
  ])('%s ⇒ unchanged', (_l, over, skip) => {
    const r = cutLossLevel({ ...BNF, ...over });
    expect(r).toMatchObject({ applies: false, skip, price: 60708, widenedFrom: null });
  });
});

describe('cutLossLoosen — the ratchet exception', () => {
  const level = cutLossLevel({ ...BNF, price: 59741.25 });
  const base = {
    armed: { instrument: 'UNDERLYING', op: 'BELOW', price: 60708, tight: true },
    proposal: { instrument: 'UNDERLYING', op: 'BELOW', price: 59741.25 },
    level, thesisStatus: 'INTACT',
  };

  it('BANKNIFTY 10:13 IST: a tight armed level, thesis INTACT, new level at the invalidation ⇒ allowed', () => {
    expect(cutLossLoosen(base)).toEqual({ allow: true, why: 'ARMED_TIGHT' });
  });

  it('an armed level inside the minimum counts as tight even when its check did not say so', () => {
    expect(cutLossLoosen({ ...base, armed: { ...base.armed, tight: null } })).toEqual({ allow: true, why: 'ARMED_INSIDE_MIN' });
    expect(cutLossLoosen({ ...base, armed: { ...base.armed, price: 60600, tight: false } })).toEqual({ allow: false, why: 'ARMED_NOT_TIGHT' });
  });

  it('thesis not INTACT ⇒ tighten-only (the 09:56 WEAKENING widening stays refused)', () => {
    expect(cutLossLoosen({ ...base, thesisStatus: 'WEAKENING' })).toEqual({ allow: false, why: 'THESIS_WEAKENING' });
  });

  it('no status column: the verdict text may say the thesis is intact', () => {
    expect(cutLossLoosen({ ...base, thesisStatus: null, reasonText: 'Dip held, thesis remains intact.' }).allow).toBe(true);
    expect(cutLossLoosen({ ...base, thesisStatus: null, reasonText: 'weakening' }).allow).toBe(false);
  });

  it('never past the invalidation; without one, never past the widened minimum', () => {
    const past = cutLossLevel({ ...BNF, price: 59700 });
    expect(cutLossLoosen({ ...base, proposal: { ...base.proposal, price: 59700 }, level: past })).toEqual({ allow: false, why: 'BEYOND_BOUND' });
    const noInv = cutLossLevel({ ...BNF, price: 60500, invalidation: null });
    expect(cutLossLoosen({ ...base, proposal: { ...base.proposal, price: 60500 }, level: noInv })).toEqual({ allow: false, why: 'BEYOND_BOUND' });
    const atMin = cutLossLevel({ ...BNF, invalidation: null });
    expect(cutLossLoosen({ ...base, proposal: { ...base.proposal, price: atMin.price }, level: atMin }).allow).toBe(true);
  });

  it('PROTECT_PROFIT, an instrument or side switch, or a tightening are not this rule\'s business', () => {
    const pp = cutLossLevel({ ...BNF, purpose: 'PROTECT_PROFIT', price: 59741.25 });
    expect(cutLossLoosen({ ...base, level: pp }).allow).toBe(false);
    expect(cutLossLoosen({ ...base, armed: { ...base.armed, instrument: 'PREMIUM' } }).why).toBe('NOT_SAME_UNDERLYING_SIDE');
    expect(cutLossLoosen({ ...base, proposal: { ...base.proposal, price: 60750 } }).why).toBe('NOT_LOOSER');
  });
});

describe('invalidationCap', () => {
  it('the packet thesis first, when on the adverse side and on scale', () => {
    expect(invalidationCap({ thesisInvalidation: 59741.25, text: 'below 60708', triggerPrice: 60708, ref: 60791.95, exposure: 'BULLISH' }))
      .toEqual({ value: 59741.25, source: 'PACKET_THESIS' });
  });

  it('else the furthest adverse number in the text, never the trigger itself (trigger-check reads the first number)', () => {
    const text = 'Underlying trading below 60708 — two noise units (2 x 41.8) below the best of 60791.95 — or any break of 59741.25';
    expect(invalidationCap({ thesisInvalidation: null, text, triggerPrice: 60708, ref: 60791.95, exposure: 'BULLISH' }))
      .toEqual({ value: 59741.25, source: 'VERDICT_TEXT' });
    expect(invalidationCap({ thesisInvalidation: null, text: 'below 82308 — two noise units below 82380.18', triggerPrice: 82308, ref: 82380.18, exposure: 'BULLISH' }))
      .toEqual({ value: null, source: null });
  });

  it('bearish: the highest adverse number; off-scale numbers are skipped', () => {
    expect(invalidationCap({ thesisInvalidation: 120000, text: 'reclaims VWAP 141724.77, beyond it ORL 141860, 15m close', triggerPrice: 141724.77, ref: 141018, exposure: 'BEARISH' }))
      .toEqual({ value: 141860, source: 'VERDICT_TEXT' });
  });
});

describe('cutLossFromPacket', () => {
  const block = (value: unknown) => ({ available: true, value, source: 's', at: 'a' });
  const packet = {
    position: { symbol: 'BANKNIFTY23NOV2660800CE', side: 'LONG', qty: 30, entryPrice: 745.37, ltp: 730, underlyingLtp: block(60776.8) },
    money: { netPnl: -402.4, charges: 60, greenFloorPrice: null, greenFloorArmed: false,
      anchors: { best: { ltp: 760, underlying: 60791.95, at: 'x' }, floorArm: null, hardExitN: 2 } },
    thesis: block({ invalidation: 59741.25 }),
    flow: { noiseUnit: block({ contract: null, underlying: { n: 41.8, method: 'atr14-1m', bars: 60, at: 'x' } }) },
  };
  const n15 = { n: 107.71, bars: 14, method: 'atr14-15m' as const, at: 'x' };
  const call = (o: Partial<Parameters<typeof cutLossFromPacket>[0]> = {}) => cutLossFromPacket({
    instrument: 'UNDERLYING', op: 'BELOW', price: 60708, packet, invalidationPoint: 'Underlying trading below 60708', netPnl: -402.4,
    underlyingNow: 60776.8, n15, k15: 1.5, thesisStatus: 'INTACT', armed: null, acted: true, ...o,
  });

  it('the level to arm and its record', () => {
    expect(call()).toMatchObject({
      wouldArmAt: 60630.38, n15: 107.71, n15Bars: 14, k15: 1.5, wouldAllowLoosen: null, loosenWhy: null, acted: true,
      cutLoss: { applies: true, widenedFrom: 60708, invalidation: 59741.25, gapN1: 83.6 },
    });
  });

  it('a loosening against an armed tight level is judged; a tightening is not (null)', () => {
    expect(call({ price: 59741.25, armed: { instrument: 'UNDERLYING', op: 'BELOW', price: 60708, tight: true } }))
      .toMatchObject({ wouldArmAt: 59741.25, wouldAllowLoosen: true, loosenWhy: 'ARMED_TIGHT' });
    expect(call({ price: 59741.25, thesisStatus: 'WEAKENING', armed: { instrument: 'UNDERLYING', op: 'BELOW', price: 60708, tight: true } }))
      .toMatchObject({ wouldAllowLoosen: false, loosenWhy: 'THESIS_WEAKENING' });
    expect(call({ armed: { instrument: 'UNDERLYING', op: 'BELOW', price: 60500, tight: false } })).toMatchObject({ wouldAllowLoosen: null });
  });

  it('green ⇒ PROTECT_PROFIT: unchanged; no hardExitN on the packet ⇒ K 2', () => {
    expect(call({ netPnl: 50 })).toMatchObject({ wouldArmAt: 60708, cutLoss: { applies: false, skip: 'PROTECT_PROFIT' } });
    const noK = { ...packet, money: { ...packet.money, anchors: { ...packet.money.anchors, hardExitN: undefined } } };
    expect(call({ packet: noK, n15: null })).toMatchObject({ cutLoss: { gapN1: 83.6 } });
  });

  it('an unreadable packet ⇒ null (the caller arms the proposal unchanged)', () => {
    expect(call({ packet: 'junk' })).toBeNull();
    expect(call({ packet: null })).toBeNull();
  });
});
