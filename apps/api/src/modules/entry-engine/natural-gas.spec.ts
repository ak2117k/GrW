import { parseSignalTraderConfig } from '../signal-trader/domain/signal-trader.config';
import { segmentFor } from '../signal-trader/domain/contract-resolver';
import { MINI_OF } from '../signal-trader/domain/mini-swap';
import { contractValueFactor, mcxUnderlyingOf } from '@td/shared';
import type { TrendBar } from '../signal-trader/domain/trend-tag';
import { ENGINE_UNIVERSE, sessionStartOf } from './domain/engine-inputs';
import { optionFutureSpot } from './domain/engine-contract';
import { impactConcerns, type Bar1m, type ImpactRow } from './domain/entry-decision';
import { headlineAbout, themeMatch } from './domain/news-theme';
import { parseEntryEngineConfig } from './entry-engine.config';
import { EntryEngineService } from './entry-engine.service';
import { DEFAULT_LINE_FUTURES, futureExchangeFor, parseLineFutures } from '../market-hub/hub-lines';
import { REENTRY_UNIVERSE, watchUnderlying } from '../reentry-watch/domain/reentry-rules';
import { newsKeyFor } from '../news/services/underlying-news-aliases';

/**
 * 2026-11-23: NATURALGAS joins the entry engine (paper) and the re-entry watch. It fell ~5% that day and the engine
 * never looked at it. Prod that day: the price line (nearest future) was NATURALGAS24NOV26FUT (574319) while the live
 * options (23 DEC) settle to NATURALGAS28DEC26FUT (578249) — the ATM must be centred on the DEC future.
 */
const MIN = 60_000;
const AT = new Date('2026-11-23T04:35:00Z'); // 10:05 IST
const SESSION = new Date('2026-11-23T03:30:00Z'); // MCX 09:00 IST
const NOV = { exchange: 'MCX', token: '574319', symbol: 'NATURALGAS24NOV26FUT', expiry: '2026-11-24' };
const DEC = { exchange: 'MCX', token: '578249', symbol: 'NATURALGAS28DEC26FUT', expiry: '2026-12-28' };
const JAN = { exchange: 'MCX', token: '581135', symbol: 'NATURALGAS25JAN27FUT', expiry: '2027-01-25' };

/** NATURALGAS24NOV26FUT falling (BEARISH): the previous session, then 65 bars of today ending ≈ 345. */
function fallingGasBars(): Bar1m[] {
  const out: Bar1m[] = [];
  const mk = (ts: number, c: number, i: number) => out.push({ ts, open: c, high: c + 0.05, low: c - 0.05, close: c, volume: 100 + ((i * 37) % 11) });
  for (let i = 0; i < 840; i++) mk(SESSION.getTime() - 24 * 60 * MIN + i * MIN, 360 - i * 0.008, i);
  for (let i = 0; i < 65; i++) mk(SESSION.getTime() + i * MIN, 351.5 - i * 0.1, i);
  return out;
}

const STRIKES = [320, 325, 330, 335, 340, 345, 350];

const gasImpact: ImpactRow = {
  clusterId: 'ng1', analysedAt: new Date(AT.getTime() - 5 * MIN), firstSeen: new Date(AT.getTime() - 60 * MIN), direction: 'BEAR', magnitude: 'MED',
  confidence: 0.5, pricedIn: false, symbols: ['NATURALGAS'], sectors: ['MCX ENERGY'], indexName: null, material: false, materialType: 'NEWS', headline: 'Natural gas slides 5% on mild weather forecasts',
};

