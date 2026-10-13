import type { AuditService } from '../../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../../common/audit/audit-actions';
import type { CoreSquareOffPort, RiskStateProvider } from '../risk-wall/ports';
import type { CoreRiskLimitService } from '../risk-wall/services/core-risk-limit.service';
import { FakeJournal } from '../journal/testing/fake-journal';
import { limitsFixture, NOW, positionFixture, stateFixture } from '../risk-wall/testing/risk-fixtures';
import { DAILY_LOSS_CHECK_MS, DailyLossMonitor } from './daily-loss.monitor';
import type { CorePositionRepository } from './repositories/core-position.repository';

function setup(o: { action?: string; realised?: number; openPnl?: number | null; users?: string[]; stateFails?: boolean; squareOffFailsOnce?: boolean } = {}) {
  const positions = { listActiveUserIds: jest.fn().mockResolvedValue(o.users ?? ['user_A']) };
  const state = {
    liveState: o.stateFails
      ? jest.fn().mockRejectedValue(new Error('ledger down'))
      : jest.fn().mockResolvedValue(stateFixture({ realisedPnlToday: o.realised ?? -4000, openPnl: o.openPnl === undefined ? -1500 : o.openPnl })),
  };
  const limits = { inForce: jest.fn().mockResolvedValue(limitsFixture({ 'dailyLossAction@ALL': o.action ?? 'BLOCK_AND_SQUARE_OFF' })) };
  const squareOff = { squareOffAll: jest.fn().mockResolvedValue({ cancelledOrders: 0, exitsRequested: 1, detail: '0 pending core entry order(s) cancelled; 1 core position exit(s) requested' }) };
  if (o.squareOffFailsOnce) squareOff.squareOffAll.mockRejectedValueOnce(new Error('exit failed'));
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const monitor = new DailyLossMonitor(
    positions as unknown as CorePositionRepository,
    state as unknown as RiskStateProvider,
    limits as unknown as CoreRiskLimitService,
    squareOff as unknown as CoreSquareOffPort,
    audit as unknown as AuditService,
  );
  return { positions, state, limits, squareOff, audit, monitor };
}

