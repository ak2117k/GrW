import type { ModuleRef } from '@nestjs/core';
import type { CoreKillSwitch } from '@prisma/client';
import type { AuditService } from '../../../common/audit/audit.service';
import { PaperOrderSquareOff } from '../execution/paper-order-square-off';
import { createCoreSessionClock } from '../risk-wall/ports';
import type { CoreKillSwitchRepository, NewKillSwitchRow } from '../risk-wall/repositories/core-kill-switch.repository';
import { CoreKillSwitchService } from '../risk-wall/services/core-kill-switch.service';
import type { CoreRiskLimitService } from '../risk-wall/services/core-risk-limit.service';
import type { SiloSquareOffAdapter } from '../risk-wall/services/silo-square-off.adapter';
import { limitsFixture } from '../risk-wall/testing/risk-fixtures';
import { CoreRiskStateProvider } from './core-risk-state.provider';
import { CoreSquareOff } from './core-square-off';
import { DailyLossMonitor } from './daily-loss.monitor';
import { NOW } from './testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from './testing/lifecycle-harness';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

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

function seams(h: ReturnType<typeof lifecycleHarness>) {
  const moduleRef = { get: () => h.lifecycle } as unknown as ModuleRef;
  const squareOff = new CoreSquareOff(new PaperOrderSquareOff(h.ledger, h.matcher), moduleRef);
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) } as unknown as AuditService;
  return { squareOff, audit, provider: new CoreRiskStateProvider(h.ledger, h.positions.repo, h.lifecycle) };
}

const INFY = { exchange: 'NSE', token: '1594', symbol: 'INFY-EQ', lotSize: 1, underlying: null };

describe('M4 end to end (spec §10)', () => {
  it('replay: an Adaptive-shaped trade from entry to a closed position whose ledger reconciles', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest({ atr: 5 }, { strategyId: 'cs_adaptive', strategyVersionId: 'csv_adaptive_v1', stopPrice: 494 }));
    for (const ltp of [500, 505, 505, 508, 502.5, 502.5]) await h.price(ltp);
    expect(h.positions.rows[0]).toMatchObject({ status: 'CLOSED', exitReason: 'TRAIL', entryFilledQty: 100, exitFilledQty: 100, highWater: 508 });
    const funds = await h.ledger.funds('user_A');
    expect(funds.realisedPnl).toBe('375.00'); // 50 × +5.00 + 50 × +2.50
    expect(funds.blockedMargin).toBe('0.00');
    const net = (await h.ledger.netPnlTodayByPosition('user_A', new Date()))?.get(p.id)?.toFixed(2);
    expect(net).toBe((375 - Number(funds.charges)).toFixed(2));
    expect(h.sink.types(p.id).filter((t) => t === 'EXIT_DECIDED')).toHaveLength(2);
  });

  it('kill switch ON: the cascade cancels pending entries and exits every core position, then runs the silos', async () => {
    const h = lifecycleHarness();
    const { squareOff, audit } = seams(h);
    const filled = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    const pending = await h.lifecycle.openPosition(openRequest({ instrument: INFY }, { intentId: 'int_2', symbol: 'INFY-EQ', underlying: 'INFY' }));
    const silos = { squareOffAll: jest.fn().mockResolvedValue([{ target: 'auto-execution', status: 'OK', detail: 'set' }]) };
    const kill = new CoreKillSwitchService(new MemoryKillRepo() as unknown as CoreKillSwitchRepository, audit, createCoreSessionClock(), squareOff, silos as unknown as SiloSquareOffAdapter);
    const r = await kill.set({ userId: 'user_A', role: 'ADMIN' }, { active: true, reason: 'stop everything' }, new Date());
    await h.settle();
    expect(r.cascade?.core.status).toBe('OK');
    expect(r.cascade?.core.detail).toMatch(/^1 pending core entry order\(s\) cancelled; \d core position exit\(s\) requested/);
    expect(silos.squareOffAll).toHaveBeenCalledTimes(1);
    expect(h.positions.rows.find((x) => x.id === pending.id)).toMatchObject({ status: 'CANCELLED' });
    expect(h.positions.rows.find((x) => x.id === filled.id)).toMatchObject({ status: 'EXITING', exitReason: 'KILL_SWITCH' });
    await h.price(499);
    expect(h.positions.rows.find((x) => x.id === filled.id)).toMatchObject({ status: 'CLOSED', exitReason: 'KILL_SWITCH' });
  });

  it('daily loss: with BLOCK_AND_SQUARE_OFF a breach on marked P&L exits the user through the real provider', async () => {
    const h = lifecycleHarness();
    const { squareOff, audit, provider } = seams(h);
    const limits = { inForce: async () => limitsFixture({ 'maxDailyLoss@ALL': '500.00', 'dailyLossAction@ALL': 'BLOCK_AND_SQUARE_OFF' }) } as unknown as CoreRiskLimitService;
    const monitor = new DailyLossMonitor(h.positions.repo, provider, limits, squareOff, audit);
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    await h.price(494); // −600 gross, above the 492.5 stop
    await monitor.runOnce(new Date());
    await h.settle();
    expect(h.positions.rows.find((x) => x.id === p.id)).toMatchObject({ status: 'EXITING', exitReason: 'DAILY_LOSS' });
  });
});
