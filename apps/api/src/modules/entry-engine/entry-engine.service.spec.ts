import { parseSignalTraderConfig } from '../signal-trader/domain/signal-trader.config';
import { PAPER_WATCH_STRATEGIES } from '../signal-trader/domain/paper';
import { ISOLATED_PAPER_STRATEGIES } from '../trade-engine/services/risk-manager.service';
import type { Bar1m, ImpactRow } from './domain/entry-decision';
import { ENGINE_ENTRY_SOURCE, ENGINE_ENTRY_STRATEGY, parseEntryEngineConfig, type EntryEngineMode } from './entry-engine.config';
import { EntryEnginePaperService, enginePaperDto } from './entry-engine-paper.service';
import { EntryEngineService } from './entry-engine.service';

const MIN = 60_000;
const AT = new Date('2026-10-29T04:35:00Z'); // 10:05 IST
const SESSION = new Date('2026-10-29T03:30:00Z'); // MCX 09:00 IST

/** Two falling sessions of 1m bars (BEARISH trend) ending just before AT. */
function fallingBars(): Bar1m[] {
  const out: Bar1m[] = [];
  const mk = (ts: number, c: number, i: number) => out.push({ ts, open: c, high: c + 1, low: c - 1, close: c, volume: 100 + ((i * 37) % 11) });
  for (let i = 0; i < 840; i++) mk(SESSION.getTime() - 24 * 60 * MIN + i * MIN, 10_000 - i * 0.2, i);
  for (let i = 0; i < 65; i++) mk(SESSION.getTime() + i * MIN, 9_800 - i, i);
  return out;
}

const bearImpact: ImpactRow = {
  clusterId: 'c1', analysedAt: new Date(AT.getTime() - 5 * MIN), firstSeen: new Date(AT.getTime() - 130 * MIN), direction: 'BEAR', magnitude: 'MED',
  confidence: 0.5, pricedIn: false, symbols: ['CRUDEOIL'], sectors: [], indexName: null, material: false, materialType: 'NEWS', headline: 'Crude dips',
};

/** A chain whose put OI unwinds (bearish lean) through the session. */
function bearishOiInput(at: Date, want: 'BULLISH' | 'BEARISH') {
  const contracts = [9500, 9550, 9600, 9650, 9700, 9750, 9800].flatMap((k) => [
    { instrumentId: `${k}CE`, strike: k, optionType: 'CE' as const },
    { instrumentId: `${k}PE`, strike: k, optionType: 'PE' as const },
  ]);
  const rows = [0, 30, 62].flatMap((m) =>
    contracts.map((c) => ({ instrumentId: c.instrumentId, oi: c.optionType === 'CE' ? 1000 : 1000 - m * 5, at: new Date(SESSION.getTime() + m * MIN) })),
  );
  return { at, want, sessionStart: SESSION, chain: { expiry: '2026-11-17', contracts, rows, center: 9650, centerSource: 'test' }, futures: null };
}

function make(o: { mode?: EntryEngineMode; open?: number; today?: number; minutesToClose?: number; oiFails?: boolean; impacts?: ImpactRow[] } = {}) {
  const repo = {
    impacts: jest.fn(async () => o.impacts ?? [bearImpact]),
    hubBars: jest.fn(async () => [] as Bar1m[]),
    tableBars: jest.fn(async () => fallingBars()),
    openEngineTrades: jest.fn(async () => o.open ?? 0),
    engineTradesSince: jest.fn(async () => o.today ?? 0),
    insertDecision: jest.fn(async () => undefined),
    settleDecision: jest.fn(async () => undefined),
  };
  const signalRepo = { nearestFuture: jest.fn(async () => ({ instrumentId: 'f1', symbol: 'CRUDEOIL19NOV26FUT', exchange: 'MCX', token: '573422' })) };
  const oi = {
    input: jest.fn(async (r: { at: Date; signal: { instrumentKind: string } }) => {
      if (o.oiFails) throw new Error('db down');
      return bearishOiInput(r.at, r.signal.instrumentKind === 'PE' ? 'BEARISH' : 'BULLISH');
    }),
  };
  const paper = { open: jest.fn(async () => ({ ok: true as const, tradeId: 't1', entryPrice: 250 })) };
  const clock = { isOpen: jest.fn(() => true), minutesToClose: jest.fn(() => o.minutesToClose ?? 800) };
  const master = {
    getInstrumentMaster: jest.fn(async () => [
      { token: '7', symbol: 'CRUDEOIL17NOV269650PE', name: 'CRUDEOIL', expiry: '17NOV2026', strike: '965000', lotsize: '100', instrumenttype: 'OPTFUT', exch_seg: 'MCX', tick_size: '10' },
    ]),
  };
  const quotes = { ltp: jest.fn(async () => 250) };
  const svc = new EntryEngineService(
    parseEntryEngineConfig({ ENTRY_ENGINE: o.mode ?? 'observe' }),
    { ...parseSignalTraderConfig({}), ownerUserId: 'owner' },
    clock,
    master,
    quotes,
    repo as never,
    signalRepo as never,
    oi as never,
    paper as never,
  );
  return { svc, repo, paper, oi, quotes };
}

