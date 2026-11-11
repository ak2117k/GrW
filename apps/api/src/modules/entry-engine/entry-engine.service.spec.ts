import { parseSignalTraderConfig } from '../signal-trader/domain/signal-trader.config';
import { PAPER_WATCH_STRATEGIES } from '../signal-trader/domain/paper';
import { ISOLATED_PAPER_STRATEGIES } from '../trade-engine/services/risk-manager.service';
import type { TrendBar } from '../signal-trader/domain/trend-tag';
import type { Bar1m, ImpactRow } from './domain/entry-decision';
import type { PreOpenBiasInput } from './domain/news-paths';
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

function make(o: { mode?: EntryEngineMode; open?: number; today?: number; minutesToClose?: number; oiFails?: boolean; impacts?: ImpactRow[]; preOpen?: PreOpenBiasInput | null; events?: { listFrom: (from: Date) => Promise<unknown[]> }; bars15?: TrendBar[]; clusterOpen?: { bullish: number; bearish: number } } = {}) {
  const repo = {
    impacts: jest.fn(async () => o.impacts ?? [bearImpact]),
    hubBars: jest.fn(async () => [] as Bar1m[]),
    tableBars: jest.fn(async () => fallingBars()),
    openEngineTrades: jest.fn(async () => o.open ?? 0),
    engineTradesSince: jest.fn(async () => o.today ?? 0),
    insertDecision: jest.fn(async () => undefined),
    settleDecision: jest.fn(async () => undefined),
    preOpenOutlook: jest.fn(async () => o.preOpen ?? null),
    openEngineByDirection: jest.fn(async () => o.clusterOpen ?? { bullish: 0, bearish: 0 }),
  };
  const signalRepo = {
    nearestFuture: jest.fn(async () => ({ instrumentId: 'f1', symbol: 'CRUDEOIL19NOV26FUT', exchange: 'MCX', token: '573422' })),
    hub15mBars: jest.fn(async () => o.bars15 ?? []),
    stored15mBars: jest.fn(async () => [] as TrendBar[]),
  };
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
    o.events as never,
  );
  return { svc, repo, paper, oi, quotes };
}

