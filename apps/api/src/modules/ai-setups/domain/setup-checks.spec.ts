import { checkSetup, packetLevels, setupCeilingFor, DEFAULT_SETUP_CEILING_RUPEES, type SetupCheckContext } from './setup-checks';
import type { SetupReply, SetupPlan } from './setup.types';

/**
 * The DABUR worked example (spec §1, 2026-11-25 14:18 IST): broke its 60-day high 403, LTP 431.3; buy the
 * Dec 430 CE on a pullback to 424–426 (13:00 support 425), SL 419.5, targets 433.5 / 440. The packet holds
 * every number the setup cites.
 */
const PACKET = {
  quote: {
    status: 'present',
    source: 'market-quote-resolver',
    value: {
      ltp: 431.3,
      open: 405.2,
      dayHigh: 433.6,
      dayLow: 404.8,
      prevHigh: 403,
      prevClose: 399.4,
      volume: 8_400_000,
      avgVolume20d: 1_200_000,
      // last 8 closed 15m bars: swing low 425 (12:30, the "13:00 support"), swing high 432.9 (13:30)
      bars15m: [
        { at: '12:00', open: 428, high: 430, low: 426.5, close: 427 },
        { at: '12:15', open: 427, high: 428, low: 425.6, close: 426 },
        { at: '12:30', open: 426, high: 427.2, low: 425, close: 427 },
        { at: '12:45', open: 427, high: 429, low: 425.8, close: 428.7 },
        { at: '13:00', open: 428.7, high: 431, low: 427.9, close: 430.6 },
        { at: '13:15', open: 430.6, high: 432.4, low: 429.5, close: 431.8 },
        { at: '13:30', open: 431.8, high: 432.9, low: 430.1, close: 431.2 },
        { at: '13:45', open: 431.2, high: 432.1, low: 430.4, close: 431.3 },
      ],
    },
  },
  daily60: { status: 'present', source: 'owner daily bars', value: { high60d: 403, atr14: 11.2 } },
  bars15m: { status: 'present', source: 'owner 15m bars', value: { atr15m: 3, vwap: 424.8 } },
  chain: { status: 'present', source: 'option chain', value: { expiry: '2026-12-29', strikes: [{ strike: 430, type: 'CE', ltp: 9.8, oi: 1480, spreadPct: 1.2 }] } },
  news60m: { status: 'unavailable', source: 'news', reason: 'no news in the last 60 min' },
};

const DABUR_SETUP: SetupPlan = {
  instrument: { kind: 'OPT', symbol: 'DABUR', strike: 430, optionType: 'CE', expiry: '2026-12-29' },
  side: 'BUY',
  entry: { type: 'LIMIT_PULLBACK', low: 424, high: 426, trigger: null, level: 425 },
  sl: 419.5,
  targets: [433.5, 440],
  validUntil: '15:15',
  confidence: 62,
  evidence: [
    { fact: '60-day high broken at the open', value: '403', source: 'daily60' },
    { fact: 'LTP', value: '431.3', source: 'quote' },
    { fact: '13:00 support (15m swing low)', value: '425', source: 'quote' },
    { fact: 'volume vs 20d average', value: '8,400,000', source: 'quote' },
  ],
};

const reply = (setup: Partial<SetupPlan> = {}): SetupReply => ({
  decision: 'SETUP',
  reason: 'breakout real but late: buy the pullback to 13:00 support',
  setup: { ...DABUR_SETUP, ...setup },
});

/** DABUR: 15m ATR ~3, ATM-ish delta 0.5, lot 1250, ₹3,000 stock-option ceiling, spread 1.2 %, OI 1480 contracts. */
const ctx = (over: Partial<SetupCheckContext> = {}): SetupCheckContext => ({
  packet: PACKET,
  ltpUnderlying: 431.3,
  atr15m: 3,
  delta: 0.5,
  lotSize: 1250,
  ceiling: 3000,
  spreadPct: 1.2,
  oi: 1480,
  minOi: 500,
  exchange: 'NFO',
  ...over,
});

