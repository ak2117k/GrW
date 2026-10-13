import { currentCoreAlertIntake, handOffChartinkHit, setCoreAlertIntake } from '../intake/alert-handoff';
import { readEntryConfig } from '../intake/entry-config';
import { NOW } from '../lifecycle/testing/lifecycle-fixtures';
import { limitsFixture } from '../risk-wall/testing/risk-fixtures';
import { m5Harness, SEL_ADAPTIVE } from './testing/m5-harness';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => {
  setCoreAlertIntake(null);
  jest.useRealTimers();
});

const INFY = { alertId: 'alert_2', token: '1594', tradingSymbol: 'INFY-EQ', symbol: 'INFY' };

describe('SP2 M5 end to end (spec §1 done-when, §10)', () => {
  it('replay: an Ungated Chartink hit → Risk Wall → paper fill → target exit → summary → clean reconciliation, fully journaled', async () => {
    const m = m5Harness();
    const [out] = await m.intake.process(m.hitAt(500));
    expect(out).toMatchObject({ kind: 'OPENED' });
    const positionId = out.kind === 'OPENED' ? out.positionId : '';
    await m.h.price(500); // the entry fills on the first price after it was placed
    await m.h.price(515); // +3 %: target
    await m.h.price(515); // the exit fills
    await m.pump();
    expect(m.h.positions.rows.find((p) => p.id === positionId)).toMatchObject({ status: 'CLOSED', exitReason: 'TARGET' });
    for (const t of ['ALERT_RECEIVED', 'RISK_VERDICT', 'ORDER_PLACED', 'ORDER_STATE', 'FILL', 'POSITION_STATE', 'EXIT_DECIDED'] as const) expect(m.types()).toContain(t);
    const [summary] = m.store.summaries;
    const funds = await m.h.ledger.funds('user_A');
    expect(summary).toMatchObject({ positionId, exitReason: 'TARGET', grossPnl: funds.realisedPnl, charges: funds.charges });
    expect(Number(summary.netPnl)).toBeCloseTo(Number(funds.realisedPnl) - Number(funds.charges), 2);
    expect(m.corpus.entrySetup).toHaveBeenCalledWith(expect.objectContaining({ decision: expect.objectContaining({ taken: true }) }));
    expect(m.corpus.outcome).toHaveBeenCalledWith(summary.intentId, expect.objectContaining({ netPnl: Number(summary.netPnl) }), summary.closedAt);
    expect(await m.recon.reconcileUser('user_A', 'INTRADAY', new Date())).toEqual([]);
    expect(await m.recon.reconcileUser('user_A', 'NIGHTLY', new Date())).toEqual([]);
  });

  it('Adaptive-Stop v1 (the seed): gate fails open without candles, 0.8 % stop, risk sizing; it closes and is summarised', async () => {
    const m = m5Harness({ selections: [SEL_ADAPTIVE()] });
    const [out] = await m.intake.process(m.hitAt(500, { scanName: 'any scan', score: 70 }));
    expect(out).toMatchObject({ kind: 'OPENED' });
    const verdict = m.store.rows.find((r) => r.type === 'RISK_VERDICT');
    expect(verdict?.payload).toMatchObject({ requestedQty: 200 }); // ₹800 ÷ (500 × 0.8 %)
    for (const ltp of [500, 505, 505, 508, 504.9, 504.9]) await m.h.price(ltp);
    if (m.h.positions.rows[0].status !== 'CLOSED') {
      // Whatever the trail did, the 15:15 time exit closes it (deterministic end of the replay).
      m.h.advance(new Date('2026-10-12T15:16:00.000+05:30').getTime() - Date.now());
      await m.h.sweep();
      await m.h.price(504);
      await m.h.price(504);
    }
    await m.pump();
    expect(m.h.positions.rows[0]).toMatchObject({ status: 'CLOSED', highWater: 508 });
    expect(m.store.summaries).toHaveLength(1);
    expect(await m.recon.reconcileUser('user_A', 'INTRADAY', new Date())).toEqual([]);
  });

  it('journal mode: everything up to the verdict, no order, no position', async () => {
    const m = m5Harness({ mode: 'journal' });
    const [out] = await m.intake.process(m.hitAt(500));
    expect(out).toMatchObject({ kind: 'DRY_RUN' });
    expect(m.h.paper.orders).toEqual([]);
    expect(m.h.positions.rows).toEqual([]);
    await m.pump();
    expect(m.types()).toEqual(expect.arrayContaining(['ALERT_RECEIVED', 'RISK_VERDICT', 'INTENT_SKIPPED']));
  });

  it('kill switch on: the next hit is a RISK_REJECT (KILL_SWITCH); exits of the open position still happen', async () => {
    const m = m5Harness();
    const [first] = await m.intake.process(m.hitAt(500));
    await m.h.price(500);
    m.h.killOn.add('user_A');
    const [second] = await m.intake.process(m.hitAt(1500, INFY));
    expect(second).toMatchObject({ kind: 'SKIPPED', reason: 'RISK_REJECT' });
    expect(second.kind === 'SKIPPED' && second.detail).toMatch(/KILL_SWITCH/);
    await m.h.lifecycle.exitAll('user_A', 'KILL_SWITCH', 'test');
    await m.h.price(499);
    await m.pump();
    expect(m.h.positions.rows.find((p) => first.kind === 'OPENED' && p.id === first.positionId)).toMatchObject({ status: 'CLOSED', exitReason: 'KILL_SWITCH' });
  });

  it('daily loss: a realised loss over the limit latches the day; the next hit is rejected DAILY_LOSS', async () => {
    const m = m5Harness({ limits: () => limitsFixture({ 'maxDailyLoss@ALL': '100.00' }) });
    await m.intake.process(m.hitAt(500));
    await m.h.price(500);
    await m.h.price(492); // through the 1.5 % stop
    await m.h.price(492);
    await m.pump();
    expect(m.h.positions.rows[0]).toMatchObject({ status: 'CLOSED', exitReason: 'STOP' });
    const [next] = await m.intake.process(m.hitAt(1500, INFY));
    expect(next.kind === 'SKIPPED' && next.detail).toMatch(/DAILY_LOSS/);
    await m.pump();
    expect(await m.reads.latched('user_A', '2026-10-12')).toBe(true);
  });

  it('restart mid-trade: the same alert re-processed is a DUPLICATE; the trade closes once and is summarised once', async () => {
    const m = m5Harness();
    const hit = m.hitAt(500);
    await m.intake.process(hit);
    await m.h.price(500);
    m.h.restart();
    await m.h.lifecycle.recover();
    expect((await m.intake.process(hit))[0]).toMatchObject({ kind: 'DUPLICATE' });
    await m.h.price(515);
    await m.h.price(515);
    await m.pump();
    expect(m.h.positions.rows).toHaveLength(1);
    expect(m.h.positions.rows[0].status).toBe('CLOSED');
    expect(m.store.summaries).toHaveLength(1);
  });
});

