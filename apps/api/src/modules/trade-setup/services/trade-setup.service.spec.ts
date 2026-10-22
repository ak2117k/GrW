import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { istYmd } from '../../night-report/domain/night-report.logic';
import type { TradeSetupDraft } from '../domain/trade-setup.logic';
import type { IdeaRow, StockBookRow, TradeSetupRepository } from '../repositories/trade-setup.repository';
import { TradeSetupService, type MarginReader } from './trade-setup.service';

const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });
// Thu 2026-10-22 23:50 IST
const NOW = new Date('2026-10-22T18:20:00Z');
const SESSION = istYmd(clock.nextOpen('NSE', NOW)!);

const idea = (symbol: string, kind: string, minsAgo: number, headline = `${symbol} news`): IdeaRow => ({
  id: `i-${symbol}-${minsAgo}`, createdAt: new Date(NOW.getTime() - minsAgo * 60_000), symbol, exchange: 'NSE', idea: kind, headline, scorecardId: `sc-${symbol}`,
});
const book = (symbol: string, bucket: string, resultsInWindow = false): StockBookRow => ({
  asOf: new Date('2026-10-22T00:00:00Z'), symbol, pBig: 0.7, rankPct: 0.95, bucket, resultsDate: null, resultsInWindow, atrPct: 0.02, close: 1000, modelId: 'm1',
});
const daily = (close: number) => Array.from({ length: 20 }, (_, i) => ({ day: new Date(Date.parse('2026-09-24T18:30:00Z') + i * 86_400_000), high: close + 10, low: close - 10, close }));

/** In-memory repo keyed like the table: (userId, sessionDate, symbol); margin snapshots per user. */
function fakeRepo(over: Record<string, unknown> = {}) {
  const setups = new Map<string, TradeSetupDraft & { userId: string; id: string; createdAt: Date; updatedAt: Date; filledAt: Date | null; outcomeStatus: string | null }>();
  const margins: Array<{ userId: string; asOf: Date; availableCash: number }> = [];
  const repo = Object.assign({
    ideasSince: jest.fn(async () => [
      idea('RELIANCE', 'CE_IDEA', 10),
      idea('RELIANCE', 'PE_IDEA', 500, 'older reliance headline'),
      idea('TCS', 'PE_IDEA', 20),
      idea('INFY', 'NO_TRADE', 30),
      idea('NIFTY', 'PE_IDEA', 40),
      idea('HDFCBANK', 'CE_IDEA', 50),
    ]),
    latestStockBook: jest.fn(async () => [book('RELIANCE', 'TOP20'), book('TCS', 'MID'), book('INFY', 'TOP20'), { ...book('HDFCBANK', 'TOP20'), close: null }]),
    mbmRegimes: jest.fn(async () => ({ asOf: new Date('2026-10-22T09:55:00Z'), regimes: { '30m': 'ACTIVE', '60m': 'NORMAL' } })),
    scorecardFactors: jest.fn(async () => new Map([['sc-RELIANCE', [{ name: 'oi', points: 1, value: 'PCR 1.3', reason: 'x', available: true }]]])),
    vixCloses: jest.fn(async () => [12, 12.6]),
    dailyBars: jest.fn(async (name: string) => (name === 'RELIANCE' ? daily(1400) : name === 'NIFTY' ? daily(25000) : null)),
    saveMargin: jest.fn(async (userId: string, availableCash: number) => void margins.push({ userId, asOf: NOW, availableCash })),
    latestMargin: jest.fn(async (userId: string) => margins.filter((m) => m.userId === userId).pop() ?? null),
    upsert: jest.fn(async (userId: string, d: TradeSetupDraft) => {
      setups.set(`${userId}|${d.sessionDate}|${d.symbol}`, { ...d, userId, id: `${userId}-${d.symbol}`, createdAt: NOW, updatedAt: NOW, filledAt: null, outcomeStatus: null });
    }),
    forSession: jest.fn(async (userId: string, sessionDate: string) =>
      [...setups.values()].filter((s) => s.userId === userId && s.sessionDate === sessionDate).map((s) => ({ ...s, marginAsOf: s.marginAsOf ? new Date(s.marginAsOf) : null, outcomeR: null, outcomeHitT1: null })),
    ),
    unfilled: jest.fn(async () => []),
    bars15m: jest.fn(async () => []),
    fill: jest.fn(async () => undefined),
  }, over);
  return { repo, setups, margins };
}

const futures = {
  list: jest.fn(async (name: string) =>
    name === 'RELIANCE' ? [{ tradingSymbol: 'RELIANCE24NOV26FUT', token: '2', expiry: '2026-11-24', lotSize: 500 }, { tradingSymbol: 'RELIANCE27OCT26FUT', token: '1', expiry: '2026-10-27', lotSize: 500 }] : [],
  ),
};