describe('checkSetup — the DABUR worked example', () => {
  it('passes every check except the loss ceiling: as given (lot 1250) it is sl_too_wide against ₹3,000', () => {
    // Pullback zone 424–426 sits below LTP 431.3 (no chase). R:R to T1 from the zone mid 425:
    // (433.5 − 425) / (425 − 419.5) = 8.5 / 5.5 = 1.55 ≥ 1.2.
    // SL fits the ceiling? Worst fill in the zone is its top 426 (a bull pullback fills coming down):
    // (426 − 419.5) × |0.5| × 1250 = 6.5 × 0.5 × 1250 = ₹4,062.5 > ₹3,000  ⇒  sl_too_wide.
    const r = checkSetup(reply(), ctx());
    expect(r).toEqual({ ok: false, failed: 'sl_too_wide', detail: expect.stringContaining('4062.5') });
  });

  it('passes all checks when the ceiling covers ₹4,062.5 (e.g. the ₹5,000 STOCK_OPT example table)', () => {
    expect(checkSetup(reply(), ctx({ ceiling: 5000 }))).toEqual({ ok: true });
  });

  it('the breakout alternative (15m close above 433.6 → trigger 434, SL 427, T 445) passes anti-chase and R:R', () => {
    // |434 − 433.6| = 0.4 ≤ 1.5 × 3 = 4.5; R:R (445 − 434) / (434 − 427) = 11 / 7 = 1.57.
    // ₹ risk (434 − 427) × 0.5 × 1250 = ₹4,375: fits ₹5,000, not ₹3,000.
    const breakout = reply({ entry: { type: 'BREAKOUT_TRIGGER', low: 434, high: 434, trigger: 434, level: 433.6 }, sl: 427, targets: [445, 450] });
    expect(checkSetup(breakout, ctx({ ceiling: 5000 }))).toEqual({ ok: true });
    expect(checkSetup(breakout, ctx({ ceiling: 3000 }))).toMatchObject({ ok: false, failed: 'sl_too_wide' });
  });
});

