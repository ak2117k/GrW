import { parseExitDisciplineConfig } from '../exit-discipline/config';
import { parseTriggerConfig } from '../sentinel-executor/domain/trigger-config';
import { armPaperTrigger, gateExits, paperExitGate, stepPaperTrigger, type PaperTrigger } from './paper-exit';

const NOW = Date.parse('2026-10-29T06:00:00Z');
const tcfg = parseTriggerConfig({});
const FNO = ['NFO', 'BFO', 'MCX'];
const EQ = [...FNO, 'NSE', 'BSE'];
const premium = (price: number, ageMs = 0) => ({ premium: { price, at: NOW - ageMs }, underlying: null });
const trigger = (o: Record<string, unknown>) => ({ v: 1, instrument: 'PREMIUM', op: 'BELOW', price: 90, watch: null, ...o });
const arm = (o: Partial<Parameters<typeof armPaperTrigger>[0]> = {}) =>
  armPaperTrigger({
    pending: { lookId: 'L1', exitTrigger: trigger({}), seenAt: NOW },
    symbol: 'NIFTY04NOV2524000CE',
    exchange: 'NFO',
    qty: 75,
    prices: premium(100),
    armed: null,
    cfg: tcfg,
    exchanges: FNO,
    now: NOW,
    ...o,
  });

describe('paperExitGate — ExitGateService.decide on a paper look', () => {
  const base = {
    look: { id: 'L1', createdAt: new Date(NOW), packet: {} },
    history: [],
    ltpNow: 100,
    productType: 'INTRADAY',
    minutesToClose: 120,
    sessionMinutes: 375,
    maxLossPerTrade: null,
    dailyLossLatched: false,
    tuning: null,
    now: new Date(NOW),
  };

  it('discipline off: BYPASS DISABLED, which exits exactly as live does', () => {
    const r = paperExitGate({ ...base, cfg: parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'false' }) });
    expect(r.outcome).toBe('BYPASS');
    expect(r.bypassReason).toBe('DISABLED');
    expect(gateExits(r)).toBe(true);
  });

  it('an unreadable packet fails OPEN (FACTS_UNREADABLE), as the live gate', () => {
    const r = paperExitGate({ ...base, look: { ...base.look, packet: 'nope' }, cfg: { ...parseExitDisciplineConfig({}), enabled: true } });
    expect(r.outcome).toBe('BYPASS');
    expect(r.bypassReason).toBe('FACTS_UNREADABLE');
    expect(gateExits(r)).toBe(true);
  });

  it('FLOOR_HARD_EXIT: the cycle rule\'s EXIT_NOW (a packet with money.anchors) exits a paper trade at once, as live', () => {
    const block = (value: unknown) => ({ available: true, value, source: 's', at: 'a' });
    const packet = (anchors: unknown) => ({
      position: { symbol: 'CRUDEOILM17NOV269350PE', side: 'LONG', qty: 20, entryPrice: 362.55, ltp: 364, underlyingLtp: block(9600) },
      money: { charges: 135, netPnl: -106, greenFloorPrice: 376.8, greenFloorArmed: true, floorBasis: 'noise', ...(anchors ? { anchors } : {}) },
      thesis: block({ invalidation: 9650 }),
      structure: { levelBook: block({ vwap: 9610 }), nearestSupport: block(9500), nearestResistance: block(9620) },
      flow: { noiseUnit: block({ contract: { n: 1.8, method: 'atr14-1m', bars: 60, at: 'a' }, underlying: { n: 12.5, method: 'atr14-1m', bars: 60, at: 'a' } }) },
      session: { nowUtc: 'a', minutesToClose: block(130) },
    });
    const anchors = { best: { ltp: 380.4, underlying: 9531, at: 'a' }, floorArm: { ltp: 373, underlying: 9547, at: 'a' }, underlyingAgainst: {}, hardExitN: 2 };
    const r = paperExitGate({ ...base, ltpNow: 363.8, look: { ...base.look, packet: packet(anchors) }, cfg: parseExitDisciplineConfig({}) });
    expect(r).toMatchObject({ outcome: 'PASS', justification: 'FLOOR_HARD_EXIT', persistence: { rule: 'BYPASS' } });
    expect(gateExits(r)).toBe(true);
    // The same packet before anchors existed: the old frame, which waits for a second EXIT_NOW.
    const legacy = paperExitGate({ ...base, ltpNow: 363.8, look: { ...base.look, packet: packet(null) }, cfg: parseExitDisciplineConfig({}) });
    expect(legacy.justification).not.toBe('FLOOR_HARD_EXIT');
  });

  it('only PASS and BYPASS exit; a held or unconfirmed verdict does not', () => {
    expect(gateExits({ outcome: 'GATED_THESIS_INTACT' } as never)).toBe(false);
    expect(gateExits({ outcome: 'AWAITING_CONFIRMATION' } as never)).toBe(false);
    expect(gateExits({ outcome: 'PASS' } as never)).toBe(true);
  });
});

