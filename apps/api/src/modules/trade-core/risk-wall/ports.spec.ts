import { Logger } from '@nestjs/common';
import { SessionClock } from '../../market-hub/session-clock';
import {
  createCoreSessionClock,
  LoggingRiskVerdictSink,
  NoCorePositionsSquareOff,
  RiskStateUnavailableError,
  UnavailableRiskStateProvider,
} from './ports';
import { exitVerdict } from './risk-wall';

describe('M2 default port bindings (fail closed, never silent)', () => {
  it('the core clock knows the exchange holidays', () => {
    const clock = createCoreSessionClock();
    expect(clock).toBeInstanceOf(SessionClock);
    expect(clock.isTradingDay('NSE', new Date('2026-10-20T05:00:00.000Z'))).toBe(false); // Dussehra
    expect(clock.nextOpen('NFO', new Date('2026-10-09T05:30:00.000Z'))).toEqual(new Date('2026-10-12T03:45:00.000Z'));
  });

  it('the live-state provider refuses until M3/M4 bind a real one', async () => {
    await expect(new UnavailableRiskStateProvider().liveState('user_A', new Date())).rejects.toBeInstanceOf(RiskStateUnavailableError);
    await expect(new UnavailableRiskStateProvider().liveState('user_A', new Date())).rejects.toThrow(/M3\/M4/);
  });

  it('the core square-off reports that no core orders or positions exist yet', async () => {
    expect(await new NoCorePositionsSquareOff().squareOffAll('user_A', 'KILL_SWITCH', 'test')).toEqual({
      cancelledOrders: 0,
      exitsRequested: 0,
      detail: 'no core orders or positions exist yet (M3/M4 add them)',
    });
  });

  it('the verdict sink logs one line per verdict', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await new LoggingRiskVerdictSink().record(exitVerdict({ kind: 'EXIT', intentId: 'x1', userId: 'user_A', positionId: 'p1', qty: 5 }, new Date()));
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('"intentId":"x1"');
    log.mockRestore();
  });
});