describe('checkSetup — each check', () => {
  const OK = ctx({ ceiling: 10_000 });

  it('NO_TRADE has nothing to veto', () => {
    expect(checkSetup({ decision: 'NO_TRADE', reason: 'move is stale', setup: null }, OK)).toEqual({ ok: true });
  });

  it('a SETUP with no setup body is malformed', () => {
    expect(checkSetup({ decision: 'SETUP', reason: 'x', setup: null }, OK)).toMatchObject({ ok: false, failed: 'malformed' });
  });

  it('only option BUYS (v1)', () => {
    expect(checkSetup(reply({ side: 'SELL' as never }), OK)).toMatchObject({ ok: false, failed: 'not_option_buy' });
    expect(checkSetup(reply({ instrument: { ...DABUR_SETUP.instrument, kind: 'FUT' as never } }), OK)).toMatchObject({ ok: false, failed: 'not_option_buy' });
  });

  it('chase: a breakout trigger 1.6 × ATR from the cited level fails anti_chase', () => {
    // 433.6 + 1.6 × 3 = 438.4
    const chase = reply({ entry: { type: 'BREAKOUT_TRIGGER', low: 438.4, high: 438.4, trigger: 438.4, level: 433.6 }, sl: 433, targets: [446] });
    expect(checkSetup(chase, OK)).toMatchObject({ ok: false, failed: 'anti_chase' });
  });

  it('chase: MARKET_NOW at LTP 431.3 cited off 425 (2.1 × ATR) fails anti_chase; off the day high 433.6 (0.77 × ATR) passes', () => {
    const now = reply({ entry: { type: 'MARKET_NOW', low: 431.3, high: 431.3, trigger: null, level: 425 }, sl: 424, targets: [441] });
    expect(checkSetup(now, OK)).toMatchObject({ ok: false, failed: 'anti_chase' });
    const near = reply({ entry: { type: 'MARKET_NOW', low: 431.3, high: 431.3, trigger: null, level: 433.6 }, sl: 425, targets: [440] });
    expect(checkSetup(near, OK)).toEqual({ ok: true });
  });

  it('a breakout / market-now entry must cite a level, and the level must be a packet level', () => {
    const noLevel = reply({ entry: { type: 'BREAKOUT_TRIGGER', low: 434, high: 434, trigger: 434, level: null }, sl: 427, targets: [445] });
    expect(checkSetup(noLevel, OK)).toMatchObject({ ok: false, failed: 'level_not_a_level' });
    const invented = reply({ entry: { type: 'BREAKOUT_TRIGGER', low: 434, high: 434, trigger: 434, level: 433.1 }, sl: 427, targets: [445] });
    expect(checkSetup(invented, OK)).toMatchObject({ ok: false, failed: 'level_not_a_level' });
  });

  it('anti-chase cannot be beaten by citing a non-level packet number: LTP, strike, volume all fail', () => {
    const now = (level: number) => reply({ entry: { type: 'MARKET_NOW', low: 431.3, high: 431.3, trigger: null, level }, sl: 425, targets: [440] });
    expect(checkSetup(now(431.3), OK)).toMatchObject({ ok: false, failed: 'level_not_a_level', detail: expect.stringContaining('431.3') }); // LTP
    expect(checkSetup(now(430), OK)).toMatchObject({ ok: false, failed: 'level_not_a_level' }); // the strike
    expect(checkSetup(now(8_400_000), OK)).toMatchObject({ ok: false, failed: 'level_not_a_level' }); // volume
    expect(checkSetup(now(1480), OK)).toMatchObject({ ok: false, failed: 'level_not_a_level' }); // OI
    expect(checkSetup(now(405.2), OK)).toMatchObject({ ok: false, failed: 'level_not_a_level' }); // open is not a level
  });

  it('prevHigh and a 15m swing high are levels', () => {
    // pullback anchored to prevHigh 403 (the broken 60-day high)
    const prevHigh = reply({ entry: { type: 'LIMIT_PULLBACK', low: 424, high: 426, trigger: null, level: 403 } });
    expect(checkSetup(prevHigh, OK)).toEqual({ ok: true });
    // breakout over the 13:30 swing high 432.9: |434 − 432.9| = 1.1 ≤ 4.5
    const swing = reply({ entry: { type: 'BREAKOUT_TRIGGER', low: 434, high: 434, trigger: 434, level: 432.9 }, sl: 427, targets: [445] });
    expect(checkSetup(swing, OK)).toEqual({ ok: true });
  });

  it('a pullback that cites a level must cite a packet level too', () => {
    const r = reply({ entry: { type: 'LIMIT_PULLBACK', low: 424, high: 426, trigger: null, level: 425.5 } });
    expect(checkSetup(r, OK)).toMatchObject({ ok: false, failed: 'level_not_a_level' });
  });

  it('a breakout entry needs its trigger', () => {
    const r = reply({ entry: { type: 'BREAKOUT_TRIGGER', low: 434, high: 434, trigger: null, level: 433.6 }, sl: 427, targets: [445] });
    expect(checkSetup(r, OK)).toMatchObject({ ok: false, failed: 'malformed' });
  });

  it('an inverted entry zone is malformed', () => {
    const r = reply({ entry: { type: 'LIMIT_PULLBACK', low: 426, high: 424, trigger: null, level: 425 } });
    expect(checkSetup(r, OK)).toMatchObject({ ok: false, failed: 'malformed' });
  });

  it('a CE pullback zone must sit below the current price', () => {
    const r = reply({ entry: { type: 'LIMIT_PULLBACK', low: 430, high: 432, trigger: null, level: null }, sl: 426, targets: [440] });
    expect(checkSetup(r, OK)).toMatchObject({ ok: false, failed: 'pullback_wrong_side' });
  });

  it('R:R 1.1 to T1 fails', () => {
    // mid 425, risk 5.5 → T1 = 425 + 1.1 × 5.5 = 431.05
    expect(checkSetup(reply({ targets: [431.05, 440] }), OK)).toMatchObject({ ok: false, failed: 'rr_below_min' });
    // exactly 1.2 passes: 425 + 1.2 × 5.5 = 431.6
    expect(checkSetup(reply({ targets: [431.6, 440] }), OK)).toEqual({ ok: true });
  });

  it('SL must be on the protective side', () => {
    expect(checkSetup(reply({ sl: 427 }), OK)).toMatchObject({ ok: false, failed: 'sl_wrong_side' });
    expect(checkSetup(reply({ sl: 424.5 }), OK)).toMatchObject({ ok: false, failed: 'sl_wrong_side' }); // inside the zone
  });

  it('targets must be beyond the entry, in order', () => {
    expect(checkSetup(reply({ targets: [] }), OK)).toMatchObject({ ok: false, failed: 'targets_wrong_side' });
    expect(checkSetup(reply({ targets: [423] }), OK)).toMatchObject({ ok: false, failed: 'targets_wrong_side' });
    expect(checkSetup(reply({ targets: [440, 433.5] }), OK)).toMatchObject({ ok: false, failed: 'targets_wrong_side' });
  });

  it('wide SL against the ₹3,000 stock ceiling fails sl_too_wide', () => {
    // zone 424–426, SL 416: (426 − 416) × 0.5 × 1250 = ₹6,250
    expect(checkSetup(reply({ sl: 416, targets: [440] }), ctx({ ceiling: 3000 }))).toMatchObject({ ok: false, failed: 'sl_too_wide' });
    // a smaller lot fits: (426 − 419.5) × 0.5 × 900 = ₹2,925
    expect(checkSetup(reply(), ctx({ ceiling: 3000, lotSize: 900 }))).toEqual({ ok: true });
  });

  it('no class ceiling (table off) uses ₹2,000', () => {
    expect(DEFAULT_SETUP_CEILING_RUPEES).toBe(2000);
    // ₹2,925 > ₹2,000
    expect(checkSetup(reply(), ctx({ ceiling: null, lotSize: 900 }))).toMatchObject({ ok: false, failed: 'sl_too_wide' });
    // (426 − 419.5) × 0.5 × 600 = ₹1,950 fits
    expect(checkSetup(reply(), ctx({ ceiling: null, lotSize: 600 }))).toEqual({ ok: true });
  });

  it('a PE (bearish) mirrors every side and uses |delta|', () => {
    const pe = { ...DABUR_SETUP.instrument, optionType: 'PE' as const };
    const put = reply({ instrument: pe, entry: { type: 'LIMIT_PULLBACK', low: 433, high: 433.6, trigger: null, level: 433.6 }, sl: 436, targets: [428, 425] });
    // worst fill (zone bottom 433) to SL 436 = 3 × |−0.45| × 1250 = ₹1,687.5
    expect(checkSetup(put, ctx({ delta: -0.45, ceiling: 2000 }))).toEqual({ ok: true });
    expect(checkSetup(put, ctx({ delta: -0.45, ceiling: 1500 }))).toMatchObject({ ok: false, failed: 'sl_too_wide' });

    const below = reply({ instrument: pe, entry: { type: 'LIMIT_PULLBACK', low: 424, high: 426, trigger: null, level: 425 }, sl: 428, targets: [420] });
    expect(checkSetup(below, OK)).toMatchObject({ ok: false, failed: 'pullback_wrong_side' });
    const slBelow = reply({ instrument: pe, entry: { type: 'LIMIT_PULLBACK', low: 433, high: 433.6, trigger: null, level: 433.6 }, sl: 430, targets: [428] });
    expect(checkSetup(slBelow, OK)).toMatchObject({ ok: false, failed: 'sl_wrong_side' });
    const tAbove = reply({ instrument: pe, entry: { type: 'LIMIT_PULLBACK', low: 433, high: 433.6, trigger: null, level: 433.6 }, sl: 436, targets: [440] });
    expect(checkSetup(tAbove, OK)).toMatchObject({ ok: false, failed: 'targets_wrong_side' });
  });

  it('spread 2.5 % fails; 2 % passes', () => {
    expect(checkSetup(reply(), ctx({ ceiling: 10_000, spreadPct: 2.5 }))).toMatchObject({ ok: false, failed: 'spread_too_wide' });
    expect(checkSetup(reply(), ctx({ ceiling: 10_000, spreadPct: 2 }))).toEqual({ ok: true });
  });

  it('OI below the minimum fails', () => {
    expect(checkSetup(reply(), ctx({ ceiling: 10_000, oi: 499 }))).toMatchObject({ ok: false, failed: 'oi_too_low' });
  });

  it('every cited evidence value must be in the packet, and none may cite an unavailable block', () => {
    const invented = [...DABUR_SETUP.evidence, { fact: 'delivery %', value: '61', source: 'quote' }];
    expect(checkSetup(reply({ evidence: invented }), OK)).toMatchObject({ ok: false, failed: 'evidence_not_in_packet' });
    const fromUnavailable = [...DABUR_SETUP.evidence, { fact: 'results beat', value: '403', source: 'news60m' }];
    expect(checkSetup(reply({ evidence: fromUnavailable }), OK)).toMatchObject({ ok: false, failed: 'evidence_not_in_packet' });
    expect(checkSetup(reply({ evidence: [] }), OK)).toMatchObject({ ok: false, failed: 'no_evidence' });
  });

  it('intraday only: validUntil ≤ 15:15 IST on NSE/BSE options, ≤ 23:00 on MCX', () => {
    expect(checkSetup(reply({ validUntil: '15:16' }), OK)).toMatchObject({ ok: false, failed: 'valid_until_after_close' });
    expect(checkSetup(reply({ validUntil: '3pm' }), OK)).toMatchObject({ ok: false, failed: 'malformed' });
    expect(checkSetup(reply({ validUntil: '22:30' }), ctx({ ceiling: 10_000, exchange: 'MCX' }))).toEqual({ ok: true });
    expect(checkSetup(reply({ validUntil: '23:05' }), ctx({ ceiling: 10_000, exchange: 'MCX' }))).toMatchObject({ ok: false, failed: 'valid_until_after_close' });
  });

  it.each([
    ['ltpUnderlying', 'ltp_unavailable'],
    ['atr15m', 'atr_unavailable'],
    ['delta', 'delta_unavailable'],
    ['lotSize', 'lot_unavailable'],
    ['spreadPct', 'spread_unavailable'],
    ['oi', 'oi_unavailable'],
  ] as const)('missing %s → %s, never a setup on absent numbers', (key, failed) => {
    expect(checkSetup(reply(), ctx({ ceiling: 10_000, [key]: null }))).toMatchObject({ ok: false, failed });
  });

  it('a zero ATR, delta or lot is missing data, not a free pass', () => {
    expect(checkSetup(reply(), ctx({ ceiling: 10_000, atr15m: 0 }))).toMatchObject({ ok: false, failed: 'atr_unavailable' });
    expect(checkSetup(reply(), ctx({ ceiling: 10_000, delta: 0 }))).toMatchObject({ ok: false, failed: 'delta_unavailable' });
    expect(checkSetup(reply(), ctx({ ceiling: 10_000, lotSize: 0 }))).toMatchObject({ ok: false, failed: 'lot_unavailable' });
  });
});