/** A NATURALGAS DEC chain whose put OI unwinds (bearish lean) through the session. */
function bearishGasOi(at: Date, want: 'BULLISH' | 'BEARISH') {
  const contracts = STRIKES.flatMap((k) => [
    { instrumentId: `${k}CE`, strike: k, optionType: 'CE' as const },
    { instrumentId: `${k}PE`, strike: k, optionType: 'PE' as const },
  ]);
  const rows = [0, 30, 62].flatMap((m) => contracts.map((c) => ({ instrumentId: c.instrumentId, oi: c.optionType === 'CE' ? 1000 : 1000 - m * 5, at: new Date(SESSION.getTime() + m * MIN) })));
  return { at, want, sessionStart: SESSION, chain: { expiry: '2026-12-23', contracts, rows, center: 330, centerSource: 'test' }, futures: null };
}

const gasOption = (strike: number, kind: 'CE' | 'PE', name = 'NATURALGAS', lot = '1250') => ({
  token: `${name}-${strike}${kind}`, symbol: `${name}23DEC26${strike}${kind}`, name, expiry: '23DEC2026', strike: String(strike * 100), lotsize: lot,
  instrumenttype: 'OPTFUT', exch_seg: 'MCX', tick_size: '10',
});

function make(o: { mcxFutures?: () => Promise<unknown[]> } = {}) {
  const repo = {
    impacts: jest.fn(async () => [gasImpact]),
    hubBars: jest.fn(async () => fallingGasBars()),
    tableBars: jest.fn(async () => [] as Bar1m[]),
    openEngineTrades: jest.fn(async () => 0),
    engineTradesSince: jest.fn(async () => 0),
    insertDecision: jest.fn(async () => undefined),
    settleDecision: jest.fn(async () => undefined),
    preOpenOutlook: jest.fn(async () => null),
    openEngineByDirection: jest.fn(async () => ({ bullish: 0, bearish: 0 })),
  };
  const signalRepo = {
    nearestFuture: jest.fn(async () => ({ instrumentId: 'f1', ...NOV })),
    mcxFutures: jest.fn(o.mcxFutures ?? (async () => [NOV, DEC, JAN])),
    hub15mBars: jest.fn(async () => [] as TrendBar[]),
    stored15mBars: jest.fn(async () => [] as TrendBar[]),
  };
  const oi = { input: jest.fn(async (r: { at: Date; signal: { instrumentKind: string } }) => bearishGasOi(r.at, r.signal.instrumentKind === 'PE' ? 'BEARISH' : 'BULLISH')) };
  const paper = { open: jest.fn(async () => ({ ok: true as const, tradeId: 't-ng', entryPrice: 25 })) };
  const clock = { isOpen: jest.fn(() => true), minutesToClose: jest.fn(() => 800) };
  const master = { getInstrumentMaster: jest.fn(async () => [...STRIKES.flatMap((k) => [gasOption(k, 'PE'), gasOption(k, 'CE')]), gasOption(330, 'PE', 'NATGASMINI', '250')]) };
  // The DEC future (the options' own) is at 327.9; the NOV line at ~345; any option prints 25.
  const quotes = { ltp: jest.fn(async (_u: string, token: string) => (token === DEC.token ? 327.9 : token === NOV.token ? 345 : 25)) };
  const svc = new EntryEngineService(
    parseEntryEngineConfig({ ENTRY_ENGINE: 'paper' }),
    { ...parseSignalTraderConfig({}), ownerUserId: 'owner' },
    clock, master, quotes, repo as never, signalRepo as never, oi as never, paper as never,
  );
  return { svc, repo, signalRepo, paper, quotes };
}

