import { AiGatewayService } from './ai-gateway.service';
import { OUTAGE_AFTER_FAILURES, OUTAGE_REALERT_MS, ProviderOutageAlert } from './provider-outage-alert';
import { AiQueueTimeout, PriorityScheduler } from './scheduler/priority-scheduler';

function make() {
  let at = Date.parse('2026-11-05T19:45:00Z'); // Fri 6 Nov 01:15 IST
  const send = jest.fn(async () => true);
  return { send, alert: new ProviderOutageAlert(send, () => at), advance: (ms: number) => (at += ms) };
}

const failTimes = (a: ProviderOutageAlert, n: number) => {
  for (let i = 0; i < n; i++) a.failure('claude-cli', new Error('usage limit reached'));
};

describe('ProviderOutageAlert', () => {
  it('stays quiet below the threshold, then alerts once with the real error', () => {
    const { alert, send } = make();
    failTimes(alert, OUTAGE_AFTER_FAILURES - 1);
    expect(send).not.toHaveBeenCalled();
    failTimes(alert, 3);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('AI_PROVIDER_DOWN:claude-cli', expect.stringContaining('usage limit reached'));
    expect(send).toHaveBeenCalledWith('AI_PROVIDER_DOWN:claude-cli', expect.stringContaining('6 Nov'));
  });

  it('one success before the threshold resets the streak without announcing anything', () => {
    const { alert, send } = make();
    failTimes(alert, OUTAGE_AFTER_FAILURES - 1);
    alert.success('claude-cli');
    failTimes(alert, OUTAGE_AFTER_FAILURES - 1);
    expect(send).not.toHaveBeenCalled();
  });

  it('repeats during a long outage only after the re-alert gap', () => {
    const { alert, send, advance } = make();
    failTimes(alert, OUTAGE_AFTER_FAILURES);
    advance(OUTAGE_REALERT_MS - 1);
    failTimes(alert, 1);
    expect(send).toHaveBeenCalledTimes(1);
    advance(1);
    failTimes(alert, 1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('announces the recovery once', () => {
    const { alert, send } = make();
    failTimes(alert, OUTAGE_AFTER_FAILURES);
    alert.success('claude-cli');
    alert.success('claude-cli');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('AI_PROVIDER_RECOVERED:claude-cli', expect.stringContaining('back'));
  });

  it('a failing send never reaches the caller', () => {
    const throws = new ProviderOutageAlert(() => {
      throw new Error('send broke');
    });
    const rejects = new ProviderOutageAlert(async () => {
      throw new Error('send broke');
    });
    expect(() => failTimes(throws, OUTAGE_AFTER_FAILURES)).not.toThrow();
    expect(() => failTimes(rejects, OUTAGE_AFTER_FAILURES)).not.toThrow();
  });
});

describe('AiGatewayService reports provider health', () => {
  const route = { provider: 'claude-cli', fallback: [], model: null, maxWaitMs: 1000 };
  const request = { model: 'claude-opus-5', max_tokens: 10, messages: [] } as never;

  function gateway(send: jest.Mock, scheduler: unknown = new PriorityScheduler({})) {
    const outage = { failure: jest.fn(), success: jest.fn() };
    const svc = new AiGatewayService({
      routes: { 'sentinel.judge': route } as never,
      prices: new Map(),
      meter: {} as never,
      scheduler: scheduler as never,
      adapters: { 'claude-cli': { name: 'claude-cli', send } as never },
      audit: { insert: async () => undefined },
      outage,
    });
    return { svc, outage };
  }

  it('a provider failure is reported with its error, and the original error still reaches the caller', async () => {
    const err = new Error('claude CLI: the call failed');
    const { svc, outage } = gateway(jest.fn().mockRejectedValue(err));
    await expect(svc.call('sentinel.judge', request)).rejects.toBe(err);
    expect(outage.failure).toHaveBeenCalledWith('claude-cli', err);
    expect(outage.success).not.toHaveBeenCalled();
  });

  it('a successful call is reported', async () => {
    const send = jest.fn().mockResolvedValue({ message: { stop_reason: 'end_turn', content: [] }, meta: {} });
    const { svc, outage } = gateway(send);
    await svc.call('sentinel.judge', request);
    expect(outage.success).toHaveBeenCalledWith('claude-cli');
    expect(outage.failure).not.toHaveBeenCalled();
  });

  it('a queue timeout is our own backlog, not a provider failure', async () => {
    const timeout = Object.create(AiQueueTimeout.prototype) as AiQueueTimeout;
    const { svc, outage } = gateway(jest.fn(), { run: jest.fn().mockRejectedValue(timeout) });
    await expect(svc.call('sentinel.judge', request)).rejects.toBe(timeout);
    expect(outage.failure).not.toHaveBeenCalled();
  });
});