describe('packetLevels', () => {
  it('is the level fields plus 15m swing highs / lows, minus LTP; never strike, OI, volume, open or ATR', () => {
    const levels = packetLevels(PACKET, 431.3);
    expect([...levels].sort((a, b) => a - b)).toEqual([399.4, 403, 404.8, 424.8, 425, 432.9, 433.6]);
  });

  it('skips unavailable blocks and drops a level equal to LTP', () => {
    const p = { quote: { status: 'unavailable', reason: 'x', value: { dayHigh: 500 } }, q2: { status: 'present', value: { dayHigh: 431.3, prevLow: 420, VWAP: 428.15 } } };
    expect([...packetLevels(p, 431.3)].sort()).toEqual([420, 428.15]);
  });

  it('only interior bars can be swings', () => {
    const bars = [
      { high: 10, low: 5 },
      { high: 9, low: 6 },
      { high: 11, low: 4 },
    ];
    expect([...packetLevels({ bars15m: bars }, null)]).toEqual([]);
  });
});

describe('setupCeilingFor', () => {
  it('is the Plan 1 class ceiling when the table lists the class, else ₹2,000', () => {
    expect(setupCeilingFor('DABUR', 'NFO', { HARD_LOSS_CEILING_BY_CLASS: 'STOCK_OPT:3000' })).toBe(3000);
    expect(setupCeilingFor('DABUR', 'NFO', {})).toBe(2000);
    expect(setupCeilingFor('NIFTY', 'NFO', { HARD_LOSS_CEILING_BY_CLASS: 'STOCK_OPT:3000' })).toBe(2000);
  });
});
