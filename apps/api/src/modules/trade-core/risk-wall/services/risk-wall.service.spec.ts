import type { SessionClock } from '../../../market-hub/session-clock';
import { UnavailableRiskStateProvider, type RiskStateProvider, type RiskVerdictSink } from '../ports';
import type { RiskVerdict } from '../risk-wall.types';
import { intentFixture, limitsFixture, NOW, optionIntent, stateFixture } from '../testing/risk-fixtures';
import type { CoreKillSwitchService } from './core-kill-switch.service';
import type { CoreRiskLimitService } from './core-risk-limit.service';
import { RiskWallService } from './risk-wall.service';

const codes = (v: RiskVerdict) => v.reasons.map((r) => r.code);

function setup(state: RiskStateProvider = { liveState: jest.fn().mockResolvedValue(stateFixture()) }) {
  const limits = { inForce: jest.fn().mockResolvedValue(limitsFixture()) };
  const kill = { isActive: jest.fn().mockResolvedValue(false) };
  const sink = { record: jest.fn().mockResolvedValue(undefined) };
  const clock = { isOpen: jest.fn().mockReturnValue(true) };
  const service = new RiskWallService(
    limits as unknown as CoreRiskLimitService,
    kill as unknown as CoreKillSwitchService,
    state,
    sink as RiskVerdictSink,
    clock as unknown as SessionClock,
  );
  return { limits, kill, sink, clock, state, service };
}

describe('RiskWallService', () => {
  it('reads only the intent user’s limits, kill switch and live state, and records the verdict', async () => {
    const { limits, kill, state, clock, sink, service } = setup();
    const v = await service.check(intentFixture(), NOW);
    expect(v).toMatchObject({ verdict: 'ALLOW', qty: 50 });
    expect(limits.inForce).toHaveBeenCalledWith('user_A', NOW);
    expect(kill.isActive).toHaveBeenCalledWith('user_A', NOW);
    expect(state.liveState).toHaveBeenCalledWith('user_A', NOW);
    expect(clock.isOpen).toHaveBeenCalledWith('NSE', NOW);
    expect(sink.record).toHaveBeenCalledWith(v);
  });

  it('asks the clock about the intent’s own exchange', async () => {
    const { clock, service } = setup();
    clock.isOpen.mockReturnValue(false);
    const v = await service.check(optionIntent(), NOW);
    expect(clock.isOpen).toHaveBeenCalledWith('NFO', NOW);
    expect(codes(v)).toEqual(['SESSION_CLOSED']);
  });

  it('the kill switch rejects', async () => {
    const { kill, service } = setup();
    kill.isActive.mockResolvedValue(true);
    expect(codes(await service.check(intentFixture(), NOW))).toEqual(['KILL_SWITCH']);
  });

  it('the M2 default state provider rejects every entry, keeping the limits it had loaded', async () => {
    const { sink, service } = setup(new UnavailableRiskStateProvider());
    const v = await service.check(intentFixture(), NOW);
    expect(v).toMatchObject({ verdict: 'REJECT', qty: 0, killSwitchActive: false });
    expect(codes(v)).toEqual(['CONTEXT_UNAVAILABLE']);
    expect(v.reasons[0].message).toContain('M3/M4');
    expect(v.limits).toHaveLength(21);
    expect(sink.record).toHaveBeenCalledWith(v);
  });

  it('a failing limit load rejects and never throws', async () => {
    const { limits, service } = setup();
    limits.inForce.mockRejectedValue(new Error('db down'));
    const v = await service.check(intentFixture(), NOW);
    expect(codes(v)).toEqual(['CONTEXT_UNAVAILABLE']);
    expect(v.reasons[0].message).toContain('db down');
  });

  it('a recording failure turns ALLOW into REJECT and keeps the snapshot', async () => {
    const { sink, service } = setup();
    sink.record.mockRejectedValue(new Error('journal down'));
    const v = await service.check(intentFixture(), NOW);
    expect(v).toMatchObject({ verdict: 'REJECT', qty: 0, requestedQty: 50 });
    expect(codes(v)).toEqual(['JOURNAL_UNAVAILABLE']);
    expect(v.limits).toHaveLength(21);
    expect(v.state).not.toBeNull();
  });

  it('a REJECT stays the same REJECT when recording fails', async () => {
    const { kill, sink, service } = setup();
    kill.isActive.mockResolvedValue(true);
    sink.record.mockRejectedValue(new Error('journal down'));
    expect(codes(await service.check(intentFixture(), NOW))).toEqual(['KILL_SWITCH']);
  });

  it('exits pass without loading context, even when recording fails', async () => {
    const { limits, kill, state, sink, service } = setup();
    sink.record.mockRejectedValue(new Error('journal down'));
    const v = await service.check({ kind: 'EXIT', intentId: 'x1', userId: 'user_A', positionId: 'p1', qty: 10 }, NOW);
    expect(v).toMatchObject({ verdict: 'ALLOW', qty: 10 });
    expect(codes(v)).toEqual(['EXIT_NOT_CHECKED']);
    expect(limits.inForce).not.toHaveBeenCalled();
    expect(kill.isActive).not.toHaveBeenCalled();
    expect(state.liveState).not.toHaveBeenCalled();
  });
});
