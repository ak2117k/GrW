import { DeskStateRepository, isPositionScreenshot, shotInSession } from './desk-state.repository';
import { capturedSql } from '../../market-hub/testing/captured-sql';

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

/** REAL prod descriptions (signal_message_classes.llm_result.description, 11-27), full text. */
const REAL = {
  closedQty0: 'Photo of a phone broker Positions screen showing total P&L +29,653.00 on a closed NIFTY 01 DEC 26250 CE position (qty 0, LTP 37.00); NIFTY 50 at 25,847.50 and BANK NIFTY at 63,821.40 in the header. A P&L brag with no new trade call.',
  intradayPe: 'Photo of a broker app portfolio screenshot (Intraday tab) showing a NIFTY 1 Dec 2026 25950 PE position, qty 975, avg 252.12, CMP 315.5, P&L +61046.31 (+173.84%). It is a profit brag, not a trade call.',
  goldOpen: 'Phone photo of a broker positions screen showing an open BUY position in GOLD 27-Nov-26 122000 PE, 21 lots, average 193.43, LTP 210.50, profit +35,847. It is a P&L screenshot, not a fresh call.',
  buySell: 'Broker positions screenshot showing profit on NIFTY 01-Dec-26 25550 PE (90 lots, buy 79.71, sell 86.04, LTP 112.80, +37,030.50) and 25700 PE (19 lots, buy 85.35, sell 119.60, LTP 182.45, +42,298.75); total +73,323.25. It is a P&L brag, not a fresh call.',
  groww: 'Broker app (Groww F&O) positions screenshot showing total P&L +63,056.50 on a NIFTY 01 Dec 25500 Put position, avg 47.75, market price 57.35. NIFTY 50 at 25,805.50 (-0.31%), SENSEX 83,993.61 (-0.40%). This is a P&L brag, not a trade call.',
  crude: 'Broker positions screenshot showing total P&L +2,662.80 on a Crude Oil Mini 16 Dec 8000 Call (MCX) long position, market price 355.65; NIFTY 50 25,818.15 and SENSEX 83,999.32 shown in header. A P&L screenshot, not a trade call.',
  promo: 'Broker F&O positions screenshot showing total P&L +₹2,16,258.25 on a NIFTY 01 Dec 25750 Call position (market price 156.25); NIFTY 50 at 25,739.20 and SENSEX at 83,800.08. The caption advertises profit-sharing and account handling services.',
  payment: "Chat screenshot of a private conversation: a canceled call, 'Send completed', 'Awesome experience', and a payment-app screenshot showing a Rs 1,08,000 paid successfully for Education, with a message 'Monday pe phir dekh lijiyega'. No market instrument, levels or trade call.",
  sandisk: 'Broker holding screenshot of SanDisk Corp (US stock): avg $71.87, qty 70.749270, price $80.21 (+8.97%), invested $5084.75, current value $5,674.80, P&L +$590.05 (+11.60%). Caption says bullish on SANDISK and MU, with no entry, stop or target.',
};
/** Mr P 11-27 12:56 — real post text; the row has NO description, so this one is what the vision step would write. */
const MRP_TEXT = 'A small short side trade is active!\n\nWill trail now!';
const MRP_DESC = 'Broker positions screenshot of an open SENSEX PE position, strike hidden, P&L +4,33,000. Realised P&L 0.00 shown in the header.';

