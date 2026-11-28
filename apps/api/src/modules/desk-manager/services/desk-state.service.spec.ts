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
    channelViewsSince: jest.fn(async () => [] as unknown[]),
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

/** CRUDEOIL + CRUDEOILM 5200 / 5300 CE + PE on 16DEC2026 (Angel master rows); premiums CE 385 (full), 385 (mini). */
const crudeRow = (name: string, strike: number, kind: 'CE' | 'PE', lot: string) => ({
  token: `${name}-${strike}${kind}`,
  symbol: `${name}16DEC26${strike}${kind}`,
  name,
  expiry: '16DEC2026',
  strike: String(strike * 100),
  lotsize: lot,
  instrumenttype: 'OPTFUT',
  exch_seg: 'MCX',
  tick_size: '10',
});
const CRUDE_MASTER = ['CRUDEOIL', 'CRUDEOILM'].flatMap((n) => [5200, 5300].flatMap((s) => (['CE', 'PE'] as const).map((k) => crudeRow(n, s, k, n === 'CRUDEOIL' ? '100' : '10'))));
const lotMarket = (over: Record<string, unknown> = {}) => ({
  underlyingRef: jest.fn(async (u: string) => ({ exchange: 'MCX', token: `${u}-FUT`, symbol: `${u}FUT` })),
  ltps: jest.fn(async (refs: ReadonlyArray<{ exchange: string; token: string }>) => new Map(refs.map((r) => [`${r.exchange}:${r.token}`, r.token.endsWith('FUT') ? 5210 : r.token.endsWith('CE') ? 385 : 360] as const))),
  master: jest.fn(async () => CRUDE_MASTER as unknown[]),
  isOpen: () => true,
  minutesToClose: () => 300,
  ...over,
});

