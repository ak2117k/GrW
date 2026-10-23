import { resolveContract } from './contract-resolver';
import { buildEntryOrder, signalOrderTag, slEnforceability, slExitTrigger } from './execution';
import { judgeDecision, parseJudgeVerdict, type JudgeVerdict } from './judge';
import { parseSignalTraderConfig } from './signal-trader.config';
import type { EntryPlan } from './gate';
import type { SignalView } from './signal.types';
import { parseStoredTrigger } from '../../sentinel-executor/domain/stored-trigger';
import { AI_EXIT_TAG_PREFIX, MANUAL_EXIT_TAG_PREFIX, PRICE_TRIGGER_TAG_PREFIX } from '../../sentinel-executor/domain/exit-order';

const sig = (over: Partial<SignalView> = {}): SignalView => ({
  id: 's', channelId: null, receivedAt: null, underlying: 'NIFTY', instrumentKind: 'CE', strike: 25000, expiry: null,
  side: 'BUY', entryLow: 100, entryHigh: 100, entryType: 'ABOVE', sl: 90, targets: [], qty: null, confidence: null, rawText: '',
  ...over,
});

const master = [
  { token: '1', symbol: 'NIFTY28OCT2625000CE', name: 'NIFTY', expiry: '28OCT2026', strike: '2500000.000000', lotsize: '75', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5.000000' },
  { token: '2', symbol: 'NIFTY04NOV2625000CE', name: 'NIFTY', expiry: '04NOV2026', strike: '2500000.000000', lotsize: '75', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5.000000' },
  { token: '3', symbol: 'NIFTY21OCT2625000CE', name: 'NIFTY', expiry: '21OCT2026', strike: '2500000.000000', lotsize: '75', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5.000000' },
  { token: '4', symbol: 'NIFTY28OCT26FUT', name: 'NIFTY', expiry: '28OCT2026', strike: '-1', lotsize: '75', instrumenttype: 'FUTIDX', exch_seg: 'NFO', tick_size: '10.000000' },
  { token: '5', symbol: 'INFY-EQ', name: 'INFY', expiry: '', strike: '-1', lotsize: '1', instrumenttype: '', exch_seg: 'NSE', tick_size: '5.000000' },
];
const today = new Date(2026, 9, 23);

describe('contract resolver', () => {
  it('picks the nearest LIVE expiry, strike in paise, tick in rupees', () => {
    const r = resolveContract(master, sig(), today);
    expect(r).toEqual({ ok: true, contract: { exchange: 'NFO', token: '1', tradingsymbol: 'NIFTY28OCT2625000CE', lotSize: 75, tickSize: 0.05, expiry: '2026-10-28' } });
  });
  it('honours a stated expiry, refuses an unknown one', () => {
    expect(resolveContract(master, sig({ expiry: '2026-11-04' }), today)).toMatchObject({ ok: true, contract: { token: '2' } });
    expect(resolveContract(master, sig({ expiry: '2026-11-11' }), today).ok).toBe(false);
  });
  it('futures and cash', () => {
    expect(resolveContract(master, sig({ instrumentKind: 'FUT', strike: null }), today)).toMatchObject({ ok: true, contract: { token: '4', tickSize: 0.1 } });
    expect(resolveContract(master, sig({ instrumentKind: 'EQ', underlying: 'INFY', strike: null }), today)).toMatchObject({ ok: true, contract: { token: '5', exchange: 'NSE' } });
  });
  it('refuses a strike that does not exist', () => {
    expect(resolveContract(master, sig({ strike: 25050 }), today).ok).toBe(false);
  });
});

describe('entry order', () => {
  const plan = { exchange: 'NFO', token: '1', tradingsymbol: 'X', lotSize: 75, tickSize: 0.05, side: 'BUY', ltp: 101, bandLow: 100, bandHigh: 103, limitPrice: 101.5, sl: 90, slSource: 'signal', targets: [120], lots: 2, qty: 150, riskRupees: 1725 } as EntryPlan;
  it('is ALWAYS a LIMIT at the planned price — never MARKET', () => {
    const o = buildEntryOrder(plan, 'INTRADAY', 'units');
    expect(o).toMatchObject({ orderType: 'LIMIT', price: 101.5, quantity: 150, positionType: 'INTRADAY' });
    expect(buildEntryOrder(plan, 'INTRADAY', 'lots').quantity).toBe(2);
    expect(() => buildEntryOrder({ ...plan, limitPrice: 0 }, 'INTRADAY', 'units')).toThrow(/LIMIT/);
  });
  it('ordertag ≤ 20 chars, never an exit prefix', () => {
    const t = signalOrderTag('cm9x8y7z6w5v4u3t2s1r0q');
    expect(t.length).toBeLessThanOrEqual(20);
    expect(t.startsWith('sg')).toBe(true);
    for (const p of [AI_EXIT_TAG_PREFIX, MANUAL_EXIT_TAG_PREFIX, PRICE_TRIGGER_TAG_PREFIX]) expect(t.startsWith(p)).toBe(false);
  });
  it('the SL exit trigger is a valid stored trigger on the protective side', () => {
    const long = slExitTrigger(plan, { price: 101.5, at: '2026-10-23T05:00:00Z' });
    expect(parseStoredTrigger(long)).toEqual({ kind: 'trigger', trigger: { instrument: 'PREMIUM', op: 'BELOW', price: 90, watch: null } });
    expect(slExitTrigger({ side: 'SELL', sl: 110 }, { price: 100, at: '' }).op).toBe('ABOVE');
  });
});

describe('SL enforceability (live requirement)', () => {
  const env = { SENTINEL_TRIGGERS_ENABLED: 'true', AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_USER_IDS: 'owner' };
  it('needs triggers on, auto-exit live, the owner allow-listed and an F&O venue', () => {
    const ok = slEnforceability(env, 'owner', 'NFO', 'X');
    expect(ok.ok).toBe(true);
    expect(slEnforceability({ ...env, SENTINEL_TRIGGERS_ENABLED: 'false' }, 'owner', 'NFO', 'X').ok).toBe(false);
    expect(slEnforceability({ ...env, AI_AUTO_EXIT_MODE: 'dry-run' }, 'owner', 'NFO', 'X').ok).toBe(false);
    expect(slEnforceability(env, 'someone', 'NFO', 'X').ok).toBe(false);
    expect(slEnforceability(env, 'owner', 'NSE', 'INFY-EQ').ok).toBe(false);
  });
});

describe('judge parsing and decision', () => {
  const msg = (text: string) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }) as never;
  it('strict JSON', () => {
    const v = parseJudgeVerdict(msg('{"verdict":"TAKE","confidence":72,"reasons":["PCR supports"],"entry":101,"sl":95,"targets":[120],"lots":1}'));
    expect(v).toMatchObject({ verdict: 'TAKE', confidence: 72, sl: 95, lots: 1 });
    expect(() => parseJudgeVerdict(msg('take it'))).toThrow();
    expect(() => parseJudgeVerdict(msg('{"verdict":"BUY","confidence":5,"reasons":[]}'))).toThrow();
  });
  const v = (verdict: 'TAKE' | 'SKIP', confidence: number): JudgeVerdict => ({ verdict, confidence, reasons: [], entry: null, sl: null, targets: [], lots: null });
  const c = parseSignalTraderConfig({});
  it('SKIP is final; strong agreement boosts; a CONFLICT cluster gets no boost', () => {
    expect(judgeDecision(v('SKIP', 99), { agreeCount: 5, conflict: false }, c).take).toBe(false);
    expect(judgeDecision(v('TAKE', 55), { agreeCount: 3, conflict: false }, c)).toMatchObject({ take: true, effectiveConfidence: 65 });
    expect(judgeDecision(v('TAKE', 55), { agreeCount: 3, conflict: true }, c)).toMatchObject({ take: false, reason: 'low_confidence' });
    expect(judgeDecision(v('TAKE', 55), { agreeCount: 1, conflict: false }, c).take).toBe(false);
  });
});

describe('config', () => {
  it('defaults to shadow with the contract caps; a typo never means live', () => {
    const c = parseSignalTraderConfig({});
    expect(c).toMatchObject({ mode: 'shadow', maxLots: 2, maxLossPerTrade: 2000, maxTradesPerDay: 3, dailyLossStop: 10000 });
    expect(parseSignalTraderConfig({ SIGNAL_TRADING: 'LIVEE' }).mode).toBe('shadow');
    expect(parseSignalTraderConfig({ SIGNAL_MAX_LOTS: '200' }).maxLots).toBe(2);
  });
});