describe('isPositionScreenshot — a live derivative positions screen, never a brag (fix 8 + review)', () => {
  it('Mr P: the post says the trade is active (a "Realised P&L" header alone does not reject)', () => {
    expect(isPositionScreenshot(MRP_TEXT, MRP_DESC)).toBe(true);
    expect(isPositionScreenshot('', MRP_DESC)).toBe(true); // "open … position" in the description
  });
  it.each(Object.entries(REAL))('every real 11-27 description is out: %s', (_k, d) => expect(isPositionScreenshot('', d)).toBe(false));
  it('the brag label alone rejects, even with an "active" post', () => {
    expect(isPositionScreenshot('Trade is active', 'Broker positions screenshot of an open NIFTY 25950 PE position. It is a profit brag, not a trade call.')).toBe(false);
    expect(isPositionScreenshot('Trade is active', 'Broker positions screenshot of an open NIFTY PE position of a client.')).toBe(false);
  });
  it('LTP / CMP / market price are not a live sign', () => {
    expect(isPositionScreenshot('', 'Broker positions screenshot of a NIFTY 25500 Put position, avg 47.75, market price 57.35, LTP 57.35, CMP 57.35.')).toBe(false);
  });
  it('"market open" / "open interest" / "hold tight" in the post are not a live sign', () => {
    const d = 'Broker positions screenshot of a NIFTY 25500 Put position, avg 47.75, LTP 57.35.';
    for (const t of ['Market open ho gaya', 'Open interest is rising', 'Hold tight guys']) expect(isPositionScreenshot(t, d)).toBe(false);
    for (const t of ['Position still running', 'trail SL now', 'Still holding']) expect(isPositionScreenshot(t, d)).toBe(true);
  });
  it('an outcome phrase in the post rejects', () => {
    expect(isPositionScreenshot('NIFTY 25850 PE 170 TO 284 ALL TARGET ACHIEVED', MRP_DESC)).toBe(false);
  });
});

describe('shotInSession — NSE/BSE screens only in the NSE session, MCX screens only in the MCX session', () => {
  const ist = (hhmm: string) => new Date(`2026-11-27T${hhmm}:00+05:30`);
  it('NSE screen', () => {
    expect(shotInSession(MRP_DESC, ist('12:56'))).toBe(true);
    expect(shotInSession(MRP_DESC, ist('18:07'))).toBe(false); // the 11-27 SHRI RAM batch
    expect(shotInSession(MRP_DESC, ist('09:10'))).toBe(false);
  });
  it('MCX screen', () => {
    expect(shotInSession(REAL.crude, ist('20:20'))).toBe(true);
    expect(shotInSession(REAL.crude, ist('23:58'))).toBe(false);
    expect(shotInSession(REAL.goldOpen, ist('08:30'))).toBe(false);
  });
});

