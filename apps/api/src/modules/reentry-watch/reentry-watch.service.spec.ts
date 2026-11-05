import { readFileSync } from 'fs';
import { join } from 'path';
import type { Bar1m } from '../entry-engine/domain/entry-decision';
import { enginePaperDto, type EnginePaperInput } from '../entry-engine/entry-engine-paper.service';
import { PAPER_WATCH_STRATEGIES } from '../signal-trader/domain/paper';
import { parseSignalTraderConfig } from '../signal-trader/domain/signal-trader.config';
import { ISOLATED_PAPER_STRATEGIES } from '../trade-engine/services/risk-manager.service';
import { bankNiftyBars, istTs, niftyBars, niftyReversalBars } from './domain/reentry-fixtures';
import type { ExitedPosition } from './domain/reentry-rules';
import { parseReentryWatchConfig, REENTRY_STRATEGY, type ReentryWatchMode } from './reentry-watch.config';
import { ReentryWatchService } from './reentry-watch.service';

const MIN = 60_000;
const DAY = '2026-11-05';

const niftyExit: ExitedPosition = {
  refTable: 'trades', refId: 'p-nifty', origin: 'SIGNAL_PAPER', symbol: 'NIFTY09NOV2624400CE', exchange: 'NFO', underlying: 'NIFTY',
  kind: 'CE', side: 'BUY', entryAt: new Date(istTs(DAY, '09:40')), exitAt: new Date(istTs(DAY, '10:01')), exitPrice: 147.15,
};
const bankExit: ExitedPosition = {
  refTable: 'trades', refId: 'p-bank', origin: 'ENGINE_PAPER', symbol: 'BANKNIFTY23NOV2656900CE', exchange: 'NFO', underlying: 'BANKNIFTY',
  kind: 'CE', side: 'BUY', entryAt: new Date(istTs(DAY, '09:35')), exitAt: new Date(istTs(DAY, '10:07')), exitPrice: 745.75,
};

