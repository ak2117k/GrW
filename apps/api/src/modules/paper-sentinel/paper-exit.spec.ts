import { parseExitDisciplineConfig } from '../exit-discipline/config';
import { parseTriggerConfig } from '../sentinel-executor/domain/trigger-config';
import { armPaperTrigger, gateExits, paperCloseEffect, paperExitGate, stepPaperTrigger, type PaperTrigger } from './paper-exit';

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

  describe('trigger check (record only)', () => {
    /** Paper trade cmwaqfnbs0g1epm01gowo9h2t, 2026-11-10 21:21 IST. */
    const goldPacket = {
      position: { symbol: 'GOLD26DEC26141000PE', side: 'LONG', qty: 1, entryPrice: 2900, ltp: 2635.5, underlyingLtp: { available: true, value: 141021 } },
      money: { netPnl: -7800, greenFloorArmed: false },
      flow: { noiseUnit: { available: true, value: { contract: null, underlying: { n: 56, method: 'atr14-1m', bars: 60, at: 'x' } } } },
    };
    const gold = (basis: unknown) => arm({
      symbol: 'GOLD26DEC26141000PE', exchange: 'MCX', qty: 1,
      pending: { lookId: 'L1', exitTrigger: trigger({ instrument: 'UNDERLYING', op: 'ABOVE', price: 141150 }), seenAt: NOW, basis: basis as never },
      prices: { premium: { price: 2635.5, at: NOW }, underlying: { price: 141021, at: NOW } },
    });

    it('the gold case: armed exactly as before, with the check on the trigger', () => {
      const r = gold({ packet: goldPacket, invalidationPoint: 'GOLD sustains above 141860 (VWAP 141725)', netPnl: -7800 });
      expect(r).toMatchObject({ kind: 'armed', trigger: { instrument: 'UNDERLYING', op: 'ABOVE', price: 141150, refPrice: 141021 } });
      expect((r as { trigger: PaperTrigger }).trigger.check).toMatchObject({
        distance: 129, distanceN: 2.3, insideInvalidation: true, invalidation: 141860, positionWant: 'DOWN',
        pnlState: 'RED', purpose: 'CUT_LOSS', tight: true,
      });
    });

    it('an unreadable packet, or no basis, arms the same trigger with no check', () => {
      const bare = gold(undefined);
      const junk = gold({ packet: 'junk', invalidationPoint: null, netPnl: null });
      expect(bare).toMatchObject({ kind: 'armed' });
      expect('check' in (bare as { trigger: object }).trigger).toBe(false);
      expect(junk).toEqual(bare);
    });
  });

  describe('CUT_LOSS yardstick (acts on paper)', () => {
    /** Paper trade cmwbm1oq50uaanx01gvwjah7x, 2026-11-11: BANKNIFTY 60800 CE long, best 60791.95, N1 41.8, thesis 59741.25. */
    const block = (value: unknown) => ({ available: true, value, source: 's', at: 'a' });
    const packet = {
      position: { symbol: 'BANKNIFTY23NOV2660800CE', side: 'LONG', qty: 30, entryPrice: 745.37, ltp: 730, underlyingLtp: block(60776.8) },
      money: { netPnl: -402.4, greenFloorArmed: false, anchors: { best: { ltp: 760, underlying: 60791.95, at: 'x' }, floorArm: null, hardExitN: 2 } },
      thesis: block({ invalidation: 59741.25 }),
      flow: { noiseUnit: block({ contract: null, underlying: { n: 41.8, method: 'atr14-1m', bars: 60, at: 'x' } }) },
    };
    const watch = { exchange: 'NSE', token: '99926009', symbol: 'BANKNIFTY' };
    const cutLoss = { n15: { n: 107.71, bars: 14, method: 'atr14-15m' as const, at: 'x' }, k15: 1.5 };
    const bnf = (price: number, o: { thesisStatus?: string; armed?: PaperTrigger | null; under?: number; cut?: boolean } = {}) => arm({
      symbol: 'BANKNIFTY23NOV2660800CE', qty: 30,
      pending: {
        lookId: 'L2', exitTrigger: trigger({ instrument: 'UNDERLYING', price, watch }), seenAt: NOW,
        basis: { packet, invalidationPoint: `Underlying trading below ${price}`, netPnl: -402.4, thesisStatus: o.thesisStatus ?? 'INTACT', reason: 'r' },
      },
      prices: { premium: { price: 730, at: NOW }, underlying: { price: o.under ?? 60776.8, at: NOW } },
      armed: o.armed ?? null,
      ...(o.cut === false ? {} : { cutLoss }),
    });

    it('09:53 IST: the AI\'s 60708 (K·N1) is armed at 1.5 N15 from the best point, 60630.38; the check keeps the AI\'s level', () => {
      const r = bnf(60708);
      expect(r).toMatchObject({ kind: 'armed', trigger: { price: 60630.38, proposedPrice: 60708, refPrice: 60776.8 } });
      expect((r as { trigger: PaperTrigger }).trigger.check).toMatchObject({
        triggerPrice: 60708, purpose: 'CUT_LOSS', tight: true, wouldArmAt: 60630.38, n15: 107.71, acted: true,
        cutLoss: { widenedFrom: 60708, invalidation: 59741.25, minDistance: 161.57 },
      });
    });

    it('without the yardstick inputs the live rules are unchanged', () => {
      const r = bnf(60708, { cut: false });
      expect(r).toMatchObject({ kind: 'armed', trigger: { price: 60708 } });
      expect('proposedPrice' in (r as { trigger: object }).trigger).toBe(false);
    });

    it('10:13 IST: thesis INTACT may loosen a tight armed level to the invalidation (refused LOOSENS in prod)', () => {
      const armed: PaperTrigger = { lookId: 'L1', instrument: 'UNDERLYING', op: 'BELOW', price: 60708, armedAt: NOW - 60_000, refPrice: 60744, check: { tight: true } as never };
      const r = bnf(59741.25, { armed, under: 60736.95 });
      expect(r).toMatchObject({ kind: 'armed', trigger: { price: 59741.25, loosenedFrom: 60708 } });
      expect((r as { trigger: PaperTrigger }).trigger.check).toMatchObject({ wouldAllowLoosen: true, loosenWhy: 'ARMED_TIGHT' });
    });

    it('09:56 IST: a WEAKENING thesis keeps tighten-only', () => {
      const armed: PaperTrigger = { lookId: 'L1', instrument: 'UNDERLYING', op: 'BELOW', price: 60708, armedAt: NOW - 60_000, refPrice: 60744, check: { tight: true } as never };
      expect(bnf(60660, { armed, thesisStatus: 'WEAKENING', under: 60709.75 })).toEqual({ kind: 'rejected', reason: 'LOOSENS' });
    });

    it('a level the yardstick armed wide is judged by the minimum only: re-proposing K·N1 re-arms the same wide level', () => {
      const armed: PaperTrigger = {
        lookId: 'L1', instrument: 'UNDERLYING', op: 'BELOW', price: 60630.38, proposedPrice: 60708, armedAt: NOW - 60_000, refPrice: 60774,
        check: { tight: true } as never,
      };
      expect(bnf(60708, { armed, thesisStatus: 'WEAKENING', under: 60741 })).toMatchObject({ kind: 'armed', trigger: { price: 60630.38 } });
    });

    it('a green position (PROTECT_PROFIT) keeps the AI\'s level', () => {
      const r = arm({
        symbol: 'BANKNIFTY23NOV2660800CE', qty: 30,
        pending: { lookId: 'L2', exitTrigger: trigger({ instrument: 'UNDERLYING', price: 60708, watch }), seenAt: NOW, basis: { packet, invalidationPoint: null, netPnl: 500, thesisStatus: 'INTACT' } },
        prices: { premium: { price: 760, at: NOW }, underlying: { price: 60776.8, at: NOW } },
        cutLoss,
      });
      expect(r).toMatchObject({ kind: 'armed', trigger: { price: 60708 } });
    });
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

describe('paperCloseEffect — intraday carry on paper (2026-11-04 D12)', () => {
  it('CARRY converts an INTRADAY paper trade to CARRYFORWARD; EXIT leaves it to the paper square-off', () => {
    expect(paperCloseEffect('CARRY', 'INTRADAY')).toMatchObject({ kind: 'convert', positionType: 'CARRYFORWARD' });
    expect(paperCloseEffect('EXIT', 'INTRADAY').kind).toBe('leave');
    expect(paperCloseEffect('CAP_BLOCKED_BROKER_SQUARE_OFF', 'intraday').kind).toBe('leave');
  });
  it('a trade that is not INTRADAY is never touched', () => {
    expect(paperCloseEffect('CARRY', 'CARRYFORWARD').kind).toBe('leave');
    expect(paperCloseEffect('CARRY', null).kind).toBe('leave');
  });
});