describe('channelViewsSince — position screenshots (fix 8 + review)', () => {
  const at = (min: number) => new Date(NOW.getTime() - min * 60_000); // NOW = 11:30 IST
  type Row = { messageId: string; channelId: string; title: string; postedAt: Date; rawText: string; description: string };
  const shotRow = (i: number, o: Partial<Row> = {}): Row => ({ messageId: `s${i}`, channelId: `ch${i}`, title: `Mr. P Investments ${i}`, postedAt: at(i + 1), rawText: MRP_TEXT, description: MRP_DESC, ...o });
  const make = (info: unknown[], shots: Row[] | Error) => {
    const p = {
      ...prismaMock(),
      telegramChannel: { findMany: jest.fn(async () => [{ id: 'mrp', title: 'Mr. P Investments', username: null }]) },
      $queryRaw: jest.fn(async () => {
        if (shots instanceof Error) throw shots;
        return shots;
      }),
    };
    p.messageReading.findMany.mockResolvedValueOnce(info);
    return p;
  };
  const infoRow = (i: number) => ({ messageId: `i${i}`, channelId: 'mrp', postedAt: at(30 + i), summary: `view ${i}`, claims: [] });
  const ENV = 'SIGNAL_VISION_TRUSTED_CHANNELS';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV];
    delete process.env[ENV]; // the signal-vision default: "Mr. P Investments,Stock Gainers"
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it('one query: NOISE/RECAP/UPDATE readings with a description, trusted channel titles only (signal-vision default)', async () => {
    const p = make([infoRow(0)], [shotRow(0)]);
    const out = await new DeskStateRepository(p as never).channelViewsSince(at(180));
    expect(p.$queryRaw).toHaveBeenCalledTimes(1);
    const q = capturedSql(p.$queryRaw.mock.calls as unknown[][]);
    expect(q.text).toMatch(/r\.kind IN \('NOISE', 'RECAP', 'UPDATE'\)/);
    expect(q.text).toMatch(/llm_result->>'description', ''\) <> ''/);
    expect(q.text).toMatch(/ILIKE ANY/);
    expect(q.values).toContainEqual(['%mr. p investments%', '%stock gainers%']);
    expect(out.map((v) => v.kind ?? 'info')).toEqual(['position-screenshot', 'info']);
    expect(out[0]).toEqual({ channel: 'Mr. P Investments 0', at: at(1).toISOString(), summary: MRP_DESC, subject: null, bias: null, kind: 'position-screenshot', messageId: 's0' });
  });

  it('an untrusted channel title is never a candidate (even if the SQL returned it); empty trust list = no query', async () => {
    const p = make([], [shotRow(0, { title: 'SHRI RAM TRADERS CLUB' })]);
    expect(await new DeskStateRepository(p as never).channelViewsSince(at(180))).toEqual([]);
    process.env[ENV] = '';
    const q = make([], [shotRow(0)]);
    expect(await new DeskStateRepository(q as never).channelViewsSince(at(180))).toEqual([]);
    expect(q.$queryRaw).not.toHaveBeenCalled();
  });

  it('the real 11-27 brags (trusted title for the test) and an after-close NSE screen are dropped', async () => {
    const brags = Object.values(REAL).map((d, i) => shotRow(i, { rawText: '', description: d, postedAt: new Date('2026-11-27T12:00:00+05:30') }));
    const late = shotRow(20, { postedAt: new Date('2026-11-27T18:07:00+05:30') });
    const p = make([], [...brags, late]);
    expect(await new DeskStateRepository(p as never).channelViewsSince(at(10_000))).toEqual([]);
  });

  it('1 per channel, at most 3, and they never push an INFO view out of the 10', async () => {
    const sameChannel = [0, 1].map((i) => shotRow(i, { channelId: 'mrp' }));
    const a = await new DeskStateRepository(make([], sameChannel) as never).channelViewsSince(at(180));
    expect(a).toHaveLength(1);
    expect(a[0].at).toBe(at(1).toISOString()); // the newest

    const six = Array.from({ length: 6 }, (_, i) => shotRow(i));
    const b = await new DeskStateRepository(make([infoRow(0), infoRow(1)], six) as never).channelViewsSince(at(180));
    expect(b.filter((v) => v.kind === 'position-screenshot')).toHaveLength(3);
    expect(b).toHaveLength(5);
    expect(b.map((v) => v.at)).toEqual([...b.map((v) => v.at)].sort().reverse());

    const nine = await new DeskStateRepository(make(Array.from({ length: 9 }, (_, i) => infoRow(i)), six) as never).channelViewsSince(at(180));
    expect(nine).toHaveLength(10);
    expect(nine.filter((v) => v.kind === 'position-screenshot')).toHaveLength(1);
  });

  it('INFO fills the cap: the screenshot query is not run at all', async () => {
    const p = make(Array.from({ length: 10 }, (_, i) => infoRow(i)), [shotRow(0)]);
    const out = await new DeskStateRepository(p as never).channelViewsSince(at(180));
    expect(out).toHaveLength(10);
    expect(p.$queryRaw).not.toHaveBeenCalled();
  });

  it('a failed screenshot query never costs the INFO views', async () => {
    const p = make([infoRow(0)], new Error('statement timeout'));
    const out = await new DeskStateRepository(p as never).channelViewsSince(at(180));
    expect(out).toEqual([{ channel: 'Mr. P Investments', at: at(30).toISOString(), summary: 'view 0', subject: null, bias: null }]);
  });
});