function svc(repo: unknown, margin: MarginReader, owner: string | null = 'owner') {
  return new TradeSetupService(repo as TradeSetupRepository, { enabled: true, ownerUserId: owner }, clock, futures, margin, null);
}

describe('TradeSetupService.build', () => {
  it('builds only where news AND model agree, sized on the owner\'s live margin', async () => {
    const { repo, margins } = fakeRepo();
    const s = svc(repo, { live: async () => ({ availableCash: 500_000, net: 600_000 }) });
    const out = await s.build(NOW);
    expect(out).toMatchObject({ ran: true, sessionDate: SESSION, built: 2 });
    expect(out.skipped.map((x) => x.symbol).sort()).toEqual(['HDFCBANK', 'INFY', 'TCS']);
    expect(repo.upsert.mock.calls.every((c) => c[0] === 'owner')).toBe(true);
    const rel = repo.upsert.mock.calls.map((c) => c[1]).find((d) => d.symbol === 'RELIANCE')!;
    // newest idea wins (CE → LONG); both headlines kept; Oct expiry (Tue 27th) has 3 sessions left from Fri 23rd → rolled to Nov
    expect(rel).toMatchObject({ side: 'LONG', instrumentKind: 'FUTURES', expiry: '2026-11-24', marginSource: 'LIVE', marginAvailable: 500_000 });
    expect(rel.instrument).toContain('rolled');
    expect(rel.inputs.headlines).toEqual(['RELIANCE news', 'older reliance headline']);
    expect(rel.inputs.context.find((c) => c.label === 'Options OI / PCR')).toMatchObject({ text: 'PCR 1.3', available: true });
    expect(rel.inputs.context.find((c) => c.label === 'FII / DII')?.available).toBe(false);
    expect(rel.inputs.context.find((c) => c.label === 'India VIX')?.text).toBe('12.60 (+5.0% d/d)');
    const nifty = repo.upsert.mock.calls.map((c) => c[1]).find((d) => d.symbol === 'NIFTY')!;
    expect(nifty).toMatchObject({ side: 'SHORT', instrumentKind: 'CASH_MIS' });
    expect(margins).toEqual([{ userId: 'owner', asOf: NOW, availableCash: 500_000 }]);
  });

  it('broker unreadable at night ⇒ the last known margin, labelled with its as-of', async () => {
    const { repo, margins } = fakeRepo();
    margins.push({ userId: 'owner', asOf: new Date('2026-10-22T09:30:00Z'), availableCash: 300_000 });
    await svc(repo, { live: async () => { throw new Error('session reconnecting'); } }).build(NOW);
    const d = repo.upsert.mock.calls[0][1];
    expect(d).toMatchObject({ marginSource: 'LAST_KNOWN', marginAvailable: 300_000, marginAsOf: '2026-10-22T09:30:00.000Z' });
  });

  it('no owner configured ⇒ builds nothing', async () => {
    const { repo } = fakeRepo();
    expect((await svc(repo, { live: async () => null }, null).build(NOW)).ran).toBe(false);
    expect(repo.upsert).not.toHaveBeenCalled();
  });
});

describe('TradeSetupService.forNextSession — per-user isolation', () => {
  it("user B never sees user A's setups or margin", async () => {
    const { repo } = fakeRepo();
    const s = svc(repo, { live: async () => ({ availableCash: 500_000, net: null }) }, 'userA');
    await s.build(NOW);
    const a = await s.forNextSession('userA', NOW);
    expect(a.setups.length).toBe(2);
    expect(a.setups[0].marginAvailable).toBe(500_000);
    const b = await s.forNextSession('userB', NOW);
    expect(b).toMatchObject({ sessionDate: SESSION, setups: [] });
    expect(JSON.stringify(b)).not.toContain('500000');
    expect(repo.forSession).toHaveBeenLastCalledWith('userB', SESSION);
    expect(await repo.latestMargin('userB')).toBeNull();
    expect((await s.forNextSession('', NOW)).setups).toEqual([]);
  });
});

describe('TradeSetupService.fillOutcomes', () => {
  it('replays an unfilled setup on its session bars and stores the outcome', async () => {
    const t0 = Date.parse('2026-10-22T03:45:00Z');
    const bars = [
      { ts: t0, open: 1002, high: 1010, low: 1000, close: 1008 },
      { ts: t0 + 900_000, open: 1008, high: 1030, low: 1006, close: 1028 },
    ];
    const row = { id: 's1', symbol: 'RELIANCE', sessionDate: '2026-10-22', side: 'LONG', atr: 20, entryRef: 1000 };
    const { repo } = fakeRepo({ unfilled: jest.fn(async () => [row]), bars15m: jest.fn(async () => bars) });
    const out = await svc(repo, { live: async () => null }).fillOutcomes(new Date('2026-10-22T10:45:00Z'));
    expect(out).toEqual({ filled: 1, pending: 0 });
    expect(repo.fill).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'TARGET1', hitT1: true }), expect.any(Date));
  });
});