describe('DailyLossMonitor (spec §5.3, ruling L15)', () => {
  it("BLOCK_AND_SQUARE_OFF: a breach squares off the user's core once per IST day, audited", async () => {
    const s = setup(); // loss 4000 + 1500 = 5500 ≥ the 5000 limit
    await s.monitor.runOnce(NOW);
    await s.monitor.runOnce(NOW);
    expect(s.squareOff.squareOffAll).toHaveBeenCalledTimes(1);
    expect(s.squareOff.squareOffAll).toHaveBeenCalledWith('user_A', 'DAILY_LOSS', "today's loss ₹5500.00 reached the ₹5000.00 daily limit");
    expect(s.audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.lifecycle.CORE_DAILY_LOSS_SQUARE_OFF, userId: 'user_A' }));
    await s.monitor.runOnce(new Date(NOW.getTime() + 86_400_000));
    expect(s.squareOff.squareOffAll).toHaveBeenCalledTimes(2);
  });

  it('BLOCK_ENTRIES never squares off (the Risk Wall blocks entries)', async () => {
    const s = setup({ action: 'BLOCK_ENTRIES' });
    await s.monitor.runOnce(NOW);
    expect(s.squareOff.squareOffAll).not.toHaveBeenCalled();
  });

  it('within the limit, or with the P&L unknown, nothing happens', async () => {
    const within = setup({ realised: -100 });
    await within.monitor.runOnce(NOW);
    const unknown = setup({ openPnl: null });
    await unknown.monitor.runOnce(NOW);
    expect(within.squareOff.squareOffAll).not.toHaveBeenCalled();
    expect(unknown.squareOff.squareOffAll).not.toHaveBeenCalled();
  });

  it('owner ruling 2026-10-12: realised loss at the limit with open P&L unknown (blind) squares off once per day', async () => {
    const s = setup({ realised: -5000, openPnl: null });
    await s.monitor.runOnce(NOW);
    await s.monitor.runOnce(NOW);
    expect(s.squareOff.squareOffAll).toHaveBeenCalledTimes(1);
    expect(s.squareOff.squareOffAll).toHaveBeenCalledWith(
      'user_A', 'DAILY_LOSS', "today's realised loss ₹5000.00 reached the ₹5000.00 daily limit (open P&L unknown)",
    );
    expect(s.audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.lifecycle.CORE_DAILY_LOSS_SQUARE_OFF, userId: 'user_A' }));
  });

  it('realised loss under the limit with open P&L unknown does nothing', async () => {
    const s = setup({ realised: -4999.99, openPnl: null });
    await s.monitor.runOnce(NOW);
    expect(s.squareOff.squareOffAll).not.toHaveBeenCalled();
  });

  it('an unreadable state skips the user and never exits', async () => {
    const s = setup({ stateFails: true });
    await expect(s.monitor.runOnce(NOW)).resolves.toBeUndefined();
    expect(s.squareOff.squareOffAll).not.toHaveBeenCalled();
  });

  it('a failed square-off is retried on the next check', async () => {
    const s = setup({ squareOffFailsOnce: true });
    await s.monitor.runOnce(NOW);
    await s.monitor.runOnce(NOW);
    expect(s.squareOff.squareOffAll).toHaveBeenCalledTimes(2);
  });

  it('an audit failure, even a synchronous throw, never repeats the square-off that day', async () => {
    const s = setup();
    s.audit.append.mockImplementation(() => {
      throw new Error('audit down');
    });
    await s.monitor.runOnce(NOW);
    await s.monitor.runOnce(NOW);
    expect(s.squareOff.squareOffAll).toHaveBeenCalledTimes(1);
  });

  describe('the timer (setInterval gated by bootJobsEnabled, no @Cron)', () => {
    const saved = process.env.BOOT_JOBS;
    afterEach(() => {
      if (saved === undefined) delete process.env.BOOT_JOBS;
      else process.env.BOOT_JOBS = saved;
      jest.useRealTimers();
    });

    it(`checks every ${DAILY_LOSS_CHECK_MS} ms and stops on destroy`, async () => {
      delete process.env.BOOT_JOBS;
      jest.useFakeTimers();
      const s = setup();
      s.monitor.onModuleInit();
      await jest.advanceTimersByTimeAsync(DAILY_LOSS_CHECK_MS);
      expect(s.positions.listActiveUserIds).toHaveBeenCalledTimes(1);
      s.monitor.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(DAILY_LOSS_CHECK_MS * 3);
      expect(s.positions.listActiveUserIds).toHaveBeenCalledTimes(1);
    });

    it('BOOT_JOBS=false starts no timer', async () => {
      process.env.BOOT_JOBS = 'false';
      jest.useFakeTimers();
      const s = setup();
      s.monitor.onModuleInit();
      await jest.advanceTimersByTimeAsync(DAILY_LOSS_CHECK_MS * 3);
      expect(s.positions.listActiveUserIds).not.toHaveBeenCalled();
    });
  });

  it('only users with active positions are checked', async () => {
    const s = setup({ users: [] });
    await s.monitor.runOnce(NOW);
    expect(s.state.liveState).not.toHaveBeenCalled();
  });
});

