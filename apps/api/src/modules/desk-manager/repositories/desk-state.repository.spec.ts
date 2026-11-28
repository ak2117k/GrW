import { DeskStateRepository, isPositionScreenshot } from './desk-state.repository';

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

describe('isPositionScreenshot — a channel image showing an ACTIVE position (fix 8, real 11-27 descriptions)', () => {
  const yes: Array<[string, string]> = [
    ['', 'Broker app (Groww F&O) positions screenshot showing total P&L +63,056.50 on a NIFTY 01 Dec 25500 Put position, avg 47.75, market price 57.35. NIFTY 50 at 25,805.50 (-0.31%).'],
    ['', 'Phone photo of a broker positions screen showing an open BUY position in GOLD 27-Nov-26 122000 PE, 21 lots, average 193.43, LTP 210.50, profit +35,847. It is a P&L screenshot, not a fresh call.'],
    ['', 'Broker positions screenshot showing total P&L +2,662.80 on a Crude Oil Mini 16 Dec 8000 Call (MCX) long position, market price 355.65.'],
    // Mr P 11-27 12:56 (the row has no description yet; this is what the vision step would write for that image).
    ['Small short side trade is active, will trail SL', 'Broker positions screenshot of a SENSEX PE position with P&L +4,33,000; strike hidden.'],
  ];
  const no: Array<[string, string, string]> = [
    ['closed (qty 0)', '', 'Photo of a phone broker Positions screen showing total P&L +29,653.00 on a closed NIFTY 01 DEC 26250 CE position (qty 0, LTP 37.00).'],
    ['bought and sold', '', 'Broker positions screenshot showing a NIFTY 01-Dec-26 25850 PE position of 89 lots, bought at 177.89 and sold at 265.00, with a profit of +5,03,931.35.'],
    ['account-handling promo', '50-50% Profit sharing work ✅ Account handling work done ✅', 'Broker F&O positions screenshot showing total P&L +₹2,16,258.25 on a NIFTY 01 Dec 25750 Call position (market price 156.25).'],
    ['payment chat', '', 'Chat screenshot of a private conversation and a payment-app screenshot showing a Rs 1,08,000 paid successfully.'],
    ['US stock holding (no option / future)', 'Bullish on SANDISK', 'Broker holding screenshot of SanDisk Corp (US stock): avg $71.87, price $80.21, P&L +$590.05 (+11.60%).'],
    ['outcome phrase in the post', 'NIFTY 25850 PE 170 TO 284 ALL TARGET ACHIEVED', 'Broker positions screenshot of a NIFTY 25850 PE position, LTP 284, P&L +1,14,000.'],
    ['no sign the position is live', '', 'Photo of a broker F&O positions screen showing total P&L +₹42,836.30 on NIFTY 01 Dec options: 25600 Put +1,677, 25700 Put +23,323.30.'],
    ['not a positions screen', 'Trade is active', 'Chart of NIFTY 15m with a trendline and an arrow pointing down.'],
  ];
  it.each(yes)('yes: %s | %s', (text, d) => expect(isPositionScreenshot(text, d)).toBe(true));
  it.each(no)('no (%s)', (_why, text, d) => expect(isPositionScreenshot(text, d)).toBe(false));
});