describe('EntryEngineService', () => {
  it('observe (the default): records the ENTER_PE decision with its inputs and reasons, opens NOTHING', async () => {
    expect(parseEntryEngineConfig({}).mode).toBe('observe');
    const { svc, repo, paper, quotes } = make();
    const r = await svc.evaluate('CRUDEOIL', AT);
    expect(r).toMatchObject({ action: 'ENTER_PE', opened: null });
    expect(repo.insertDecision).toHaveBeenCalledTimes(1);
    const row = (repo.insertDecision.mock.calls[0] as unknown as [{ action: string; mode: string; inputs: { news: unknown; trend: unknown; oi: { verdict: string } }; reasons: string[] }])[0];
    expect(row).toMatchObject({ action: 'ENTER_PE', mode: 'observe' });
    expect(row.inputs.oi.verdict).toBe('AGREES');
    expect(row.reasons.length).toBeGreaterThanOrEqual(3);
    expect(paper.open).not.toHaveBeenCalled();
    expect(quotes.ltp).not.toHaveBeenCalled();
  });

  it('every NO_TRADE is recorded too (no news → NO_TRADE)', async () => {
    const { svc, repo, paper } = make({ mode: 'paper', impacts: [] });
    const r = await svc.evaluate('CRUDEOIL', AT);
    expect(r.action).toBe('NO_TRADE');
    expect(repo.insertDecision).toHaveBeenCalledTimes(1);
    expect(paper.open).not.toHaveBeenCalled();
  });

  it('an OI read failure is NO_DATA → NO_TRADE (recorded)', async () => {
    const { svc, repo, paper } = make({ mode: 'paper', oiFails: true });
    expect((await svc.evaluate('CRUDEOIL', AT)).action).toBe('NO_TRADE');
    expect(repo.insertDecision).toHaveBeenCalledTimes(1);
    expect(paper.open).not.toHaveBeenCalled();
  });

  it('paper: an ENTER that passes the cooldowns opens a paper trade on the ATM PE at the plan LTP, and the decision row gets its trade id', async () => {
    const { svc, repo, paper } = make({ mode: 'paper' });
    const r = await svc.evaluate('CRUDEOIL', AT);
    expect(r).toMatchObject({ action: 'ENTER_PE', opened: 't1' });
    const arg = (paper.open.mock.calls[0] as unknown as [{ plan: { tradingsymbol: string; ltp: number; qty: number; lots: number }; kind: string; strike: number }])[0];
    expect(arg).toMatchObject({ kind: 'PE', strike: 9650, plan: { tradingsymbol: 'CRUDEOIL17NOV269650PE', ltp: 250, lots: 1, qty: 100 } });
    expect(repo.settleDecision).toHaveBeenCalledWith(expect.any(String), 't1', expect.stringMatching(/^paper: opened/));
  });

  it('paper cooldowns block the open (recorded): one open per underlying, three a day, not in the last 30 min', async () => {
    for (const o of [{ open: 1 }, { today: 3 }, { minutesToClose: 25 }]) {
      const { svc, repo, paper } = make({ mode: 'paper', ...o });
      const r = await svc.evaluate('CRUDEOIL', AT);
      expect(r).toMatchObject({ action: 'ENTER_PE', opened: null });
      expect(paper.open).not.toHaveBeenCalled();
      expect(repo.settleDecision).toHaveBeenCalledWith(expect.any(String), null, expect.stringMatching(/^paper: not opened/));
    }
  });

  it('off: run() does nothing; outside 09:20–23:00 IST nothing is evaluated', async () => {
    const off = make({ mode: 'off' });
    expect(await off.svc.run(AT)).toEqual([]);
    expect(off.repo.insertDecision).not.toHaveBeenCalled();
    const early = make({ mode: 'paper' });
    expect(await early.svc.run(new Date('2026-10-29T03:40:00Z'))).toEqual([]); // 09:10 IST
    expect(early.repo.insertDecision).not.toHaveBeenCalled();
  });
});

