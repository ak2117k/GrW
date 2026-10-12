import type { ModuleRef } from '@nestjs/core';
import type { CoreKillSwitch } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { AuditService } from '../../../common/audit/audit.service';
import type { SessionClock } from '../../market-hub/session-clock';
import { createCoreSessionClock, type RiskVerdictSink } from '../risk-wall/ports';
import type { CoreKillSwitchRepository, NewKillSwitchRow } from '../risk-wall/repositories/core-kill-switch.repository';
import { checkRisk } from '../risk-wall/risk-wall';
import { CoreKillSwitchService } from '../risk-wall/services/core-kill-switch.service';
import type { CoreRiskLimitService } from '../risk-wall/services/core-risk-limit.service';
import { RiskWallService } from '../risk-wall/services/risk-wall.service';
import type { SiloSquareOffAdapter } from '../risk-wall/services/silo-square-off.adapter';
import { ctxFixture, intentFixture, limitsFixture } from '../risk-wall/testing/risk-fixtures';
import { coreOrderOwner, PaperMatcherService } from './paper-matcher.service';
import { PaperLedgerService, type PlaceContext } from './paper-ledger.service';
import { PaperOrderSquareOff } from './paper-order-square-off';
import { PaperRiskStateProvider } from './paper-risk-state.provider';
import { FakeHub, fakeHubSource, fakeModuleRef } from './testing/fake-hub';
import { fakeDefaults, MemoryPaperStore } from './testing/memory-paper-store';
import { cashBuy, NOW, optionBuy } from './testing/paper-fixtures';

const OPEN: PlaceContext = { sessionOpen: true, killSwitchActive: false };
const AT = new Date(NOW.getTime() + 10);
const D = (s: string) => new Prisma.Decimal(s);

function setup() {
  const store = new MemoryPaperStore(() => NOW);
  const defaults = fakeDefaults();
  const hub = new FakeHub();
  const ledger = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, defaults);
  const matcher = new PaperMatcherService(ledger, defaults, fakeModuleRef(fakeHubSource({ user_A: hub })) as unknown as ModuleRef, { isOpen: () => true });
  return { store, hub, ledger, matcher, provider: new PaperRiskStateProvider(ledger), squareOff: new PaperOrderSquareOff(ledger, matcher) };
}

describe('RISK_STATE_PROVIDER (paper)', () => {
  it("reports deployed capital, open positions, today's net P&L and entries; P&L and pricing stay fail-closed", async () => {
    const { ledger, provider } = setup();
    const { order } = await ledger.place(cashBuy(), OPEN, NOW);
    await ledger.applyFill('user_A', order.id, order, { qty: 100, price: D('500.7'), priceAt: AT });
    expect(await provider.liveState('user_A', NOW)).toEqual({
      asOf: NOW,
      openPositions: [
        { positionId: 'CASH_INTRADAY:2885', strategyId: '', vehicle: 'CASH_INTRADAY', symbol: 'RELIANCE-EQ', underlying: 'RELIANCE-EQ', direction: 'LONG', state: 'OPEN', priced: false },
      ],
      realisedPnlToday: -26.92,
      openPnl: null,
      pnlTodayByStrategy: {},
      tradesToday: 1,
      deployedCapital: { CASH_INTRADAY: 10014, MTF: 0, OPTIONS_BUY: 0 },
      dailyLossLatched: false,
    });
  });

  it('a bought PE is SHORT its underlying', async () => {
    const { ledger, provider } = setup();
    const req = optionBuy({ instrument: { exchange: 'NFO', token: '43522', symbol: 'NIFTY13OCT2625000PE', lotSize: 75, underlying: 'NIFTY' } });
    const { order } = await ledger.place(req, OPEN, NOW);
    await ledger.applyFill('user_A', order.id, order, { qty: 150, price: D('100'), priceAt: AT });
    const [p] = (await provider.liveState('user_A', NOW)).openPositions;
    expect(p).toMatchObject({ vehicle: 'OPTIONS_BUY', underlying: 'NIFTY', direction: 'SHORT' });
  });

  it('with this state the Risk Wall still rejects every entry until M4 (P&L unknown)', async () => {
    const { provider } = setup();
    const v = checkRisk(intentFixture(), ctxFixture({ state: await provider.liveState('user_A', NOW) }));
    expect(v.verdict).toBe('REJECT');
    expect(v.reasons.map((r) => r.code)).toContain('PNL_UNKNOWN');
  });

  it('an unreadable ledger fails closed: liveState throws and the Risk Wall rejects (CONTEXT_UNAVAILABLE)', async () => {
    const { ledger, provider } = setup();
    jest.spyOn(ledger, 'funds').mockRejectedValue(new Error('ledger down'));
    await expect(provider.liveState('user_A', NOW)).rejects.toThrow('ledger down');
    const wall = new RiskWallService(
      { inForce: jest.fn().mockResolvedValue(limitsFixture()) } as unknown as CoreRiskLimitService,
      { isActive: jest.fn().mockResolvedValue(false) } as unknown as CoreKillSwitchService,
      provider,
      { record: jest.fn().mockResolvedValue(undefined) } as RiskVerdictSink,
      { isOpen: () => true } as unknown as SessionClock,
    );
    const v = await wall.check(intentFixture(), NOW);
    expect(v.verdict).toBe('REJECT');
    expect(v.reasons.map((r) => r.code)).toEqual(['CONTEXT_UNAVAILABLE']);
  });

  it('an unparseable deployed amount is reported unknown (null), never as 0', async () => {
    const { ledger, provider } = setup();
    const funds = await ledger.funds('user_A');
    jest.spyOn(ledger, 'funds').mockResolvedValue({ ...funds, deployedByVehicle: { ...funds.deployedByVehicle, MTF: 'garbage' } });
    expect((await provider.liveState('user_A', NOW)).deployedCapital.MTF).toBeNull();
  });
});