describe('EntryEngineService', () => {
  it('2026-11-04: an event day affecting the underlying is in the decision reasons and inputs; an unreadable calendar says absent', async () => {
    const midterm = { id: 'e1', source: 'macro', kind: 'us_election', title: 'US midterm election results', scope: 'GLOBAL', impact: 'high', startsAt: new Date('2026-10-29T01:30:00Z') };
    const { svc, repo } = make({ events: { listFrom: async () => [midterm] } });
    await svc.evaluate('CRUDEOIL', AT);
    const row = (repo.insertDecision.mock.calls[0] as unknown as [{ inputs: { event?: { status: string } }; reasons: string[] }])[0];
    expect(row.inputs.event?.status).toBe('present');
    expect(row.reasons.some((x) => x.startsWith('event: US midterm election results') && x.includes('big move expected'))).toBe(true);

    const down = make({ events: { listFrom: async () => { throw new Error('db down'); } } });
    await down.svc.evaluate('CRUDEOIL', AT);
    const r2 = (down.repo.insertDecision.mock.calls[0] as unknown as [{ reasons: string[] }])[0];
    expect(r2.reasons.some((x) => x.startsWith('event: absent — the events calendar could not be read (db down)'))).toBe(true);

    // No calendar wired: today's reasons, no event line.
    const none = make();
    await none.svc.evaluate('CRUDEOIL', AT);
    expect((none.repo.insertDecision.mock.calls[0] as unknown as [{ reasons: string[] }])[0].reasons.some((x) => x.startsWith('event:'))).toBe(false);
  });

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

  it('PRE_OPEN path: no news, but a strong pre-open BEARISH outlook in the opening window + bearish trend + OI → ENTER_PE (path recorded); outside the window → NO_TRADE', async () => {
    const preOpen: PreOpenBiasInput = { underlying: 'CRUDEOIL', sessionDate: '2026-10-29', bias: 'BEARISH', confidence: 0.75, at: '2026-10-29T03:00:00.000Z', summary: 'CRUDEOIL BEARISH: CL=F -3.2%' };
    const a = make({ impacts: [], preOpen });
    const r = await a.svc.evaluate('CRUDEOIL', AT); // 10:05 IST = 09:20 + 45 min, the last run of the opening window
    expect(r.action).toBe('ENTER_PE');
    expect(a.repo.preOpenOutlook).toHaveBeenCalledWith('CRUDEOIL', '2026-10-29');
    const row = (a.repo.insertDecision.mock.calls[0] as unknown as [{ reasons: string[]; inputs: { scores: { newsMaterialPath: string } } }])[0];
    expect(row.reasons[0]).toContain('material via PRE_OPEN');
    expect(row.inputs.scores.newsMaterialPath).toBe('PRE_OPEN');
    const b = make({ impacts: [], preOpen });
    const late = await b.svc.evaluate('CRUDEOIL', new Date('2026-10-29T04:50:00Z')); // 10:20 IST
    expect(late.action).toBe('NO_TRADE');
    const lateRow = (b.repo.insertDecision.mock.calls[0] as unknown as [{ reasons: string[] }])[0];
    expect(lateRow.reasons[0]).toMatch(/^news: NO_DATA/);
  });

  it('first cycle after the open with no trend series / OI snapshot yet: NO_TRADE recorded as INPUT_NOT_READY, nothing opened', async () => {
    const { svc, repo, paper } = make({ mode: 'paper' });
    const r = await svc.evaluate('CRUDEOIL', new Date(SESSION.getTime() + 5 * MIN)); // MCX 09:05 IST: 5 session bars, one OI snapshot
    expect(r.action).toBe('NO_TRADE');
    expect(paper.open).not.toHaveBeenCalled();
    const row = (repo.insertDecision.mock.calls[0] as unknown as [{ action: string; inputs: { readiness?: { status: string; missing: string[] } }; reasons: string[] }])[0];
    expect(row.action).toBe('NO_TRADE');
    expect(row.inputs.readiness).toEqual({ status: 'INPUT_NOT_READY', missing: expect.arrayContaining(['trend']) });
    expect(row.reasons[0]).toMatch(/^INPUT_NOT_READY/);
    // A normal cycle carries no readiness marker.
    const ok = make();
    await ok.svc.evaluate('CRUDEOIL', AT);
    expect((ok.repo.insertDecision.mock.calls[0] as unknown as [{ inputs: { readiness?: unknown } }])[0].inputs.readiness).toBeUndefined();
  });

  /** 24 completed 15m session bars on 2026-10-28 (09:15–15:00 IST) with high − low = `range` → N15 = range. */
  const bars15 = (range: number): TrendBar[] =>
    Array.from({ length: 24 }, (_, i) => ({ ts: new Date('2026-10-28T03:45:00Z').getTime() + i * 15 * MIN, open: 9_800, high: 9_800 + range / 2, low: 9_800 - range / 2, close: 9_800 }));

  it('2026-11-11 entry gates: readings recorded on the decision and in the paper trade summary; a wide N15 lets the ENTER through', async () => {
    const { svc, repo, paper } = make({ mode: 'paper', bars15: bars15(100) });
    const r = await svc.evaluate('CRUDEOIL', AT);
    expect(r).toMatchObject({ action: 'ENTER_PE', opened: 't1' });
    const row = (repo.insertDecision.mock.calls[0] as unknown as [{ action: string; inputs: { gates: { direction: string; preGateAction: string; extension: { n15: number; fromSwingN15: number }; indicators: { tag: string }; verdicts: Record<string, string | null> } }; reasons: string[] }])[0];
    expect(row.action).toBe('ENTER_PE');
    expect(row.inputs.gates).toMatchObject({ direction: 'BEARISH', preGateAction: 'ENTER_PE', indicators: { tag: 'UNKNOWN' }, extension: { n15: 100 }, verdicts: { indicators: 'UNKNOWN', chase: 'PASS', cluster: null } });
    expect(row.inputs.gates.extension.fromSwingN15).toBeLessThan(1);
    expect(row.reasons.some((x) => x.startsWith('indicators: ? '))).toBe(true);
    expect(row.reasons.some((x) => x.startsWith('chase: ✓ '))).toBe(true);
    const why = (paper.open.mock.calls[0] as unknown as [{ why: string }])[0].why;
    expect(why).toMatch(/^news: .*; trend: .*; oi: .*; indicators: \? UNKNOWN, MACD n\/a, RSI 50; chase: ✓ 0\.\d+ N15 off the 30-min high, .* N15 past EMA20$/);
  });

  it('2026-11-11 chase gate: the same ENTER after a run of many N15 is WAIT — recorded, nothing opened, a later scan may still enter', async () => {
    const { svc, repo, paper } = make({ mode: 'paper', bars15: bars15(4) });
    const r = await svc.evaluate('CRUDEOIL', AT);
    expect(r).toMatchObject({ action: 'WAIT', opened: null });
    expect(paper.open).not.toHaveBeenCalled();
    expect(repo.settleDecision).not.toHaveBeenCalled();
    const row = (repo.insertDecision.mock.calls[0] as unknown as [{ action: string; inputs: { gates: { preGateAction: string; verdicts: { chase: string } } }; reasons: string[] }])[0];
    expect(row).toMatchObject({ action: 'WAIT', inputs: { gates: { preGateAction: 'ENTER_PE', verdicts: { chase: 'WAIT' } } } });
    expect(row.reasons.find((x) => x.startsWith('chase: WAIT'))).toContain('already extended');
  });

  it('a failed 15m read never blocks: the gates read UNKNOWN and the reason says why', async () => {
    const { svc, repo } = make({ mode: 'observe' });
    (svc as unknown as { signalRepo: { hub15mBars: jest.Mock } }).signalRepo.hub15mBars.mockRejectedValueOnce(new Error('db down'));
    expect((await svc.evaluate('CRUDEOIL', AT)).action).toBe('ENTER_PE');
    const row = (repo.insertDecision.mock.calls[0] as unknown as [{ inputs: { gates: { unread: string } }; reasons: string[] }])[0];
    expect(row.inputs.gates.unread).toContain('db down');
  });

  describe('index cluster (NIFTY / BANKNIFTY / SENSEX … one bet)', () => {
    const niftyImpact: ImpactRow = { ...bearImpact, clusterId: 'n1', symbols: ['NIFTY'], headline: 'Index slides' };
    it('an open bearish engine position anywhere in the cluster blocks a new PE (recorded as a cooldown, decision stays ENTER)', async () => {
      const { svc, repo, paper } = make({ mode: 'paper', impacts: [niftyImpact], bars15: bars15(100), clusterOpen: { bullish: 0, bearish: 1 } });
      const r = await svc.evaluate('NIFTY', AT);
      expect(r).toMatchObject({ action: 'ENTER_PE', opened: null });
      expect(paper.open).not.toHaveBeenCalled();
      expect(repo.settleDecision).toHaveBeenCalledWith(expect.any(String), null, expect.stringContaining('cluster: ✗ 1 bearish open'));
      const row = (repo.insertDecision.mock.calls[0] as unknown as [{ inputs: { guards: { ok: boolean; cluster: { verdict: string } } } }])[0];
      expect(row.inputs.guards).toMatchObject({ ok: false, cluster: { verdict: 'BLOCK' } });
    });

    it('one new cluster entry per scan pass; a bullish position does not block a PE', async () => {
      const { svc, paper, repo } = make({ mode: 'paper', impacts: [niftyImpact], bars15: bars15(100), clusterOpen: { bullish: 1, bearish: 0 } });
      const r = await svc.evaluate('NIFTY', AT, { clusterEntered: ['BANKNIFTY'] });
      expect(r.opened).toBeNull();
      expect(paper.open).not.toHaveBeenCalled();
      expect(repo.settleDecision).toHaveBeenCalledWith(expect.any(String), null, expect.stringContaining('BANKNIFTY already entered for the index cluster in this scan'));
    });

    it('MCX underlyings are not in the cluster (no cluster read)', async () => {
      const { svc, repo } = make({ mode: 'paper', bars15: bars15(100), clusterOpen: { bullish: 0, bearish: 5 } });
      expect((await svc.evaluate('CRUDEOIL', AT)).opened).toBe('t1');
      expect(repo.openEngineByDirection).not.toHaveBeenCalled();
    });
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
