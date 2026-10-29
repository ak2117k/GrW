import { parseExitDisciplineConfig } from '../exit-discipline/config';
import { parseTriggerConfig } from '../sentinel-executor/domain/trigger-config';
import { armPaperTrigger, gateExits, paperExitGate, stepPaperTrigger, type PaperTrigger } from './paper-exit';

const NOW = Date.parse('2026-10-29T06:00:00Z');
const tcfg = parseTriggerConfig({});
const FNO = ['NFO', 'BFO', 'MCX'];
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
    fnoExchanges: FNO,
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

  it('is F&O only, as the live auto-exit', () => {
    expect(arm({ exchange: 'NSE', symbol: 'RELIANCE-EQ' })).toEqual({ kind: 'rejected', reason: 'EXCHANGE_NOT_FNO' });
  });

  it('tighten-only: a newer level that loosens the armed one is rejected', () => {
    const armed: PaperTrigger = { lookId: 'L0', instrument: 'PREMIUM', op: 'BELOW', price: 95, armedAt: NOW - 60_000, refPrice: 100 };
    expect(arm({ armed })).toEqual({ kind: 'rejected', reason: 'LOOSENS' });
  });

  it('a malformed stored trigger is rejected with the reader’s reason', () => {
    expect(arm({ pending: { lookId: 'L1', exitTrigger: { v: 1, problem: 'no level' }, seenAt: NOW } })).toEqual({ kind: 'rejected', reason: 'MALFORMED: no level' });
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
