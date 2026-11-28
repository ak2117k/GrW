import { DeskStateRepository } from './desk-state.repository';

const NOW = new Date('2026-11-26T06:00:00Z');

function prismaMock() {
  const m = () => ({ findMany: jest.fn(async () => [] as unknown[]), count: jest.fn(async () => 0) });
  return {
    tradeTracker: m(),
    trade: m(),
    signalOrder: m(),
    sentinelVerdict: m(),
    paperSentinelLook: m(),
    deskManagerDecision: m(),
    messageReading: m(),
    aiSetup: m(),
    signalDecision: m(),
    entryEngineDecision: m(),
    agentLesson: m(),
  };
}

describe('DeskStateRepository', () => {
  it('busy true with an open position, false on an empty day', async () => {
    const p = prismaMock();
    const repo = new DeskStateRepository(p as never);
    expect(await repo.busy('owner', NOW)).toBe(false);
    p.tradeTracker.count.mockResolvedValueOnce(1);
    expect(await repo.busy('owner', NOW)).toBe(true);
    const where = (p.tradeTracker.count.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({ userId: 'owner', status: 'OPEN' });
  });

  it('busy true with a proposal under 30 min old', async () => {
    const p = prismaMock();
    p.messageReading.count.mockResolvedValueOnce(2);
    expect(await new DeskStateRepository(p as never).busy('owner', NOW)).toBe(true);
    const where = (p.messageReading.count.mock.calls[0] as unknown as [{ where: { postedAt: { gte: Date } } }])[0].where;
    expect(where.postedAt.gte).toEqual(new Date(NOW.getTime() - 30 * 60_000));
  });

  it('open positions: origin from signal_orders, manual when none, paper manager trades keyed paper:<id>', async () => {
    const p = prismaMock();
    const entryTime = new Date('2026-11-26T05:00:00Z');
    p.tradeTracker.findMany.mockResolvedValueOnce([
      { id: 't1', symbol: 'NIFTY27NOV2624650CE', exchange: 'NFO', qty: 75, entryPrice: 100, lastLtp: 110, pnl: 750, entryTime },
      { id: 't2', symbol: 'BSE30DEC253900CE', exchange: 'BFO', qty: 375, entryPrice: 50, lastLtp: null, pnl: null, entryTime },
      { id: 't3', symbol: 'GOLDM05DEC25FUT', exchange: 'MCX', qty: 10, entryPrice: 72000, lastLtp: 72100, pnl: 1000, entryTime },
    ]);
    p.trade.findMany.mockResolvedValueOnce([
      { id: 'tr9', quantity: 75, entryPrice: 90, pnl: null, entryTime, createdAt: entryTime, entryTags: ['desk-manager', 'desk-decision:dec9'], instrument: { symbol: 'NIFTY27NOV2624700CE', exchange: 'NFO', name: 'NIFTY' } },
    ]);
    p.signalOrder.findMany.mockResolvedValueOnce([
      { trackerId: 't1', source: 'signal', decisionId: 'sd1' },
      { trackerId: 't2', source: 'manager', decisionId: 'dec2' },
    ]);
    const rows = await new DeskStateRepository(p as never).openPositions('owner');
    expect(rows.map((r) => [r.trackerId, r.origin, r.underlying, r.openDecisionId, r.paper])).toEqual([
      ['t1', 'signal', 'NIFTY', null, false],
      ['t2', 'manager', 'BSE', 'dec2', false],
      ['t3', 'manual', 'GOLDM', null, false],
      ['paper:tr9', 'manager', 'NIFTY', 'dec9', true],
    ]);
  });

  it('final review item 4: positions[].origin is the guard\'s originsOf — an UNLINKED app order for the same contract is not "manual"', async () => {
    // t1 has no linked signal_orders row (the executor's NO_TRACKER window) but a FILLED manager order for its token:
    // the guard (DeskDayRepository.originsOf) calls it manager; the packet must agree.
    const p = prismaMock();
    const entryTime = new Date('2026-11-26T05:00:00Z');
    p.tradeTracker.findMany.mockResolvedValueOnce([
      { id: 't1', symbol: 'NIFTY27NOV2624650CE', exchange: 'NFO', token: '4321', qty: 75, entryPrice: 100, lastLtp: 110, pnl: 750, entryTime },
      { id: 't2', symbol: 'GOLDM05DEC25FUT', exchange: 'MCX', token: '9999', qty: 10, entryPrice: 72000, lastLtp: 72100, pnl: 1000, entryTime },
    ]);
    p.trade.findMany.mockResolvedValueOnce([]);
    p.signalOrder.findMany
      .mockResolvedValueOnce([]) // linked by trackerId: none
      .mockResolvedValueOnce([
        { trackerId: null, source: 'manager', decisionId: 'dec1', exchange: 'NFO', token: '4321', tradingsymbol: 'NIFTY27NOV2624650CE', createdAt: new Date('2026-11-26T04:59:00Z') },
      ]);
    const rows = await new DeskStateRepository(p as never).openPositions('owner', NOW);
    expect(rows.map((r) => [r.trackerId, r.origin])).toEqual([
      ['t1', 'manager'],
      ['t2', 'manual'],
    ]);
  });

  it('final review item 2: latest sentinel skips drill-tagged verdicts (a drill look is never the desk\'s view)', async () => {
    const p = prismaMock();
    const at = (m: number) => new Date(NOW.getTime() - m * 60_000);
    p.sentinelVerdict.findMany.mockResolvedValueOnce([
      { trackerId: 't1', verdict: 'EXIT_ADVISORY', thesisStatus: 'BROKEN', reason: '[advisory: authority drill] the 15m broke the low', invalidationPoint: null, createdAt: at(2) },
      { trackerId: 't1', verdict: 'HOLD', thesisStatus: 'INTACT', reason: 'still inside the range', invalidationPoint: null, createdAt: at(12) },
    ]);
    const m = await new DeskStateRepository(p as never).latestSentinel(['t1']);
    expect(m.get('t1')).toMatchObject({ verdict: 'HOLD', reason: 'still inside the range' });
  });

  it('open positions read only POSITION trackers: delivery HOLDING rows are not desk trades and never exit targets', async () => {
    // 11-27 prod: 26 HOLDING rows (oldest first) filled the packet and made long-term stocks valid EXIT targets.
    const p = prismaMock();
    p.tradeTracker.findMany.mockResolvedValueOnce([]);
    p.trade.findMany.mockResolvedValueOnce([]);
    p.signalOrder.findMany.mockResolvedValueOnce([]);
    await new DeskStateRepository(p as never).openPositions('owner');
    const where = (p.tradeTracker.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({ userId: 'owner', status: 'OPEN', kind: 'POSITION' });
  });

  it('latest sentinel per tracker, capped before the exit time', async () => {
    const p = prismaMock();
    const at = (m: number) => new Date(NOW.getTime() - m * 60_000);
    p.sentinelVerdict.findMany.mockResolvedValueOnce([
      { trackerId: 't1', verdict: 'EXIT_NOW', thesisStatus: 'BROKEN', reason: 'after exit', invalidationPoint: null, createdAt: at(5) },
      { trackerId: 't1', verdict: 'HOLD', thesisStatus: 'WEAKENING', reason: 'before exit', invalidationPoint: 'below 24,600', createdAt: at(20) },
      { trackerId: 't1', verdict: 'HOLD', thesisStatus: 'INTACT', reason: 'older', invalidationPoint: null, createdAt: at(40) },
    ]);
    const m = await new DeskStateRepository(p as never).latestSentinel(['t1'], new Map([['t1', at(10)]]));
    expect(m.get('t1')).toMatchObject({ reason: 'before exit', invalidation: 24600, thesisStatus: 'WEAKENING' });
  });

  it('scorecard counts only traded OPENs (an OPEN grade with pnl null is not traded) over the last N sessions', async () => {
    const p = prismaMock();
    const day = (d: number, h = 5) => new Date(Date.UTC(2026, 10, d, h));
    p.deskManagerDecision.findMany.mockResolvedValueOnce([
      { createdAt: day(25), underlying: 'NIFTY', grade: { kind: 'OPEN', pnl: 2000, netPnl: 1900 } },
      { createdAt: day(25, 6), underlying: 'BSE', grade: { kind: 'OPEN', pnl: null, netPnl: null } },
      { createdAt: day(24), underlying: 'GOLDM', grade: { kind: 'OPEN', pnl: -800, netPnl: -850 } },
      { createdAt: day(24, 6), underlying: null, grade: { kind: 'NO_ACTION', pnl: null } },
      { createdAt: day(20), underlying: 'SILVERM', grade: { kind: 'OPEN', pnl: 5000, netPnl: 4900 } },
    ]);
    const s = await new DeskStateRepository(p as never).scorecard('owner', 2, NOW);
    expect(s).toEqual({ sessions: 2, opens: 2, netPnl: 1050, winRate: 0.5, best: ['2026-11-25 NIFTY +1900'], worst: ['2026-11-24 GOLDM -850'] });
  });

  it('scorecard null when nothing is graded', async () => {
    expect(await new DeskStateRepository(prismaMock() as never).scorecard('owner', 5, NOW)).toBeNull();
  });

  it('proposals carry reading claims with reason codes and cut long text', async () => {
    const p = prismaMock();
    p.messageReading.findMany.mockResolvedValueOnce([
      { messageId: 'm1', postedAt: NOW, kind: 'CALL', summary: 's'.repeat(500), call: { underlying: 'bse' }, claims: [{ text: 'BSE above 3860', verdict: 'NOT_CHECKABLE', reasonCode: 'QUOTE_BUDGET' }], missedByRules: true },
    ]);
    p.signalDecision.findMany.mockResolvedValueOnce([
      { id: 'sd1', decidedAt: NOW, underlying: 'NIFTY', decision: 'SKIP', skipReason: 'late', mode: 'live', status: 'DONE', judge: { summary: 'no room' }, plan: null },
    ]);
    const out = await new DeskStateRepository(p as never).proposalsSince('owner', new Date(NOW.getTime() - 7200_000));
    expect(out[0]).toMatchObject({ ref: 'reading:m1', underlying: 'BSE', detail: { missedByRules: true, claims: [{ verdict: 'NOT_CHECKABLE', reasonCode: 'QUOTE_BUDGET' }] } });
    expect(out[0].text.length).toBe(300);
    expect(out[1]).toMatchObject({ ref: 'signal:sd1', kind: 'signal_decision', text: 'no room', detail: { decision: 'SKIP', skipReason: 'late' } });
  });

  it('proposals read enough rows per source for the quotas (engine many, for the merge)', async () => {
    const p = prismaMock();
    await new DeskStateRepository(p as never).proposalsSince('owner', new Date(NOW.getTime() - 7200_000));
    const take = (m: { findMany: jest.Mock }) => (m.findMany.mock.calls[0] as unknown as [{ take: number }])[0].take;
    expect(take(p.messageReading)).toBeGreaterThanOrEqual(16);
    expect(take(p.signalDecision)).toBeGreaterThanOrEqual(8);
    expect(take(p.aiSetup)).toBeGreaterThanOrEqual(6);
    expect(take(p.entryEngineDecision)).toBeGreaterThanOrEqual(200);
  });

  it('channel views: INFO readings of the last 3 h, max 10, newest first, with the channel name and the first claim', async () => {
    const p = { ...prismaMock(), telegramChannel: { findMany: jest.fn(async () => [{ id: 'c1', title: 'Mr P', username: 'mrp' }]) } };
    p.messageReading.findMany.mockResolvedValueOnce([
      { messageId: 'm1', channelId: 'c1', postedAt: new Date(NOW.getTime() - 60_000), summary: 'Nifty weak below 26200', claims: [{ subject: 'NIFTY', bias: 'BEAR', text: 'weak' }] },
      { messageId: 'm2', channelId: 'c9', postedAt: new Date(NOW.getTime() - 120_000), summary: 's'.repeat(600), claims: [] },
    ]);
    const out = await new DeskStateRepository(p as never).channelViewsSince(new Date(NOW.getTime() - 3 * 3600_000));
    const arg = (p.messageReading.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; take: number; orderBy: unknown }])[0];
    expect(arg.where).toMatchObject({ kind: 'INFO', postedAt: { gte: new Date(NOW.getTime() - 3 * 3600_000) } });
    expect(arg.take).toBe(10);
    expect(arg.orderBy).toEqual({ postedAt: 'desc' });
    expect(out[0]).toEqual({ channel: 'Mr P', at: new Date(NOW.getTime() - 60_000).toISOString(), summary: 'Nifty weak below 26200', subject: 'NIFTY', bias: 'BEAR' });
    expect(out[1]).toMatchObject({ channel: 'c9', subject: null, bias: null });
    expect(out[1].summary.length).toBe(300);
  });
});