const make = (repo: ReturnType<typeof repoMock>, m: DeskMarketPort | undefined = market(), guard = { state: jest.fn(async () => guardState) }) =>
  new DeskStateService(repo as never, guard, m, undefined, undefined, undefined, { available: async () => 50_000 });

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

  it('proposals: per-source quotas (readings 16), newest first', async () => {
    const list = Array.from({ length: 60 }, (_, i) => proposal(59 - i)); // oldest first
    const p = await make(repoMock({ proposalsSince: jest.fn(async () => list) })).build('owner', NOW, cfg);
    expect(p.proposals.value).toHaveLength(16);
    expect(p.proposals.value?.[0].ref).toBe('reading:0');
    expect(p.proposals.value?.[15].ref).toBe('reading:15');
  });

  it('proposals: 40 engine items never crowd out readings / signals; engine merged per (underlying, side) with a count', async () => {
    const engine = Array.from({ length: 40 }, (_, i): Proposal => ({ ref: `engine:${i}`, kind: 'engine', at: new Date(NOW.getTime() - i * 60_000).toISOString(), underlying: i % 2 ? 'NIFTY' : 'CRUDEOIL', text: '', detail: { action: 'ENTER_CE' } }));
    const sig: Proposal = { ref: 'signal:s1', kind: 'signal_decision', at: new Date(NOW.getTime() - 90 * 60_000).toISOString(), underlying: 'SENSEX', text: '', detail: {} };
    const p = await make(repoMock({ proposalsSince: jest.fn(async () => [...engine, proposal(100), sig]) })).build('owner', NOW, cfg);
    const refs = p.proposals.value?.map((x) => x.ref) ?? [];
    expect(refs).toEqual(expect.arrayContaining(['engine:0', 'engine:1', 'reading:100', 'signal:s1']));
    expect(refs).toHaveLength(4);
    expect(p.proposals.value?.find((x) => x.ref === 'engine:0')?.detail.count).toBe(20);
  });

  it('channelViews block: INFO market views of the last 3 h', async () => {
    const views = [{ channel: 'Mr P', at: NOW.toISOString(), summary: 'Nifty weak below 26200', subject: 'NIFTY', bias: 'BEAR' }];
    const repo = repoMock({ channelViewsSince: jest.fn(async () => views) });
    const p = await make(repo).build('owner', NOW, cfg);
    expect(p.channelViews).toEqual({ status: 'present', value: views, source: expect.any(String) });
    expect(repo.channelViewsSince).toHaveBeenCalledWith(new Date(NOW.getTime() - 3 * 3600_000), NOW);
    // a channel view's subject gets an instrument slot
    expect(Object.keys(p.instruments.value ?? {})).toEqual(['NIFTY']);
  });

  it('fix 8: a post that is also a proposal is never a position-screenshot view; the messageId never reaches the packet', async () => {
    const shot = (id: string) => ({ channel: 'Mr P', at: NOW.toISOString(), summary: 'positions screen', subject: null, bias: null, kind: 'position-screenshot' as const, messageId: id });
    const repo = repoMock({
      proposalsSince: jest.fn(async () => [{ ...proposal(1), underlying: 'MARKET' }]),
      channelViewsSince: jest.fn(async () => [shot('1'), shot('2')]),
    });
    const p = await make(repo).build('owner', NOW, cfg);
    expect(p.proposals.value?.map((x) => x.ref)).toEqual(['reading:1']);
    expect(p.channelViews?.value).toEqual([{ channel: 'Mr P', at: NOW.toISOString(), summary: 'positions screen', subject: null, bias: null, kind: 'position-screenshot' }]);
  });

  it('instrument slots: F&O/MCX positions, proposals + channel views, exits, equity holdings last; keys normalised', async () => {
    const eq = (i: number, u: string) => pos(i, { underlying: u, symbol: `${u}-EQ`, exchange: 'NSE' });
    const repo = repoMock({
      openPositions: jest.fn(async () => [...['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((u, i) => eq(i, u)), pos(20, { underlying: 'GOLDM', symbol: 'GOLDM26DEC26130000CE', exchange: 'MCX' })]),
      proposalsSince: jest.fn(async () => [{ ...proposal(1), underlying: 'NIFTY' }, { ...proposal(2), underlying: 'MARKET' }, { ...proposal(3), underlying: 'BHARATFORGE' }]),
      channelViewsSince: jest.fn(async () => [{ channel: 'c', at: NOW.toISOString(), summary: 's', subject: 'SENSEX', bias: 'BULL' }]),
      closedSince: jest.fn(async () => [{ trackerId: 'x', symbol: 'BSE29DEC264250CE', underlying: 'BSE', exitAt: new Date(NOW.getTime() - 60_000), pnl: 1, paper: false }]),
    });
    const lot = lotMarket({ master: async () => [{ name: 'BHARATFORG', exch_seg: 'NSE', symbol: 'BHARATFORG-EQ' }, { name: 'NIFTY' }, { name: 'GOLD' }, { name: 'SENSEX' }, { name: 'BSE' }] });
    const p = await new DeskStateService(repo as never, { state: async () => guardState }, market(), undefined, undefined, undefined, undefined, lot).build('owner', NOW, cfg);
    expect(Object.keys(p.instruments.value ?? {})).toEqual(['GOLD', 'NIFTY', 'BHARATFORG', 'SENSEX', 'BSE', 'A', 'B', 'C']);
  });

  it('funds block: available margin from the order path read + the 1-lot ATM option and mini costs', async () => {
    const repo = repoMock({ openPositions: jest.fn(async () => [pos(1, { underlying: 'CRUDEOIL', symbol: 'CRUDEOIL16DEC265200CE', exchange: 'MCX' })]) });
    const funds = { available: jest.fn(async () => 30_000) };
    const lot = lotMarket();
    const p = await new DeskStateService(repo as never, { state: async () => guardState }, market({ ltp: async () => 5210 }), undefined, undefined, undefined, funds, lot).build('owner', NOW, cfg);
    expect(funds.available).toHaveBeenCalledWith('owner');
    expect(p.funds?.status).toBe('present');
    const f = p.funds?.value;
    expect(f?.available).toBe(30_000);
    const c = f?.lots.CRUDEOIL;
    expect(c?.atmCe).toMatchObject({ contract: 'CRUDEOIL16DEC265200CE', premium: 385, lotSize: 100, valueFactor: 1, cost: 38_500, fits: false });
    expect(c?.atmPe?.contract).toBe('CRUDEOIL16DEC265200PE');
    expect(c?.mini?.underlying).toBe('CRUDEOILM');
    expect(c?.mini?.atmCe).toMatchObject({ contract: 'CRUDEOILM16DEC265200CE', lotSize: 10, cost: 3_850, fits: true });
  });

  it('funds block: fits uses the order path requiredFunds (cost + the funds buffer)', async () => {
    const repo = repoMock({ openPositions: jest.fn(async () => [pos(1, { underlying: 'CRUDEOIL', symbol: 'CRUDEOIL16DEC265200CE', exchange: 'MCX' })]) });
    const svc = new DeskStateService(repo as never, { state: async () => guardState }, market({ ltp: async () => 5210 }), undefined, undefined, undefined, { available: async () => 4_000 }, lotMarket(), { fundsBufferPct: 10, futMarginPct: 25 });
    const mini = (await svc.build('owner', NOW, cfg)).funds?.value?.lots.CRUDEOIL.mini?.atmCe;
    expect(mini).toMatchObject({ cost: 3_850, required: 4_235, fits: false });
  });

  it('funds block: a slow premium read never blanks the available funds (separate boxes)', async () => {
    const repo = repoMock({ openPositions: jest.fn(async () => [pos(1, { underlying: 'CRUDEOIL', symbol: 'CRUDEOIL16DEC265200CE', exchange: 'MCX' })]) });
    const slow = lotMarket({ ltps: jest.fn(() => new Promise(() => undefined)) });
    const p = await new DeskStateService(repo as never, { state: async () => guardState }, market({ ltp: async () => 5210 }), undefined, undefined, undefined, { available: async () => 30_000 }, slow).build('owner', NOW, cfg);
    expect(p.funds?.status).toBe('present');
    expect(p.funds?.value?.available).toBe(30_000);
    expect(p.funds?.value?.lots.CRUDEOIL.missing.join(' ')).toMatch(/lot pricing: timed out after 4000 ms/);
  }, 15_000);

  it('funds block: premium reads run at most 3 underlyings at a time', async () => {
    const us = ['CRUDEOIL', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6'];
    const repo = repoMock({ openPositions: jest.fn(async () => us.map((u, i) => pos(i, { underlying: u, symbol: `${u}16DEC265200CE`, exchange: 'MCX' }))) });
    let live = 0;
    let peak = 0;
    const base = lotMarket();
    const counting = lotMarket({
      underlyingRef: jest.fn(async (u: string) => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 20));
        live--;
        return base.underlyingRef(u);
      }),
    });
    await new DeskStateService(repo as never, { state: async () => guardState }, market({ ltp: async () => null }), undefined, undefined, undefined, { available: async () => 30_000 }, counting).build('owner', NOW, cfg);
    expect(counting.underlyingRef).toHaveBeenCalledTimes(us.length);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('funds block: unknown funds keep the costs with fits null; no funds read wired = unavailable', async () => {
    const repo = repoMock({ openPositions: jest.fn(async () => [pos(1, { underlying: 'CRUDEOIL', symbol: 'CRUDEOIL16DEC265200CE', exchange: 'MCX' })]) });
    const unknown = await new DeskStateService(repo as never, { state: async () => guardState }, market({ ltp: async () => 5210 }), undefined, undefined, undefined, { available: async () => null }, lotMarket()).build('owner', NOW, cfg);
    expect(unknown.funds?.value?.available).toBeNull();
    expect(unknown.funds?.value?.lots.CRUDEOIL.atmCe?.fits).toBeNull();
    const none = await new DeskStateService(repo as never, { state: async () => guardState }, market(), undefined).build('owner', NOW, cfg);
    expect(none.funds).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/funds read not wired/) });
  });

  it('final review item 6: after the lot-pricing box closes, no worker writes the returned lots or calls Angel again', async () => {
    // 4 underlyings, 3 workers: the first premium reads land at 4.5 s (after the 4 s box); without an abort the
    // workers would then write the returned lots and go on to price the 4th underlying and the minis.
    const us = ['CRUDEOIL', 'B1', 'B2', 'B3'];
    const repo = repoMock({ openPositions: jest.fn(async () => us.map((u, i) => pos(i, { underlying: u, symbol: `${u}16DEC265200CE`, exchange: 'MCX' }))) });
    const base = lotMarket();
    const late = lotMarket({
      ltps: jest.fn((refs: ReadonlyArray<{ exchange: string; token: string }>) => new Promise((r) => setTimeout(() => r(base.ltps(refs)), 4_500))),
      master: jest.fn(async () => ['CRUDEOIL', 'CRUDEOILM', 'B1', 'B2', 'B3'].flatMap((n) => [5200, 5300].flatMap((s) => (['CE', 'PE'] as const).map((k) => crudeRow(n, s, k, '10'))))),
    });
    const p = await new DeskStateService(repo as never, { state: async () => guardState }, market({ ltp: async () => 5210 }), undefined, undefined, undefined, { available: async () => 30_000 }, late).build('owner', NOW, cfg);
    const snapshot = JSON.stringify(p.funds?.value);
    expect(p.funds?.value?.lots.CRUDEOIL.missing.join(' ')).toMatch(/lot pricing: timed out after 4000 ms/);
    const callsAtClose = late.ltps.mock.calls.length + late.underlyingRef.mock.calls.length;
    await new Promise((r) => setTimeout(r, 1_500)); // the 4.5 s reads land now
    expect(JSON.stringify(p.funds?.value)).toBe(snapshot);
    expect(late.ltps.mock.calls.length + late.underlyingRef.mock.calls.length).toBe(callsAtClose);
  }, 20_000);

  it('final review item 8: lots are priced only for underlyings with a position, a proposal or a channel view', async () => {
    const repo = repoMock({
      openPositions: jest.fn(async () => [pos(1, { underlying: 'CRUDEOIL', symbol: 'CRUDEOIL16DEC265200CE', exchange: 'MCX' })]),
      // A recent exit gets an instrument slot (context), but nothing to open: no lot pricing, no hub watch.
      closedSince: jest.fn(async () => [{ trackerId: 'x', symbol: 'BSE29DEC264250CE', underlying: 'BSE', exitAt: new Date(NOW.getTime() - 60_000), pnl: 1, paper: false }]),
    });
    const lot = lotMarket();
    const p = await new DeskStateService(repo as never, { state: async () => guardState }, market({ ltp: async () => 5210 }), undefined, undefined, undefined, { available: async () => 30_000 }, lot).build('owner', NOW, cfg);
    expect(Object.keys(p.instruments.value ?? {})).toEqual(['CRUDEOIL', 'BSE']);
    expect(Object.keys(p.funds?.value?.lots ?? {})).toEqual(['CRUDEOIL']);
    expect(lot.underlyingRef.mock.calls.map((c) => c[0])).not.toContain('BSE');
  });

  it('health: the status port reports the feed and the agents', async () => {
    const status = { feed: async () => 'hub socket up, last tick 2 s ago', agents: async () => ({ trading: 'up' }) };
    const p = await new DeskStateService(repoMock() as never, { state: async () => guardState }, market(), status).build('owner', NOW, cfg);
    expect(p.health.value).toMatchObject({ feed: 'hub socket up, last tick 2 s ago', agents: { trading: 'up' } });
  });

  it('instruments get a 6 s box (a 3.5 s read still lands)', async () => {
    const repo = repoMock({ openPositions: jest.fn(async () => [pos(1)]) });
    const slow = market({ ltp: () => new Promise((r) => setTimeout(() => r(111), 3_500)) });
    const p = await make(repo, slow).build('owner', NOW, cfg);
    expect(p.instruments.value?.U1.ltp).toBe(111);
  }, 15_000);

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

  it('instrument slots go to what can be acted on: open positions, then proposals, then recent exits', async () => {
    // 11-27 prod: the 8 slots went to old rows first and NIFTY (a live position) plus every proposal got no data.
    const proposals: Proposal[] = ['SENSEX', 'CRUDEOIL', 'SENSEX', 'HINDOILEXP'].map((u, i) => ({ ...proposal(i), underlying: u }));
    const exits: ClosedPositionRow[] = [{ trackerId: 'x1', symbol: 'BSE29DEC264250CE', underlying: 'BSE', exitAt: new Date(NOW.getTime() - 10 * 60_000), pnl: -3330, paper: false }];
    const repo = repoMock({
      openPositions: jest.fn(async () => [pos(0, { underlying: 'NIFTY', symbol: 'NIFTY01DEC2625700PE' }), pos(1, { underlying: 'MAZDOCK', symbol: 'MAZDOCK29DEC261760PE' })]),
      proposalsSince: jest.fn(async () => proposals),
      closedSince: jest.fn(async () => exits),
    });
    const p = await make(repo).build('owner', NOW, cfg);
    expect(Object.keys(p.instruments.value ?? {})).toEqual(['NIFTY', 'MAZDOCK', 'SENSEX', 'CRUDEOIL', 'HINDOILEXP', 'BSE']);
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

  it('authority live: live positions carry brief / hasBrief (paper none); off: no brief fields at all', async () => {
    const repo = repoMock({ openPositions: jest.fn(async () => [pos(1), pos(2), pos(3, { trackerId: 'paper:tr3', paper: true })]) });
    const briefs = { briefFor: jest.fn(async (id: string) => (id === 'trk1' ? 'Plan: hold for 1100 above 1000.' : null)), write: jest.fn() };
    const guard = { state: jest.fn(async () => guardState) };
    const live = await new DeskStateService(repo as never, guard, market(), undefined, briefs, { isLive: () => true }).build('owner', NOW, cfg);
    const [a, b, c] = live.positions.value ?? [];
    expect(a).toMatchObject({ brief: 'Plan: hold for 1100 above 1000.', hasBrief: true });
    expect(b).toMatchObject({ brief: null, hasBrief: false });
    expect('hasBrief' in c).toBe(false);
    expect(briefs.briefFor).not.toHaveBeenCalledWith('paper:tr3');
    for (const authority of [{ isLive: () => false }, undefined]) {
      const off = await new DeskStateService(repo as never, guard, market(), undefined, briefs, authority).build('owner', NOW, cfg);
      for (const p of off.positions.value ?? []) {
        expect('brief' in p).toBe(false);
        expect('hasBrief' in p).toBe(false);
      }
    }
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
    expect(p.proposals.value).toHaveLength(16);
    expect(JSON.stringify(p).length).toBeLessThan(PACKET_MAX_CHARS);
  });

  it('health counts NOT_CHECKABLE by reason code', async () => {
    const repo = repoMock({ claimsOfDay: jest.fn(async () => [[{ verdict: 'NOT_CHECKABLE', reasonCode: 'QUOTE_BUDGET' }, { verdict: 'NOT_CHECKABLE' }]]) });
    const p = await make(repo).build('owner', NOW, cfg);
    expect(p.health.value).toMatchObject({ notCheckableToday: 2, notCheckableReasons: { QUOTE_BUDGET: 1, OTHER: 1 } });
  });
});