describe('armPaperTrigger — the live arming rules', () => {
  it('arms a protective premium stop below the price on a long', () => {
    const r = arm();
    expect(r).toEqual({ kind: 'armed', trigger: expect.objectContaining({ lookId: 'L1', instrument: 'PREMIUM', op: 'BELOW', price: 90, refPrice: 100, armedAt: NOW }) });
  });

  it('rejects a level on the wrong side (NOT_PROTECTIVE) and one already crossed', () => {
    expect(arm({ pending: { lookId: 'L1', exitTrigger: trigger({ op: 'ABOVE', price: 110 }), seenAt: NOW } })).toEqual({ kind: 'rejected', reason: 'NOT_PROTECTIVE' });
    expect(arm({ pending: { lookId: 'L1', exitTrigger: trigger({ price: 101 }), seenAt: NOW } })).toEqual({ kind: 'rejected', reason: 'ALREADY_CROSSED' });
  });

  it('a short flips the protective side', () => {
    expect(arm({ qty: -75, pending: { lookId: 'L1', exitTrigger: trigger({ op: 'ABOVE', price: 110 }), seenAt: NOW } }).kind).toBe('armed');
  });

  it('waits for a fresh price inside the defer window, then rejects NO_FRESH_PRICE', () => {
    expect(arm({ prices: premium(100, 20_000) })).toEqual({ kind: 'wait' });
    expect(arm({ prices: premium(100, 20_000), pending: { lookId: 'L1', exitTrigger: trigger({}), seenAt: NOW - 31_000 } })).toEqual({
      kind: 'rejected',
      reason: 'NO_FRESH_PRICE',
    });
  });

  it('arms only on the allowed exchanges (F&O alone when equity is off)', () => {
    expect(arm({ exchange: 'NSE', symbol: 'RELIANCE-EQ' })).toEqual({ kind: 'rejected', reason: 'EXCHANGE_NOT_ALLOWED (NSE)' });
    expect(arm({ exchange: 'nse', symbol: 'RELIANCE-EQ', exchanges: EQ })).toMatchObject({ kind: 'armed' });
  });

  it('an F&O UNDERLYING trigger is unchanged: armed on the underlying, under its own limit', () => {
    const r = arm({
      pending: { lookId: 'L1', exitTrigger: trigger({ instrument: 'UNDERLYING', price: 23900 }), seenAt: NOW },
      prices: { premium: { price: 100, at: NOW }, underlying: { price: 24000, at: NOW } },
    });
    expect(r).toEqual({ kind: 'armed', trigger: { lookId: 'L1', instrument: 'UNDERLYING', op: 'BELOW', price: 23900, armedAt: NOW, refPrice: 24000 } });
  });

  it('tighten-only: a newer level that loosens the armed one is rejected', () => {
    const armed: PaperTrigger = { lookId: 'L0', instrument: 'PREMIUM', op: 'BELOW', price: 95, armedAt: NOW - 60_000, refPrice: 100 };
    expect(arm({ armed })).toEqual({ kind: 'rejected', reason: 'LOOSENS' });
  });

  it('a malformed stored trigger is rejected with the reader’s reason', () => {
    expect(arm({ pending: { lookId: 'L1', exitTrigger: { v: 1, problem: 'no level' }, seenAt: NOW } })).toEqual({ kind: 'rejected', reason: 'MALFORMED: no level' });
  });
});

