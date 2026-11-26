import { parseDeskManagerConfig } from '../desk-manager.config';
import type { GuardState, Proposal } from '../domain/desk.types';
import { PACKET_MAX_CHARS } from '../domain/packet-blocks';
import type { ClosedPositionRow, OpenPositionRow } from '../repositories/desk-state.repository';
import { DeskStateService, type DeskMarketPort } from './desk-state.service';

const NOW = new Date('2026-11-26T06:00:00Z'); // 11:30 IST
const cfg = parseDeskManagerConfig({ DESK_MANAGER: 'shadow', HUB_OWNER_USER_ID: 'owner' });

const pos = (i: number, over: Partial<OpenPositionRow> = {}): OpenPositionRow => ({
  trackerId: `trk${i}`,
  symbol: `U${i}30DEC25${1000 + i}CE`,
  exchange: 'NFO',
  underlying: `U${i}`,
  qty: 75,
  entry: 100 + i,
  ltp: 110 + i,
  pnl: 750,
  entryAt: new Date(NOW.getTime() - 20 * 60_000),
  origin: 'signal',
  paper: false,
  openDecisionId: null,
  ...over,
});

const proposal = (i: number): Proposal => ({
  ref: `reading:${i}`,
  kind: 'reading',
  at: new Date(NOW.getTime() - i * 60_000).toISOString(),
  underlying: i % 2 ? 'NIFTY' : 'BANKNIFTY',
  text: 'x'.repeat(300),
  detail: { call: { underlying: 'NIFTY', entry: 24650, sl: 24600, targets: [24700, 24750] }, claims: [{ text: 'y'.repeat(160), verdict: 'NOT_CHECKABLE', reasonCode: 'STALE' }] },
});

const guardState: GuardState = {
  blocked: false,
  reasons: [],
  path: { realised: -500, open: 200, total: -300, peak: 1000, drawdownFromPeak: 1300, lossStreak: 1, closed: [] },
  pausedUntil: null,
  pauseScope: null,
};

function repoMock(over: Record<string, unknown> = {}) {
  return {
    openPositions: jest.fn(async () => [] as OpenPositionRow[]),
    closedSince: jest.fn(async () => [] as ClosedPositionRow[]),
    latestSentinel: jest.fn(async () => new Map()),
    managerLevelRows: jest.fn(async () => []),
    proposalsSince: jest.fn(async () => [] as Proposal[]),
    claimsOfDay: jest.fn(async () => []),
    decisionsToday: jest.fn(async () => []),
    scorecard: jest.fn(async () => null),
    deskLessons: jest.fn(async () => []),
    busy: jest.fn(async () => false),
    ...over,
  };
}

const market = (over: Partial<DeskMarketPort> = {}): DeskMarketPort => ({
  ltp: async () => 24650,
  day: async () => ({ open: 24600, high: 24700, low: 24550, vwap: 24640 }),
  trend15m: async () => 'UP',
  levels: async () => [24500, 24550, 24600, 24700, 24750, 24800, 24900, 25000],
  chainWalls: async () => ({ call: 24800, put: 24500 }),
  ...over,
});

const make = (repo: ReturnType<typeof repoMock>, m: DeskMarketPort | undefined = market(), guard = { state: jest.fn(async () => guardState) }) =>
  new DeskStateService(repo as never, guard, m, undefined);