describe('DailyLossMonitor — the persisted latch (M5 J13, O13)', () => {
  const NOW_M5 = new Date('2026-10-13T05:00:00.000Z');
  function latchSetup(state: ReturnType<typeof stateFixture>, limits = limitsFixture()) {
    const journal = new FakeJournal();
    const squareOff = { squareOffAll: jest.fn().mockResolvedValue({ cancelledOrders: 0, exitsRequested: 0, detail: 'x' }) };
    const monitor = new DailyLossMonitor(
      { listActiveUserIds: async () => ['user_A'] } as unknown as CorePositionRepository,
      { liveState: async () => state } as unknown as RiskStateProvider,
      { inForce: async () => limits } as unknown as CoreRiskLimitService,
      squareOff as unknown as CoreSquareOffPort,
      { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) } as unknown as AuditService,
      journal,
    );
    return { journal, squareOff, monitor };
  }

  it('BLOCK_ENTRIES: a breach latches the IST day once and does not square off', async () => {
    const s = latchSetup(stateFixture({ realisedPnlToday: -6000, openPnl: 0 }));
    await s.monitor.runOnce(NOW_M5);
    await s.monitor.runOnce(NOW_M5);
    expect(s.journal.ofType('DAILY_LOSS_LATCHED')).toEqual([
      expect.objectContaining({ userId: 'user_A', dedupeKey: 'latch:user_A:2026-10-13', payload: expect.objectContaining({ day: '2026-10-13', source: 'DAILY_LOSS_MONITOR', action: 'BLOCK_ENTRIES' }) }),
    ]);
    expect(s.squareOff.squareOffAll).not.toHaveBeenCalled();
  });

  it('BLOCK_AND_SQUARE_OFF: the latch is written and the square-off (an exit) still runs', async () => {
    const s = latchSetup(stateFixture({ realisedPnlToday: -6000, openPnl: 0 }), limitsFixture({ 'dailyLossAction@ALL': 'BLOCK_AND_SQUARE_OFF' }));
    await s.monitor.runOnce(NOW_M5);
    expect(s.journal.ofType('DAILY_LOSS_LATCHED')).toHaveLength(1);
    expect(s.squareOff.squareOffAll).toHaveBeenCalledTimes(1);
  });

  it('a journal outage never blocks the square-off (exits are never blocked); the latch is retried without a second square-off', async () => {
    const s = latchSetup(stateFixture({ realisedPnlToday: -6000, openPnl: 0 }), limitsFixture({ 'dailyLossAction@ALL': 'BLOCK_AND_SQUARE_OFF' }));
    s.journal.failNow = true;
    await expect(s.monitor.runOnce(NOW_M5)).resolves.toBeUndefined();
    expect(s.squareOff.squareOffAll).toHaveBeenCalledTimes(1);
    expect(s.journal.ofType('DAILY_LOSS_LATCHED')).toEqual([]);
    s.journal.failNow = false;
    await s.monitor.runOnce(NOW_M5);
    expect(s.journal.ofType('DAILY_LOSS_LATCHED')).toHaveLength(1);
    expect(s.squareOff.squareOffAll).toHaveBeenCalledTimes(1);
    await s.monitor.runOnce(NOW_M5);
    expect(s.journal.ofType('DAILY_LOSS_LATCHED')).toHaveLength(1);
  });

  it('a journal write that never returns does not delay the square-off (it is requested before the latch)', async () => {
    const s = latchSetup(stateFixture({ realisedPnlToday: -6000, openPnl: 0 }), limitsFixture({ 'dailyLossAction@ALL': 'BLOCK_AND_SQUARE_OFF' }));
    jest.spyOn(s.journal, 'recordNow').mockReturnValue(new Promise<void>(() => undefined));
    void s.monitor.runOnce(NOW_M5);
    await new Promise((r) => setImmediate(r));
    expect(s.squareOff.squareOffAll).toHaveBeenCalledWith('user_A', 'DAILY_LOSS', expect.any(String));
    expect(s.journal.recordNow).toHaveBeenCalled();
  });

  it('owner ruling 2026-10-12: a realised-only breach with a blind position latches too', async () => {
    const s = latchSetup(stateFixture({ realisedPnlToday: -5000, openPnl: null, openPositions: [positionFixture({ priced: false })] }));
    await s.monitor.runOnce(NOW_M5);
    expect(s.journal.ofType('DAILY_LOSS_LATCHED')).toHaveLength(1);
  });

  it('a latch that cannot be written is retried on the next check and never throws; under the limit nothing latches', async () => {
    const s = latchSetup(stateFixture({ realisedPnlToday: -6000, openPnl: 0 }));
    s.journal.failNow = true;
    await expect(s.monitor.runOnce(NOW_M5)).resolves.toBeUndefined();
    s.journal.failNow = false;
    await s.monitor.runOnce(NOW_M5);
    expect(s.journal.ofType('DAILY_LOSS_LATCHED')).toHaveLength(1);
    const ok = latchSetup(stateFixture({ realisedPnlToday: -100, openPnl: 0 }));
    await ok.monitor.runOnce(NOW_M5);
    expect(ok.journal.entries).toEqual([]);
  });
});