describe('engine paper trade', () => {
  const plan = {
    exchange: 'MCX', token: '7', tradingsymbol: 'CRUDEOIL17NOV269650PE', lotSize: 100, tickSize: 0.1, side: 'BUY' as const, ltp: 250, bandLow: 242.5, bandHigh: 257.5,
    limitPrice: 251.2, sl: 187.5, slSource: 'signal' as const, targets: [375], lots: 1, qty: 100, riskRupees: 6370,
  };
  const input = { decisionId: 'd1', plan, underlying: 'CRUDEOIL', kind: 'PE' as const, strike: 9650, expiry: '2026-11-17', why: 'news ✓; trend ✓; oi ✓' };

  it('the DTO is paper (isPaper true), ENGINE_ENTRY, at the plan LTP (never the marketable limit), tagged engine + decision + underlying', () => {
    const dto = enginePaperDto(input) as unknown as Record<string, unknown>;
    expect(dto).toMatchObject({ isPaper: true, strategy: ENGINE_ENTRY_STRATEGY, source: ENGINE_ENTRY_SOURCE, price: 250, orderType: 'MARKET', quantity: 100, side: 'BUY', positionType: 'INTRADAY', stoploss: 187.5, target: 375 });
    expect(dto.entryTags).toEqual(['entry-engine', 'decision:d1', 'underlying:CRUDEOIL']);
  });

  it('open() goes through TradeExecutionService.executeTrade with isPaper: true', async () => {
    const exec = { executeTrade: jest.fn(async () => ({ id: 't9', entryPrice: 250.4, status: 'OPEN' })) };
    const trades = { findInstrumentId: jest.fn(async () => null) };
    const instruments = { upsertInstrument: jest.fn(async () => undefined) };
    const svc = new EntryEnginePaperService(exec as never, trades as never, instruments as never);
    expect(await svc.open(input)).toEqual({ ok: true, tradeId: 't9', entryPrice: 250.4 });
    expect(exec.executeTrade).toHaveBeenCalledWith(expect.objectContaining({ isPaper: true, strategy: 'ENGINE_ENTRY' }));
    expect(instruments.upsertInstrument).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'CRUDEOIL17NOV269650PE', optionType: 'PE', strike: 9650, name: 'CRUDEOIL' }));
  });

  it('a failed paper open is a reason, never a throw', async () => {
    const exec = { executeTrade: jest.fn(async () => { throw new Error('Trade rejected: Max concurrent positions reached'); }) };
    const svc = new EntryEnginePaperService(exec as never, { findInstrumentId: jest.fn(async () => 'i1') } as never, {} as never);
    expect(await svc.open(input)).toEqual({ ok: false, reason: 'Trade rejected: Max concurrent positions reached' });
  });

  it('engine paper trades join the paper watch (→ paper sentinel AI exits) and have their own paper position pool', () => {
    expect(PAPER_WATCH_STRATEGIES).toContain(ENGINE_ENTRY_STRATEGY);
    expect(ISOLATED_PAPER_STRATEGIES.has(ENGINE_ENTRY_STRATEGY)).toBe(true);
  });
});