describe('DeskStateService.build', () => {
  const env = process.env.AI_AUTO_EXIT_HOLD;
  afterEach(() => {
    if (env === undefined) delete process.env.AI_AUTO_EXIT_HOLD;
    else process.env.AI_AUTO_EXIT_HOLD = env;
  });

  it('a failing block is unavailable with its reason, the rest present', async () => {
    const repo = repoMock({
      proposalsSince: jest.fn(async () => {
        throw new Error('message_readings timeout');
      }),
      openPositions: jest.fn(async () => [pos(1)]),
    });
    const p = await make(repo).build('owner', NOW, cfg);
    expect(p.proposals).toEqual({ status: 'unavailable', reason: 'message_readings timeout', source: expect.any(String) });
    for (const k of ['day', 'pnl', 'guard', 'positions', 'recentExits', 'instruments', 'health', 'memory'] as const) expect(p[k].status).toBe('present');
    expect(p.health.value?.failedBlocks).toEqual(['proposals: message_readings timeout']);
    expect(p.pnl.value?.drawdownFromPeak).toBe(1300);
    expect(p.mode).toBe('shadow');
    expect(p.day.value?.ist).toBe('11:30');
  });

  it('no guard provider: pnl and guard unavailable with the reason', async () => {
    const p = await new DeskStateService(repoMock() as never, undefined, market(), undefined).build('owner', NOW, cfg);
    expect(p.guard.status).toBe('unavailable');
    expect(p.guard.reason).toBe('desk guard not wired');
    expect(p.pnl.status).toBe('unavailable');
  });

  it('proposals capped at 40 newest first', async () => {
    const list = Array.from({ length: 60 }, (_, i) => proposal(59 - i)); // oldest first
    const p = await make(repoMock({ proposalsSince: jest.fn(async () => list) })).build('owner', NOW, cfg);
    expect(p.proposals.value).toHaveLength(40);
    expect(p.proposals.value?.[0].ref).toBe('reading:0');
    expect(p.proposals.value?.[39].ref).toBe('reading:39');
  });

  it('instruments capped at 8 with missing listed', async () => {
    const repo = repoMock({ openPositions: jest.fn(async () => Array.from({ length: 10 }, (_, i) => pos(i))) });
    const m = market({
      chainWalls: async () => null,
      trend15m: async () => {
        throw new Error('no 15m bars');
      },
    });
    const p = await make(repo, m).build('owner', NOW, cfg);
    const inst = p.instruments.value ?? {};
    expect(Object.keys(inst)).toEqual(['U0', 'U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7']);
    expect(inst.U0.missing).toEqual(['trend15m: no 15m bars', 'chainWalls: none']);
    expect(inst.U0.levels).toHaveLength(6);
    expect(inst.U0.ltp).toBe(24650);
  });

  it('instruments without a market port say so', async () => {
    const repo = repoMock({ openPositions: jest.fn(async () => [pos(1)]) });
    const p = await new DeskStateService(repo as never, { state: async () => guardState }, undefined, undefined).build('owner', NOW, cfg);
    expect(p.instruments.value?.U1.missing[0]).toMatch(/market port not wired/);
  });

  it('positions mark a HOLD-list contract held', async () => {
    process.env.AI_AUTO_EXIT_HOLD = 'u130dec251001ce';
    const repo = repoMock({
      openPositions: jest.fn(async () => [pos(1), pos(2, { origin: 'manager', openDecisionId: 'dec-open' })]),
      latestSentinel: jest.fn(async () => new Map([['trk2', { trackerId: 'trk2', verdict: 'HOLD', thesisStatus: 'INTACT', reason: 'holding above 3863', invalidation: 3863, at: NOW }]])),
      managerLevelRows: jest.fn(async () => [{ id: 'dec-open', trackerId: null, action: 'OPEN', payload: { stop: { underlying: 3863 }, targets: { underlying: [3920] } }, createdAt: NOW }]),
    });
    const p = await make(repo).build('owner', NOW, cfg);
    const [a, b] = p.positions.value ?? [];
    expect(a.held).toBe(true);
    expect(b.held).toBe(false);
    expect(b.sentinel).toMatchObject({ verdict: 'HOLD', invalidation: 3863 });
    expect(b.managerStop).toBe(3863);
    expect(b.managerTargets).toEqual([3920]);
    expect(a.ageMin).toBe(20);
  });

  it('recentExits only within 90 min', async () => {
    const closed = (id: string, minAgo: number): ClosedPositionRow => ({ trackerId: id, symbol: 'NIFTY27NOV2624650CE', underlying: 'NIFTY', exitAt: new Date(NOW.getTime() - minAgo * 60_000), pnl: -400, paper: false });
    const repo = repoMock({
      closedSince: jest.fn(async () => [closed('old', 120), closed('new', 30), closed('edge', 89)]),
      latestSentinel: jest.fn(async (_ids: string[], before?: Map<string, Date>) => {
        expect(before?.get('new')).toEqual(new Date(NOW.getTime() - 30 * 60_000));
        return new Map([['new', { trackerId: 'new', verdict: 'EXIT_NOW', thesisStatus: 'BROKEN', reason: 'broke 24600', invalidation: null, at: NOW }]]);
      }),
    });
    const p = await make(repo).build('owner', NOW, cfg);
    expect(p.recentExits.value?.map((e) => e.trackerId)).toEqual(['new', 'edge']);
    expect(p.recentExits.value?.[0].lastSentinel).toEqual({ verdict: 'EXIT_NOW', thesisStatus: 'BROKEN', reason: 'broke 24600' });
    expect(p.recentExits.value?.[0].underlyingNow).toBe(24650);
  });

  it('packet JSON under 100 000 chars for a 10-position, 40-proposal fixture', async () => {
    const repo = repoMock({
      openPositions: jest.fn(async () => Array.from({ length: 10 }, (_, i) => pos(i))),
      latestSentinel: jest.fn(async (ids: string[]) => new Map(ids.map((id) => [id, { trackerId: id, verdict: 'HOLD', thesisStatus: 'INTACT', reason: 'r'.repeat(300), invalidation: 1, at: NOW }]))),
      proposalsSince: jest.fn(async () => Array.from({ length: 40 }, (_, i) => proposal(i))),
      decisionsToday: jest.fn(async () => Array.from({ length: 30 }, () => ({ createdAt: NOW, action: 'NO_ACTION', underlying: 'NIFTY', status: 'DONE', result: { status: 'DONE', detail: 'd'.repeat(300) } }))),
    });
    const p = await make(repo).build('owner', NOW, cfg);
    expect(p.proposals.value).toHaveLength(40);
    expect(JSON.stringify(p).length).toBeLessThan(PACKET_MAX_CHARS);
  });

  it('health counts NOT_CHECKABLE by reason code', async () => {
    const repo = repoMock({ claimsOfDay: jest.fn(async () => [[{ verdict: 'NOT_CHECKABLE', reasonCode: 'QUOTE_BUDGET' }, { verdict: 'NOT_CHECKABLE' }]]) });
    const p = await make(repo).build('owner', NOW, cfg);
    expect(p.health.value).toMatchObject({ notCheckableToday: 2, notCheckableReasons: { QUOTE_BUDGET: 1, OTHER: 1 } });
  });
});