describe('armPaperTrigger — cash equity (NSE/BSE)', () => {
  // SAKAR-EQ long 100 at ₹500: the contract IS the stock, so there is one price.
  const cash = (o: Partial<Parameters<typeof armPaperTrigger>[0]> = {}) =>
    arm({ symbol: 'SAKAR-EQ', exchange: 'NSE', qty: 100, exchanges: EQ, prices: { premium: { price: 500, at: NOW }, underlying: { price: 500, at: NOW } }, ...o });
  const at = (o: Record<string, unknown>) => ({ lookId: 'L1', exitTrigger: trigger(o), seenAt: NOW });

  it('an UNDERLYING proposal is normalised to the stock’s own price (no UNKNOWN_CONTRACT_KIND)', () => {
    const r = cash({ pending: at({ instrument: 'UNDERLYING', price: 480 }) });
    expect(r).toEqual({
      kind: 'armed',
      trigger: { lookId: 'L1', instrument: 'PREMIUM', op: 'BELOW', price: 480, armedAt: NOW, refPrice: 500, proposedInstrument: 'UNDERLYING' },
    });
  });

  it('a PREMIUM proposal arms as is, with no normalisation note', () => {
    const r = cash({ pending: at({ price: 480 }) });
    expect(r).toEqual({ kind: 'armed', trigger: { lookId: 'L1', instrument: 'PREMIUM', op: 'BELOW', price: 480, armedAt: NOW, refPrice: 500 } });
  });

  it('the distance limit is the UNDERLYING 10 %, not PREMIUM’s 60 %', () => {
    expect(cash({ pending: at({ price: 451 }) }).kind).toBe('armed'); // 9.8 %
    expect(cash({ pending: at({ price: 400 }) })).toEqual({ kind: 'rejected', reason: 'TOO_FAR (20.00% > 10%)' });
    expect(cash({ pending: at({ instrument: 'UNDERLYING', price: 400 }) })).toEqual({ kind: 'rejected', reason: 'TOO_FAR (20.00% > 10%)' });
    // The same 20 % on an option premium stays inside PREMIUM's 60 %.
    expect(arm({ pending: { lookId: 'L1', exitTrigger: trigger({ price: 80 }), seenAt: NOW } }).kind).toBe('armed');
  });

  it('the protective side is the position’s sign: a long stock exits BELOW, a short ABOVE', () => {
    expect(cash({ pending: at({ instrument: 'UNDERLYING', op: 'ABOVE', price: 520 }) })).toEqual({ kind: 'rejected', reason: 'NOT_PROTECTIVE' });
    expect(cash({ qty: -100, pending: at({ instrument: 'UNDERLYING', op: 'ABOVE', price: 520 }) })).toMatchObject({
      kind: 'armed',
      trigger: { instrument: 'PREMIUM', op: 'ABOVE', price: 520 },
    });
    expect(cash({ qty: -100, pending: at({ op: 'BELOW', price: 480 }) })).toEqual({ kind: 'rejected', reason: 'NOT_PROTECTIVE' });
  });

  it('the live rules still apply: already crossed, fresh price, tighten-only across both proposal kinds, malformed', () => {
    expect(cash({ pending: at({ price: 505 }) })).toEqual({ kind: 'rejected', reason: 'ALREADY_CROSSED' });
    expect(cash({ prices: { premium: { price: 500, at: NOW - 20_000 }, underlying: null } })).toEqual({ kind: 'wait' });
    const armed: PaperTrigger = { lookId: 'L0', instrument: 'PREMIUM', op: 'BELOW', price: 490, armedAt: NOW - 60_000, refPrice: 500, proposedInstrument: 'UNDERLYING' };
    expect(cash({ armed, pending: at({ instrument: 'UNDERLYING', price: 480 }) })).toEqual({ kind: 'rejected', reason: 'LOOSENS' });
    expect(cash({ armed, pending: at({ instrument: 'UNDERLYING', price: 495 }) })).toMatchObject({ kind: 'armed', trigger: { price: 495 } });
    expect(cash({ pending: { lookId: 'L1', exitTrigger: { v: 1, problem: 'no level' }, seenAt: NOW } })).toEqual({ kind: 'rejected', reason: 'MALFORMED: no level' });
  });

  it('BSE is cash too', () => {
    expect(cash({ exchange: 'BSE', pending: at({ instrument: 'UNDERLYING', price: 480 }) })).toMatchObject({ kind: 'armed', trigger: { instrument: 'PREMIUM' } });
  });
});

describe('stepPaperTrigger', () => {
  const t: PaperTrigger = { lookId: 'L1', instrument: 'PREMIUM', op: 'BELOW', price: 90, armedAt: NOW, refPrice: 100 };

  it('fires on the first sweep beyond the level; touching it is not crossing', () => {
    expect(stepPaperTrigger(t, premium(90), tcfg, NOW + 30_000)).toEqual({ kind: 'none' });
    expect(stepPaperTrigger(t, premium(89.5), tcfg, NOW + 30_000)).toEqual({ kind: 'fire', watched: 89.5 });
  });

  it('an UNDERLYING trigger reads the underlying, not the premium', () => {
    const u: PaperTrigger = { ...t, instrument: 'UNDERLYING', price: 24000 };
    expect(stepPaperTrigger(u, { premium: { price: 1, at: NOW }, underlying: { price: 24010, at: NOW } }, tcfg, NOW)).toEqual({ kind: 'none' });
    expect(stepPaperTrigger(u, { premium: { price: 1, at: NOW }, underlying: { price: 23990, at: NOW } }, tcfg, NOW)).toEqual({ kind: 'fire', watched: 23990 });
  });

  it('expires at the live max age', () => {
    expect(stepPaperTrigger(t, premium(80), tcfg, NOW + tcfg.maxAgeMin * 60_000 + 1)).toEqual({ kind: 'expired' });
  });
});