describe('SP2 M5 safety (Stream G checks beyond the plan)', () => {
  it('defaults (CORE_ENTRIES_MODE unset, empty CORE_ENTRY_USER_IDS): the intake never registers, a Chartink hit opens nothing and places no order', async () => {
    const config = readEntryConfig({});
    expect(config).toEqual({ mode: 'off', userIds: new Set(), maxAlertAgeMs: 180_000 });
    const m = m5Harness({ mode: config.mode, users: [...config.userIds] });
    setCoreAlertIntake(null);
    m.intake.onModuleInit();
    expect(currentCoreAlertIntake()).toBeNull();
    handOffChartinkHit(m.hitAt(500)); // what ChartinkProcessService does: a no-op with no intake registered
    expect(await m.intake.process(m.hitAt(500))).toEqual([]); // fail closed even when called directly
    await m.intake.idle();
    await m.pump();
    expect(m.h.paper.orders).toEqual([]);
    expect(m.h.positions.rows).toEqual([]);
    expect(m.store.rows).toEqual([]);
    expect(m.corpus.entrySetup).not.toHaveBeenCalled();
  });

  it('paper mode with an empty allow-list admits nobody: no order, no journal row', async () => {
    const m = m5Harness({ mode: 'paper', users: [] });
    m.intake.onModuleInit();
    expect(currentCoreAlertIntake()).toBe(m.intake); // registered (mode != off) …
    handOffChartinkHit(m.hitAt(500));
    await m.intake.idle();
    await m.pump();
    expect(m.h.paper.orders).toEqual([]); // … but nobody is admitted
    expect(m.store.rows).toEqual([]);
    m.intake.onModuleDestroy();
    expect(currentCoreAlertIntake()).toBeNull();
  });

  it('exits are never blocked by the journal, a reconciliation block or the latch: with all three against the user, the target exit still fills', async () => {
    const m = m5Harness();
    const [out] = await m.intake.process(m.hitAt(500));
    expect(out).toMatchObject({ kind: 'OPENED' });
    await m.h.price(500);
    await m.pump();
    await m.journal.recordNow({ type: 'RECON_MISMATCH', userId: 'user_A', at: new Date(), strategyId: null, payload: { check: 'FILLS_VS_ORDER' } });
    await m.journal.recordNow({ type: 'DAILY_LOSS_LATCHED', userId: 'user_A', at: new Date(), payload: { reason: 'test' } });
    expect(await m.reads.reconBlock('user_A')).toEqual({ all: true, strategyIds: [] });
    expect(await m.reads.latched('user_A', '2026-10-12')).toBe(true);
    m.store.failWrites = true; // and the journal database is down
    await m.h.price(515);
    await m.h.price(515);
    await m.h.settle();
    expect(m.h.positions.rows[0]).toMatchObject({ status: 'CLOSED', exitReason: 'TARGET' });
    // Entries, meanwhile, fail closed.
    const [next] = await m.intake.process(m.hitAt(1500, INFY));
    expect(next.kind).toBe('SKIPPED');
    expect(m.h.positions.rows).toHaveLength(1);
  });

  it('the kill-switch square-off (real CoreSquareOff) exits every open core position and cancels pending entry orders', async () => {
    const m = m5Harness();
    const [a] = await m.intake.process(m.hitAt(500));
    await m.h.price(500); // RELIANCE fills
    const [b] = await m.intake.process(m.hitAt(1500, INFY)); // INFY entry pending (no INFY price yet)
    expect(a).toMatchObject({ kind: 'OPENED' });
    expect(b).toMatchObject({ kind: 'OPENED' });
    m.h.killOn.add('user_A');
    const r = await m.squareOff.squareOffAll('user_A', 'KILL_SWITCH', 'owner pressed the kill switch');
    expect(r.exitsRequested + r.cancelledOrders).toBeGreaterThanOrEqual(2);
    await m.h.price(499);
    await m.h.price(1500, { token: '1594', symbol: 'INFY-EQ' });
    await m.h.price(499);
    await m.pump();
    for (const p of m.h.positions.rows) expect(['CLOSED', 'CANCELLED']).toContain(p.status);
    expect(m.h.positions.rows.find((p) => a.kind === 'OPENED' && p.id === a.positionId)).toMatchObject({ status: 'CLOSED', exitReason: 'KILL_SWITCH' });
    expect(m.h.positions.rows).toHaveLength(2);
    expect(m.h.positions.rows.find((p) => b.kind === 'OPENED' && p.id === b.positionId)?.status).toBe('CANCELLED');
    expect(await m.h.ledger.openOrdersForUser('user_A')).toEqual([]);
  });
});
