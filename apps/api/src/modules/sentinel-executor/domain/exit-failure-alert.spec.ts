import { ExitFailureAlerts, exitFailStreakFrom, scrubBrokerMessage } from './exit-failure-alert';
import { SentinelExitExecutor } from '../services/sentinel-exit-executor.service';
import { sendOpsAlert } from '../../../common/utils/ops-alert';

jest.mock('../../../common/utils/ops-alert', () => ({ sendOpsAlert: jest.fn().mockResolvedValue(true) }));

const MIN = 60_000;
const ev = (trackerId = 't1', brokerMessage: string | null = 'no answer (empty)') => ({
  trackerId,
  symbol: 'NIFTY25OCT25000CE',
  reason: 'BROKER_READ',
  brokerMessage,
});

describe('ExitFailureAlerts', () => {
  it('alerts on the first FAILED, then at most once per tracker per 30 min', () => {
    const a = new ExitFailureAlerts(3);
    const first = a.failed(ev(), 0);
    expect(first).not.toBeNull();
    expect(first!.key).toBe('ai-exit-failed:t1');
    expect(first!.text).toContain('NIFTY25OCT25000CE');
    expect(first!.text).toContain('BROKER_READ');
    expect(first!.text).toContain('no answer (empty)');
    // a retry loop failing every cycle: silent inside the window
    for (let m = 1; m < 30; m++) expect(a.failed(ev(), m * MIN)).toBeNull();
    // other trackers are independent
    expect(a.failed(ev('t2'), 5 * MIN)).not.toBeNull();
    const again = a.failed(ev(), 30 * MIN);
    expect(again).not.toBeNull();
    expect(again!.streak).toBe(31);
    expect(again!.text).toContain('REPEATED');
  });

  it('marks the streak REPEATED at N and resets it after a success', () => {
    const a = new ExitFailureAlerts(3, 0); // no cooldown, to see every message
    expect(a.failed(ev(), 0)!.text).not.toContain('in a row');
    expect(a.failed(ev(), 1)!.text).toContain('(2 in a row)');
    expect(a.failed(ev(), 2)!.text).toContain('REPEATED — 3 in a row');
    a.succeeded('t1');
    expect(a.failed(ev(), 3)!.streak).toBe(1);
  });

  it('AI_EXIT_FAIL_ALERT_STREAK parses to a positive integer, default 3', () => {
    expect(exitFailStreakFrom(undefined)).toBe(3);
    expect(exitFailStreakFrom('x')).toBe(3);
    expect(exitFailStreakFrom('0')).toBe(3);
    expect(exitFailStreakFrom('5')).toBe(5);
  });

  it('never carries credentials in the broker message', () => {
    const jwt = 'eyJhbGciOiJIUzUxMiJ9.eyJ1c2VybmFtZSI6IkExMjMifQ.c2lnbmF0dXJlLXZhbHVlLWhlcmU';
    const s = scrubBrokerMessage(`AG8001 Invalid Token ${jwt} apikey=abc123 password: hunter2 ${'Z'.repeat(40)}`);
    expect(s).not.toContain('eyJ');
    expect(s).not.toContain('abc123');
    expect(s).not.toContain('hunter2');
    expect(s).not.toContain('Z'.repeat(40));
    expect(s).toContain('AG8001 Invalid Token');
    expect(scrubBrokerMessage('x'.repeat(500)).length).toBeLessThanOrEqual(200);
    expect(scrubBrokerMessage(null)).toBe('none');
  });
});

describe('SentinelExitExecutor → failure alert wiring', () => {
  beforeEach(() => (sendOpsAlert as jest.Mock).mockClear());

  function executor(): { finish: (...a: unknown[]) => Promise<unknown> } {
    const repo = { update: jest.fn().mockResolvedValue(undefined) };
    const x = new SentinelExitExecutor(repo as never, {} as never, {} as never, {} as never, (() => Promise.resolve()) as never, {} as never);
    jest.spyOn((x as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
    return x as unknown as { finish: (...a: unknown[]) => Promise<unknown> };
  }
  const v = { id: 'v1', userId: 'u1', trackerId: 'trk1', symbol: 'CRUDEOIL25NOV6000CE', reason: 'x', createdAt: new Date() };

  it('a FAILED exit sends ONE ops alert per tracker, repeats inside 30 min are de-duplicated', async () => {
    const x = executor();
    for (let i = 0; i < 10; i++) await x.finish('id', v, 'FAILED', 'BROKER_READ', { brokerMessage: 'no answer (empty)' });
    expect(sendOpsAlert).toHaveBeenCalledTimes(1);
    const [key, text] = (sendOpsAlert as jest.Mock).mock.calls[0];
    expect(key).toBe('ai-exit-failed:trk1');
    expect(text).toContain('CRUDEOIL25NOV6000CE');
    expect(text).toContain('BROKER_READ');
  });

  it('non-FAILED outcomes do not alert', async () => {
    const x = executor();
    await x.finish('id', v, 'SKIPPED', 'MARKET_CLOSED');
    await x.finish('id', v, 'REJECTED', 'NO_POSITION');
    await x.finish('id', v, 'FILLED');
    expect(sendOpsAlert).not.toHaveBeenCalled();
  });
});