/** Scrip-master rows (strike ×100, as Angel ships them) for the nearest non-expiry-day series. */
function masterRows() {
  const rows: Record<string, string>[] = [];
  const add = (name: string, expiry: string, ddmmmyy: string, strikes: number[], lot: string) => {
    for (const k of strikes) for (const kind of ['CE', 'PE']) {
      rows.push({ token: `${name}${k}${kind}`, symbol: `${name}${ddmmmyy}${k}${kind}`, name, expiry, strike: String(k * 100), lotsize: lot, instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5' });
    }
  };
  add('NIFTY', '10NOV2026', '10NOV26', [24100, 24150, 24200, 24250, 24300, 24350, 24400, 24450, 24500, 24550], '75');
  add('BANKNIFTY', '25NOV2026', '25NOV26', [56800, 56900, 57000, 57100, 57200], '35');
  return rows;
}

function make(o: { mode?: ReentryWatchMode; exits?: ExitedPosition[]; bars?: Bar1m[]; today?: number; oiFails?: boolean } = {}) {
  const bars = o.bars ?? niftyBars();
  let opened = 0;
  const repo = {
    exitsSince: jest.fn(async () => o.exits ?? [niftyExit]),
    reentriesSince: jest.fn(async () => (o.today ?? 0) + opened),
    openOnUnderlying: jest.fn(async () => opened),
    reentriesOf: jest.fn(async () => ({ count: opened, lastExitAt: null })),
    insertDecision: jest.fn(async () => undefined),
    settleDecision: jest.fn(async () => undefined),
  };
  const engineRepo = {
    hubBars: jest.fn(async () => [] as Bar1m[]),
    tableBars: jest.fn(async (_e: string, _t: string, from: Date, to: Date) => bars.filter((b) => b.ts >= from.getTime() && b.ts <= to.getTime())),
    strikeLiquidity: jest.fn(async () => new Map()),
  };
  const signalRepo = { nearestFuture: jest.fn(async () => null) };
  const oi = { input: jest.fn(async () => { throw new Error('no chain'); }) };
  const paper = {
    open: jest.fn(async (_i: EnginePaperInput) => {
      opened++;
      return { ok: true as const, tradeId: `t${opened}`, entryPrice: 150 };
    }),
  };
  const clock = { isOpen: jest.fn(() => true), minutesToClose: jest.fn((_x: string, at?: Date) => Math.round((istTs(DAY, '15:30') - (at ?? new Date()).getTime()) / MIN)) };
  const master = { getInstrumentMaster: jest.fn(async () => masterRows()) };
  const quotes = { ltp: jest.fn(async () => 150) };
  const alert = jest.fn(async () => true);
  const svc = new ReentryWatchService(
    parseReentryWatchConfig({ REENTRY_WATCH: o.mode ?? 'paper' }),
    { ...parseSignalTraderConfig({}), ownerUserId: 'owner' },
    clock, master, quotes, repo as never, engineRepo as never, signalRepo as never, oi as never, paper as never, alert,
  );
  return { svc, repo, paper, alert, quotes };
}

/** Run the cron every 2 min from `from` to `to` IST. */
async function session(svc: ReentryWatchService, from: string, to: string) {
  for (let t = istTs(DAY, from); t <= istTs(DAY, to); t += 2 * MIN) await svc.run(new Date(t));
}

const firstOpen = (paper: { open: jest.Mock }) => paper.open.mock.calls[0][0] as EnginePaperInput;

describe('ReentryWatchService', () => {
  it('REENTRY_WATCH defaults to paper; off ⇒ the watch reads and opens nothing', async () => {
    expect(parseReentryWatchConfig({}).mode).toBe('paper');
    expect(parseReentryWatchConfig({ REENTRY_WATCH: 'live' })).toMatchObject({ mode: 'paper' });
    const { svc, repo, paper, alert } = make({ mode: 'off' });
    expect(await svc.run(new Date(istTs(DAY, '11:00')))).toEqual([]);
    await svc.tick();
    expect(repo.exitsSince).not.toHaveBeenCalled();
    expect(repo.insertDecision).not.toHaveBeenCalled();
    expect(paper.open).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('2026-11-05 NIFTY09NOV2624400CE exit 10:01: one SAME re-entry (paper CE, REENTRY_WATCH) + Telegram, rows only on change', async () => {
    const { svc, repo, paper, alert } = make();
    await session(svc, '10:03', '13:00');
    expect(paper.open).toHaveBeenCalledTimes(1);
    const i = firstOpen(paper);
    expect(i).toMatchObject({ underlying: 'NIFTY', kind: 'CE', expiry: '2026-11-10' });
    expect(i.plan.tradingsymbol).toMatch(/^NIFTY10NOV2624[45]\d0CE$/);
    expect(i.brand).toMatchObject({ strategy: REENTRY_STRATEGY, source: 'reentry-watch / paper' });
    expect(i.brand!.tags).toEqual(expect.arrayContaining(['reentry-watch', 'underlying:NIFTY', 'reentry-of:trades:p-nifty', 'reentry:same']));
    expect(alert).toHaveBeenCalledTimes(1);
    expect((alert.mock.calls[0] as unknown as [string, string])[1]).toMatch(/^Re-entry \(paper\): NIFTY CE same direction — NIFTY [\d,.]+ back above the 10:01 exit point [\d,.]+ with the trend bullish; bought NIFTY10NOV26\d+CE @ 150$/);
    const rows = repo.insertDecision.mock.calls.map((c) => (c as unknown as [{ action: string; category: string; at: Date }])[0]);
    expect(rows[0].category).toBe('cooldown');
    const sig = rows.find((r) => r.action === 'SIGNAL')!;
    expect(sig.category).toBe('signal-same');
    expect(sig.at.getTime()).toBeGreaterThanOrEqual(istTs(DAY, '10:11'));
    // Category changes only (90 ticks → a handful of rows); after the open the watch waits on the open position.
    expect(rows.length).toBeLessThan(15);
    expect(rows[rows.indexOf(sig) + 1]?.category).toBe('position-open');
    expect(repo.settleDecision).toHaveBeenCalledWith(expect.any(String), 't1', expect.stringContaining('paper: opened NIFTY10NOV26'), expect.objectContaining({ exchange: 'NFO' }));
  });

  it('2026-11-05 BANKNIFTY23NOV2656900CE exit 10:07: SAME re-entry once the index resumes up', async () => {
    const { svc, paper, alert } = make({ exits: [bankExit], bars: bankNiftyBars() });
    await session(svc, '10:09', '13:43');
    expect(paper.open).toHaveBeenCalledTimes(1);
    expect(firstOpen(paper)).toMatchObject({ underlying: 'BANKNIFTY', kind: 'CE' });
    expect((alert.mock.calls[0] as unknown as [string, string])[1]).toContain('Re-entry (paper): BANKNIFTY CE same direction');
  });

  it('reversal: the CE exit, then the index falls ⇒ OPPOSITE re-entry buys a PE (OI unreadable does not block)', async () => {
    const { svc, paper, alert } = make({ bars: niftyReversalBars() });
    await session(svc, '10:03', '14:00');
    expect(paper.open).toHaveBeenCalledTimes(1);
    const i = firstOpen(paper);
    expect(i.kind).toBe('PE');
    expect(i.brand!.tags).toContain('reentry:opposite');
    expect((alert.mock.calls[0] as unknown as [string, string])[1]).toContain('NIFTY PE opposite direction');
  });

  it('the daily cap: 5 re-entries already today ⇒ recorded as CAP once, nothing opened', async () => {
    const { svc, repo, paper } = make({ today: 5 });
    await session(svc, '10:03', '12:00');
    expect(paper.open).not.toHaveBeenCalled();
    const cats = repo.insertDecision.mock.calls.map((c) => (c as unknown as [{ category: string }])[0].category);
    expect(cats).toEqual(['cap-day']);
  });

  it('an exit outside the universe is recorded once as SKIP', async () => {
    const stock: ExitedPosition = { ...niftyExit, refTable: 'trade_trackers', refId: 'tr1', origin: 'REAL', symbol: 'RELIANCE25NOV261500CE', underlying: 'RELIANCE' };
    const { svc, repo, paper } = make({ exits: [stock] });
    await session(svc, '10:03', '10:30');
    expect(repo.insertDecision).toHaveBeenCalledTimes(1);
    expect((repo.insertDecision.mock.calls[0] as unknown as [{ action: string }])[0].action).toBe('SKIP');
    expect(paper.open).not.toHaveBeenCalled();
  });

  it('never a real order: paper path only, isPaper: true, the module never touches broker / order code', () => {
    expect(PAPER_WATCH_STRATEGIES).toContain(REENTRY_STRATEGY);
    expect(ISOLATED_PAPER_STRATEGIES.has(REENTRY_STRATEGY)).toBe(true);
    const plan = { tradingsymbol: 'NIFTY10NOV2624450CE', token: 'x', exchange: 'NFO', side: 'BUY', qty: 75, ltp: 150, limitPrice: 151, sl: 112.5, targets: [225], lotSize: 75, tickSize: 0.05 };
    const dto = enginePaperDto({ decisionId: 'd', plan: plan as never, underlying: 'NIFTY', kind: 'CE', strike: 24450, expiry: '2026-11-10', why: '', brand: { strategy: REENTRY_STRATEGY, source: 'reentry-watch / paper', tags: ['reentry-watch'], label: 'Re-entry watch' } }) as unknown as Record<string, unknown>;
    expect(dto).toMatchObject({ isPaper: true, strategy: REENTRY_STRATEGY, source: 'reentry-watch / paper', entryTags: ['reentry-watch'] });
    for (const f of ['reentry-watch.service.ts', 'reentry-watch.module.ts', 'reentry-watch.repository.ts', 'domain/reentry-rules.ts']) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src).not.toMatch(/placeOrder|OrderService|order-placement|smartapi|BrokerAdapter|LiveOrder/i);
      expect(src).not.toMatch(/isPaper:\s*false/);
    }
  });
});