describe('channelViewsSince — position screenshots (fix 8)', () => {
  const at = (min: number) => new Date(NOW.getTime() - min * 60_000);
  const SHOT = 'Broker positions screenshot of a SENSEX PE position with P&L +4,33,000; LTP 512. ' + 'x'.repeat(300);
  const make = (info: unknown[], cands: unknown[], classes: unknown[], msgs: unknown[]) => {
    const p = {
      ...prismaMock(),
      telegramChannel: { findMany: jest.fn(async () => [{ id: 'mrp', title: 'Mr. P Investments', username: null }]) },
      signalMessageClass: { findMany: jest.fn(async () => classes) },
      telegramMessage: { findMany: jest.fn(async () => msgs) },
    };
    p.messageReading.findMany.mockResolvedValueOnce(info).mockResolvedValueOnce(cands);
    return p;
  };
  const infoRow = (i: number) => ({ messageId: `i${i}`, channelId: 'mrp', postedAt: at(30 + i), summary: `view ${i}`, claims: [] });

  it('a NOISE / RECAP / bare-UPDATE image with an active-position description becomes a position-screenshot view', async () => {
    const p = make(
      [infoRow(0)],
      [
        // The real 12:56 reading: UPDATE with call.underlying 'MARKET' (no instrument).
        { messageId: 's1', channelId: 'mrp', postedAt: at(5), kind: 'UPDATE', call: { side: 'SELL', strike: null, underlying: 'MARKET' } },
        { messageId: 's2', channelId: 'mrp', postedAt: at(6), kind: 'UPDATE', call: { underlying: 'NIFTY' } }, // a real UPDATE: proposals has it
        { messageId: 's3', channelId: 'mrp', postedAt: at(7), kind: 'NOISE', call: null }, // no description
        { messageId: 's4', channelId: 'mrp', postedAt: at(8), kind: 'RECAP', call: null }, // booked result
      ],
      [
        { messageId: 's1', llmResult: { kind: 'NOISE', description: SHOT } },
        { messageId: 's2', llmResult: { kind: 'NOISE', description: SHOT } },
        { messageId: 's3', llmResult: { kind: 'NOISE' } },
        { messageId: 's4', llmResult: { description: 'Broker positions screenshot of a closed NIFTY CE position, P&L +29,000.' } },
      ],
      [{ id: 's1', rawText: 'Small short side trade is active' }, { id: 's4', rawText: '' }],
    );
    const out = await new DeskStateRepository(p as never).channelViewsSince(at(180));
    const q = (p.messageReading.findMany.mock.calls[1] as unknown as [{ where: Record<string, unknown> }])[0];
    expect(q.where).toMatchObject({ postedAt: { gte: at(180) }, kind: { in: ['NOISE', 'RECAP', 'UPDATE'] } });
    expect(out.map((v) => v.kind ?? 'info')).toEqual(['position-screenshot', 'info']);
    expect(out[0]).toMatchObject({ channel: 'Mr. P Investments', at: at(5).toISOString(), subject: null, bias: null });
    expect(out[0].summary.length).toBeLessThanOrEqual(200);
    expect(out[0].summary.startsWith('Broker positions screenshot of a SENSEX PE')).toBe(true);
  });

  it('at most 3 screenshots, and they never push an INFO view out of the 10', async () => {
    const cands = Array.from({ length: 6 }, (_, i) => ({ messageId: `s${i}`, channelId: 'mrp', postedAt: at(i + 1), kind: 'NOISE', call: null }));
    const classes = cands.map((c, i) => ({ messageId: c.messageId, llmResult: { description: `${SHOT.slice(0, 80)} #${i}` } }));
    const few = make([infoRow(0), infoRow(1)], cands, classes, []);
    const a = await new DeskStateRepository(few as never).channelViewsSince(at(180));
    expect(a.filter((v) => v.kind === 'position-screenshot')).toHaveLength(3);
    expect(a).toHaveLength(5);
    expect(a.map((v) => v.at)).toEqual([...a.map((v) => v.at)].sort().reverse());

    const full = make(Array.from({ length: 10 }, (_, i) => infoRow(i)), cands, classes, []);
    const b = await new DeskStateRepository(full as never).channelViewsSince(at(180));
    expect(b).toHaveLength(10);
    expect(b.some((v) => v.kind === 'position-screenshot')).toBe(false);

    const nine = make(Array.from({ length: 9 }, (_, i) => infoRow(i)), cands, classes, []);
    const c = await new DeskStateRepository(nine as never).channelViewsSince(at(180));
    expect(c).toHaveLength(10);
    expect(c.filter((v) => v.kind === 'position-screenshot')).toHaveLength(1);
  });

  it('the same screenshot posted twice in a channel is one view', async () => {
    const cands = [1, 2].map((i) => ({ messageId: `s${i}`, channelId: 'mrp', postedAt: at(i), kind: 'NOISE', call: null }));
    const p = make([], cands, cands.map((c) => ({ messageId: c.messageId, llmResult: { description: SHOT } })), []);
    expect(await new DeskStateRepository(p as never).channelViewsSince(at(180))).toHaveLength(1);
  });
});
