import { LIVE_RESERVED_SLOTS, JUDGE_CONCURRENCY } from '../../trade-sentinel/services/sentinel-cycle.service';
import { SignalJudgeService } from './signal-judge.service';

const okReply = { content: [{ type: 'text', text: '{"verdict":"TAKE","confidence":70,"reasons":["r"],"entry":null,"sl":null,"targets":[],"lots":null}' }], stop_reason: 'end_turn' };

/** A runShared double with the sentinel's rule: never the reserved live slot. */
function cycle(inFlight: number) {
  return {
    runShared: jest.fn(async (_id: string, work: () => Promise<unknown>, opts: { expired?: () => boolean } = {}) => {
      for (;;) {
        if (opts.expired?.()) throw new Error('expired');
        if (inFlight < JUDGE_CONCURRENCY - LIVE_RESERVED_SLOTS) return work();
        await new Promise((r) => setTimeout(r, 5));
      }
    }),
  };
}

const opts = { model: 'claude-opus-5', timeoutMs: 200, slotWaitMs: 100, userId: 'owner' };

describe('SignalJudgeService', () => {
  it('runs through the shared (non-reserved) slot and parses the verdict', async () => {
    const c = cycle(0);
    const transport = { messages: { create: jest.fn(async () => okReply) } };
    const svc = new SignalJudgeService({ get: () => undefined } as never, c as never, undefined, undefined, transport as never);
    const r = await svc.judge({ a: 1 }, opts);
    expect(r).toMatchObject({ ok: true, verdict: { verdict: 'TAKE', confidence: 70 } });
    expect(c.runShared).toHaveBeenCalledTimes(1);
    const req = (transport.messages.create.mock.calls[0] as any[])[0];
    expect(req.model).toBe('claude-opus-5');
  });

  it('no free non-reserved slot (live exit holding it) → judge_unavailable, never started', async () => {
    const transport = { messages: { create: jest.fn(async () => okReply) } };
    const svc = new SignalJudgeService({ get: () => undefined } as never, cycle(1) as never, undefined, undefined, transport as never);
    const r = await svc.judge({}, opts);
    expect(r).toMatchObject({ ok: false, reason: 'judge_unavailable' });
    await new Promise((r2) => setTimeout(r2, 30));
    expect(transport.messages.create).not.toHaveBeenCalled();
  });

  it('a slow model → judge_unavailable at the timeout', async () => {
    const transport = { messages: { create: jest.fn(() => new Promise((r) => setTimeout(() => r(okReply), 1_000))) } };
    const svc = new SignalJudgeService({ get: () => undefined } as never, cycle(0) as never, undefined, undefined, transport as never);
    const r = await svc.judge({}, { ...opts, timeoutMs: 50, slotWaitMs: 50 });
    expect(r).toMatchObject({ ok: false, reason: 'judge_unavailable' });
  });

  it('an invalid reply → judge_invalid', async () => {
    const transport = { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: 'yes buy' }], stop_reason: 'end_turn' })) } };
    const svc = new SignalJudgeService({ get: () => undefined } as never, cycle(0) as never, undefined, undefined, transport as never);
    expect(await svc.judge({}, opts)).toMatchObject({ ok: false, reason: 'judge_invalid' });
  });
});
