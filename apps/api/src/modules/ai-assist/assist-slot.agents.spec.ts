import { currentAgentCallBudget } from '../ai-gateway/agents/agent-call-budget';
import { AgentBusyError } from '../ai-gateway/agents/agent-protocol';
import { agentGatesJob, AssistBusyError, runInSharedSlot, type SharedSlotRunner } from './assist-slot';

/**
 * Design 2026-11-22-ai-agents-design.md §4.5: with AI agents on (AI_AGENTS=on + SENTINEL_JUDGE=vertex),
 * every job that is not the sentinel's own skips the shared slot and the signal lane — its agent's
 * semaphore is its gate — and the agent's AgentBusyError surfaces as the existing AssistBusyError.
 * With agents off, or on cli, the door is exactly today's.
 */

const ENV_KEYS = ['AI_AGENTS', 'SENTINEL_JUDGE', 'AI_CONFIG_DIR', 'AGENT_SIGNAL_JUDGE_AGENT', 'AGENT_NEWS_IMPACT_AGENT'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const agentsOnEnv = () => {
  process.env.AI_AGENTS = 'on';
  process.env.SENTINEL_JUDGE = 'vertex';
};

/** A runner whose every slot is taken: anything that goes through it waits forever. */
function fullRunner() {
  const runShared = jest.fn(() => new Promise<never>(() => undefined));
  return { runner: { runShared } as unknown as SharedSlotRunner, runShared };
}

/** A runner with a free slot that records the options it was given. */
function freeRunner() {
  const runShared = jest.fn((_id: string, work: () => Promise<unknown>, _opts?: unknown) => work());
  return { runner: { runShared } as unknown as SharedSlotRunner, runShared };
}

describe('runInSharedSlot with AI agents', () => {
  it('agents OFF (AI_AGENTS unset): the job still goes through runShared, with today\'s options (no job forwarded)', async () => {
    process.env.SENTINEL_JUDGE = 'vertex';
    const { runner, runShared } = freeRunner();
    await expect(runInSharedSlot(runner, async () => 'ok', { maxWaitMs: 1000, lane: 'signals', job: 'signal.judge' })).resolves.toBe('ok');
    expect(runShared).toHaveBeenCalledTimes(1);
    expect(runShared.mock.calls[0][2]).toEqual({ expired: expect.any(Function), lane: 'signals' });
  });

  it('AI_AGENTS=on but SENTINEL_JUDGE=cli: the gate is kept (one local process)', async () => {
    process.env.AI_AGENTS = 'on';
    process.env.SENTINEL_JUDGE = 'cli';
    const { runner, runShared } = freeRunner();
    await runInSharedSlot(runner, async () => 'ok', { maxWaitMs: 1000, job: 'news.impact' });
    expect(runShared).toHaveBeenCalledTimes(1);
  });

  it('agents ON: a non-sentinel job calls straight through even when every shared slot is taken', async () => {
    agentsOnEnv();
    const { runner, runShared } = fullRunner();
    const work = jest.fn().mockResolvedValue('answered');
    await expect(runInSharedSlot(runner, work, { maxWaitMs: 1000, job: 'news.impact' })).resolves.toBe('answered');
    expect(work).toHaveBeenCalledTimes(1);
    expect(runShared).not.toHaveBeenCalled();
  });

  it('agents ON: the signal lane is bypassed too (signal.judge, signal.parse, signal.vision, signal.image-setup, signal.info)', async () => {
    agentsOnEnv();
    const { runner, runShared } = fullRunner();
    for (const job of ['signal.judge', 'signal.parse', 'signal.vision', 'signal.image-setup', 'signal.info']) {
      await expect(runInSharedSlot(runner, async () => job, { maxWaitMs: 1000, lane: 'signals', job })).resolves.toBe(job);
    }
    expect(runShared).not.toHaveBeenCalled();
  });

  it('agents ON: an AgentBusyError from the transport becomes AssistBusyError (the advisor busy path)', async () => {
    agentsOnEnv();
    const { runner } = fullRunner();
    const err = await runInSharedSlot(runner, () => Promise.reject(new AgentBusyError('news.impact', 4200)), {
      maxWaitMs: 1000,
      job: 'news.impact',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AssistBusyError);
    expect((err as Error).message).toMatch(/within 4 s/);
  });

  it('agents ON: a rebuilt error named AgentBusyError (not the class) is mapped too', async () => {
    agentsOnEnv();
    const { runner } = fullRunner();
    const e = new Error('busy');
    e.name = 'AgentBusyError';
    await expect(runInSharedSlot(runner, () => Promise.reject(e), { maxWaitMs: 3000, job: 'entry.judge' })).rejects.toBeInstanceOf(AssistBusyError);
  });

  it('agents ON: any other error passes through unchanged', async () => {
    agentsOnEnv();
    const { runner } = fullRunner();
    const boom = new Error('vertex 500');
    await expect(runInSharedSlot(runner, () => Promise.reject(boom), { maxWaitMs: 1000, job: 'backtest.summary' })).rejects.toBe(boom);
  });

  it('agents ON: the sentinel\'s own jobs keep the gate', async () => {
    agentsOnEnv();
    const { runner, runShared } = freeRunner();
    for (const job of ['sentinel.judge', 'sentinel.thesis', 'sentinel.overnight']) {
      await runInSharedSlot(runner, async () => 'ok', { maxWaitMs: 1000, job });
    }
    expect(runShared).toHaveBeenCalledTimes(3);
  });

  it('agents ON: a job the registry routes in-process (rollout steps 4-5) keeps the gate', async () => {
    agentsOnEnv();
    process.env.AGENT_SIGNAL_JUDGE_AGENT = 'in-process';
    const { runner, runShared } = freeRunner();
    await runInSharedSlot(runner, async () => 'ok', { maxWaitMs: 1000, lane: 'signals', job: 'signal.judge' });
    expect(runShared).toHaveBeenCalledTimes(1);
    expect(runShared.mock.calls[0][2]).toEqual({ expired: expect.any(Function), lane: 'signals' });
  });
});

describe('agentGatesJob', () => {
  it('false whenever agents are off', () => {
    expect(agentGatesJob('news.impact')).toBe(false);
    process.env.AI_AGENTS = 'on';
    expect(agentGatesJob('news.impact')).toBe(false); // SENTINEL_JUDGE unset = api
    process.env.SENTINEL_JUDGE = 'cli';
    expect(agentGatesJob('news.impact')).toBe(false);
  });

  it('agents on: true for agent-routed jobs (and unregistered / unlabelled callers), false for sentinel jobs', () => {
    agentsOnEnv();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(agentGatesJob('news.impact')).toBe(true);
    expect(agentGatesJob('assist.advisor')).toBe(true);
    expect(agentGatesJob('some.new-job')).toBe(true); // unregistered -> background (logged once by the registry)
    warn.mockRestore();
    expect(agentGatesJob(undefined)).toBe(true);
    expect(agentGatesJob('sentinel.judge')).toBe(false);
    expect(agentGatesJob('sentinel.overnight')).toBe(false);
  });

  it('agents on: env routing a job in-process flips it back to the gate; the registry is re-read on env change', () => {
    agentsOnEnv();
    expect(agentGatesJob('news.impact')).toBe(true);
    process.env.AGENT_NEWS_IMPACT_AGENT = 'in-process';
    expect(agentGatesJob('news.impact')).toBe(false);
    delete process.env.AGENT_NEWS_IMPACT_AGENT;
    expect(agentGatesJob('news.impact')).toBe(true);
  });

  it('agents on: an unreadable registry keeps the gate (today\'s behaviour)', () => {
    agentsOnEnv();
    process.env.AI_CONFIG_DIR = '/definitely/not/a/dir';
    expect(agentGatesJob('news.impact')).toBe(false);
  });
});

describe('runInSharedSlot with AI agents: the caller budget travels with the call (review fix)', () => {
  it("agent path: the work runs under startBy = now + maxWaitMs and abortAt = now + timeoutMs", async () => {
    agentsOnEnv();
    const { runner } = fullRunner();
    const t0 = Date.now();
    let seen: { startBy?: number; abortAt?: number } = {};
    await runInSharedSlot(
      runner,
      async () => {
        seen = currentAgentCallBudget();
        return 'ok';
      },
      { maxWaitMs: 45_000, lane: 'signals', job: 'signal.judge', timeoutMs: 120_000 },
    );
    expect(seen.startBy).toBeGreaterThanOrEqual(t0 + 45_000);
    expect(seen.startBy).toBeLessThan(t0 + 46_000);
    expect(seen.abortAt).toBeGreaterThanOrEqual(t0 + 120_000);
    expect(seen.abortAt).toBeLessThan(t0 + 121_000);
  });

  it('agent path without a timeoutMs: only the start-by is set', async () => {
    agentsOnEnv();
    const { runner } = fullRunner();
    let seen: { startBy?: number; abortAt?: number } = {};
    await runInSharedSlot(runner, async () => void (seen = currentAgentCallBudget()), { maxWaitMs: 45_000, job: 'news.impact' });
    expect(typeof seen.startBy).toBe('number');
    expect(seen.abortAt).toBeUndefined();
  });
});