describe('CORE_SQUARE_OFF (paper)', () => {
  it("cancels every pending core order of the user and nothing of another user's", async () => {
    const { store, ledger, matcher, squareOff } = setup();
    const a1 = (await ledger.place(cashBuy(), OPEN, NOW)).order;
    const a2 = (await ledger.place(optionBuy(), OPEN, NOW)).order;
    const b1 = (await ledger.place(cashBuy({ userId: 'user_B', idempotencyKey: 'kb' }), OPEN, NOW)).order;
    for (const o of [a1, a2, b1]) matcher.track(o, 30_000, NOW.getTime());
    expect(await squareOff.squareOffAll('user_A', 'KILL_SWITCH', 'stop everything')).toEqual({
      cancelledOrders: 2,
      exitsRequested: 0,
      detail: '2 pending core order(s) cancelled; open core positions are exited by the lifecycle (M4), none in M3',
    });
    expect(store.orders.map((o) => [o.userId, o.state])).toEqual([['user_A', 'CANCELLED'], ['user_A', 'CANCELLED'], ['user_B', 'OPEN']]);
    expect([a1, a2, b1].map((o) => matcher.isTracked(o.id))).toEqual([false, false, true]);
  });

  it('a failed cancellation makes the step fail, never a silent partial OK', async () => {
    const { ledger, squareOff } = setup();
    await ledger.place(cashBuy(), OPEN, NOW);
    await ledger.place(optionBuy(), OPEN, NOW);
    jest.spyOn(ledger, 'close').mockRejectedValueOnce(new Error('db down'));
    await expect(squareOff.squareOffAll('user_A', 'KILL_SWITCH', 'stop')).rejects.toThrow('cancelled 1 of 2 pending core orders; failed: ');
  });
});

/** Minimal CoreKillSwitchRepository with the append-only contract the service needs. */
class MemoryKillRepo {
  rows: CoreKillSwitch[] = [];

  async listForUser(userId: string) {
    return this.rows.filter((r) => r.userId === userId);
  }

  async append(userId: string, row: NewKillSwitchRow, now: Date) {
    const r = { id: `ks_${this.rows.length + 1}`, userId, ...row, createdAt: now } as CoreKillSwitch;
    this.rows.push(r);
    return r;
  }
}

describe('kill switch ON → CORE_SQUARE_OFF (paper)', () => {
  it("cancels the user's pending core orders, releases their margin and hub watches, then runs the silos", async () => {
    const { store, hub, ledger, matcher, squareOff } = setup();
    const a1 = (await ledger.place(cashBuy(), OPEN, NOW)).order;
    const a2 = (await ledger.place(optionBuy(), OPEN, NOW)).order;
    for (const o of [a1, a2]) matcher.track(o, 30_000, NOW.getTime());
    expect((await ledger.funds('user_A')).blockedMargin).not.toBe('0.00');
    expect(hub.watches.map((w) => w.owner)).toEqual([coreOrderOwner(a1.id), coreOrderOwner(a2.id)]);

    const silos = { squareOffAll: jest.fn().mockResolvedValue([{ target: 'auto-execution', status: 'OK', detail: 'set' }]) };
    const kill = new CoreKillSwitchService(
      new MemoryKillRepo() as unknown as CoreKillSwitchRepository,
      { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) } as unknown as AuditService,
      createCoreSessionClock(),
      squareOff,
      silos as unknown as SiloSquareOffAdapter,
    );
    const r = await kill.set({ userId: 'user_A', role: 'USER' }, { active: true, reason: 'stop' }, NOW);

    expect(r.cascade?.core).toEqual({
      status: 'OK',
      detail: '2 pending core order(s) cancelled; open core positions are exited by the lifecycle (M4), none in M3 (cancelled 2 orders, requested 0 exits)',
    });
    expect(silos.squareOffAll).toHaveBeenCalledTimes(1);
    expect(store.orders.map((o) => o.state)).toEqual(['CANCELLED', 'CANCELLED']);
    expect((await ledger.funds('user_A')).blockedMargin).toBe('0.00');
    expect(store.ledger.filter((e) => e.type === 'MARGIN_RELEASE').map((e) => e.orderId)).toEqual([a1.id, a2.id]);
    expect([a1, a2].map((o) => matcher.isTracked(o.id))).toEqual([false, false]);
    expect(hub.unwatches.map((w) => w.owner)).toEqual([coreOrderOwner(a1.id), coreOrderOwner(a2.id)]);
  });
});