describe('NATURALGAS in the entry engine / re-entry watch (2026-11-23)', () => {
  it('is in the engine universe, the re-entry universe and the hub lines — the minis and the illiquid metals are not', () => {
    expect(ENGINE_UNIVERSE).toContain('NATURALGAS');
    expect(REENTRY_UNIVERSE).toContain('NATURALGAS');
    expect(parseLineFutures(undefined)).toContain('NATURALGAS');
    expect(DEFAULT_LINE_FUTURES.split(',')).toHaveLength(8);
    expect(futureExchangeFor('NATURALGAS')).toBe('MCX');
    for (const n of ['NATGASMINI', 'CRUDEOILM', 'GOLDM', 'SILVERM', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD', 'NICKEL']) {
      expect(ENGINE_UNIVERSE as readonly string[]).not.toContain(n);
      expect(REENTRY_UNIVERSE).not.toContain(n);
    }
  });

  it('venue, session, value factor, mini and news key: MCX 09:00, factor 1 (1250 mmBtu lot), NATGASMINI is its mini', () => {
    expect(segmentFor({ underlying: 'NATURALGAS', instrumentKind: 'CE' })).toBe('MCX');
    expect(sessionStartOf('MCX', AT).toISOString()).toBe(SESSION.toISOString());
    expect(contractValueFactor('MCX', 'NATURALGAS23DEC26330PE')).toBe(1);
    expect(mcxUnderlyingOf('NATGASMINI23DEC26330PE')).toBe('NATGASMINI');
    expect(MINI_OF.NATURALGAS).toBe('NATGASMINI');
    expect(watchUnderlying('NATGASMINI')).toBe('NATURALGAS');
    expect(newsKeyFor('NATGASMINI', 'MCX')).toEqual({ key: 'NATURALGAS' });
  });

  it('news: NATURALGAS / NATGASMINI tags and gas headlines count; crude-only energy stories and city-gas companies do not', () => {
    const r = (o: Partial<ImpactRow>) => ({ symbols: [], sectors: [], indexName: null, headline: '', ...o });
    expect(impactConcerns('NATURALGAS', r({ symbols: ['NATURALGAS'] }))).toBe(true);
    expect(impactConcerns('NATURALGAS', r({ symbols: ['NATGASMINI'] }))).toBe(true);
    expect(impactConcerns('NATURALGAS', r({ symbols: ['CRUDEOIL'], sectors: ['MCX ENERGY'] }))).toBe(false);
    expect(impactConcerns('NATURALGAS', r({ sectors: ['MCX ENERGY'], headline: 'Brent rises on OPEC cuts' }))).toBe(false);
    expect(themeMatch('NATURALGAS', r({ sectors: ['MCX ENERGY'], headline: 'Brent rises on OPEC cuts' }))).toBeNull();
    expect(themeMatch('NATURALGAS', r({ headline: 'Henry Hub futures sink on mild weather' }))).toBe('HEADLINE');
    expect(headlineAbout('NATURALGAS', 'Natural gas prices fall 5% as storage builds')).toBe(true);
    expect(headlineAbout('NATURALGAS', 'Gujarat Gas Q2 profit rises; city gas volumes up')).toBe(false);
    expect(headlineAbout('NATURALGAS', 'Petronet LNG shares rise')).toBe(false);
    expect(headlineAbout('NATURALGAS', 'Petronet LNG flags lower imports as Henry Hub prices jump')).toBe(true);
    // Crude's own match is unchanged by the gas entry.
    expect(headlineAbout('CRUDEOIL', 'Natural gas prices fall 5%')).toBe(false);
  });

  it('end to end (paper): reads the NOV line, decides ENTER_PE, and buys the ATM of the DEC options centred on the DEC future', async () => {
    const { svc, repo, signalRepo, paper, quotes } = make();
    const r = await svc.evaluate('NATURALGAS', AT);
    expect(r).toMatchObject({ underlying: 'NATURALGAS', action: 'ENTER_PE', opened: 't-ng' });
    // The price line is the nearest future (pinned by the hub).
    expect(repo.hubBars).toHaveBeenCalledWith('MCX', NOV.token, expect.any(Date), AT);
    const row = (repo.insertDecision.mock.calls[0] as unknown as [{ underlying: string; mode: string; inputs: { trend: { barSource: string; line: { token: string } }; news: { lean: string }; oi: { verdict: string } } }])[0];
    expect(row).toMatchObject({ underlying: 'NATURALGAS', mode: 'paper' });
    expect(row.inputs.trend).toMatchObject({ barSource: 'candles_1m', line: { token: NOV.token } });
    expect(row.inputs.news.lean).toBe('BEARISH');
    expect(row.inputs.oi.verdict).toBe('AGREES');
    // ATM: the DEC future 327.9 → 330 (the NOV line ~345 would have picked 345).
    expect(signalRepo.mcxFutures).toHaveBeenCalledWith('NATURALGAS', expect.any(Date));
    expect(quotes.ltp).toHaveBeenCalledWith('owner', DEC.token, 'MCX');
    const arg = (paper.open.mock.calls[0] as unknown as [{ plan: { tradingsymbol: string; qty: number; lots: number }; kind: string; strike: number; expiry: string }])[0];
    expect(arg).toMatchObject({ kind: 'PE', strike: 330, plan: { tradingsymbol: 'NATURALGAS23DEC26330PE', lots: 1, qty: 1250 } });
    expect(repo.settleDecision).toHaveBeenCalledWith(expect.any(String), 't-ng', expect.stringContaining('ATM on NATURALGAS28DEC26FUT 327.9'));
  });

  it('the futures list unreadable: ATM on the line price, noted, still opened', async () => {
    const { svc, paper, repo } = make({ mcxFutures: async () => { throw new Error('db down'); } });
    expect((await svc.evaluate('NATURALGAS', AT)).opened).toBe('t-ng');
    expect((paper.open.mock.calls[0] as unknown as [{ strike: number }])[0].strike).toBe(345);
    expect(repo.settleDecision).toHaveBeenCalledWith(expect.any(String), 't-ng', expect.stringContaining('option future unreadable (db down); ATM on the line price'));
  });
});

describe('optionFutureSpot', () => {
  const futures = async () => [NOV, DEC, JAN];
  it('MCX: the future the expiry is written on (earliest expiring on/after it), priced by its LTP', async () => {
    const ltp = jest.fn(async (t: string) => (t === DEC.token ? 327.9 : 999));
    expect(await optionFutureSpot({ exchange: 'MCX', expiry: '2026-12-23', spot: 345, futures, ltp })).toEqual({ spot: 327.9, note: 'ATM on NATURALGAS28DEC26FUT 327.9 (the options\' own future)' });
    expect(ltp).toHaveBeenCalledWith(DEC.token, 'MCX');
  });
  it('no LTP / no future / unreadable list ⇒ the line price with a note; never throws', async () => {
    expect(await optionFutureSpot({ exchange: 'MCX', expiry: '2026-12-23', spot: 345, futures, ltp: async () => null })).toEqual({ spot: 345, note: 'no LTP for NATURALGAS28DEC26FUT; ATM on the line price' });
    expect(await optionFutureSpot({ exchange: 'MCX', expiry: '2026-12-23', spot: 345, futures, ltp: async () => { throw new Error('throttled'); } })).toEqual({ spot: 345, note: 'no LTP for NATURALGAS28DEC26FUT; ATM on the line price' });
    expect((await optionFutureSpot({ exchange: 'MCX', expiry: '2027-03-23', spot: 345, futures, ltp: async () => 1 })).note).toBe('no future for the 2027-03-23 options; ATM on the line price');
    expect((await optionFutureSpot({ exchange: 'MCX', expiry: '2026-12-23', spot: 345, futures: async () => { throw new Error('x'); }, ltp: async () => 1 })).spot).toBe(345);
  });
  it('NFO / BFO: unchanged, no reads', async () => {
    const f = jest.fn(futures);
    const ltp = jest.fn(async () => 1);
    expect(await optionFutureSpot({ exchange: 'NFO', expiry: '2026-11-25', spot: 24400, futures: f, ltp })).toEqual({ spot: 24400, note: null });
    expect(f).not.toHaveBeenCalled();
    expect(ltp).not.toHaveBeenCalled();
  });
});
