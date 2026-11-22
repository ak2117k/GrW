/**
 * USER-FACING CLAUDE CALLS SHARE ONLY THE SENTINEL'S NON-RESERVED CAPACITY.
 *
 * The trade sentinel runs at most `JUDGE_CONCURRENCY` (2) model calls at once
 * and keeps `LIVE_RESERVED_SLOTS` (1) of them for live exit judgements. Its
 * `runShared` is the door overnight reviews already use: it waits until a slot
 * is free WITHOUT touching the reserved one, then registers the job in the same
 * in-flight map the live tick counts. A News or Advisor request goes through
 * that same door, so:
 *
 *   - it only ever starts when no other model call is in flight (2 - 1 = 1
 *     shared slot), so the live reserved slot is always free for an exit;
 *   - while it runs, the live tick sees it as one in-flight judgement — exactly
 *     like an overnight review — and still has its reserved slot;
 *   - it waits at most `maxWaitMs` for that slot, then fails with
 *     {@link AssistBusyError} ("busy, try again") and is guaranteed never to
 *     start later: `runShared` re-checks `expired` on every wake.
 *
 * Once started, the call is bounded by the CLI transport's own 180 s timeout.
 *
 * AI AGENTS (design 2026-11-22-ai-agents-design.md §4.5). With `AI_AGENTS=on` AND
 * `SENTINEL_JUDGE=vertex`, a job that is not one of the sentinel's own
 * ({@link SENTINEL_GATED_JOBS}) and is routed to an agent container skips this
 * door — and the signal lane — and calls straight through: its agent's per-job
 * semaphore (with a hard deadline) is its gate. The agent's `AgentBusyError` is
 * mapped to {@link AssistBusyError}, so every caller's "busy" path is unchanged.
 * A job the registry routes `in-process` (rollout steps 4–5) keeps this door.
 * With agents off, or on `cli`, nothing here changes.
 */
import { withAgentCallBudget } from '../ai-gateway/agents/agent-call-budget';
import { AgentBusyError } from '../ai-gateway/agents/agent-protocol';
import { agentsOn, loadAgentRegistry, SENTINEL_GATED_JOBS, type AgentRegistry } from '../ai-gateway/agents/agent-registry';

/** The slice of `SentinelCycleService` this needs (kept narrow for tests). */
export interface SharedSlotRunner {
  runShared<T>(
    trackerId: string,
    work: () => Promise<T>,
    opts?: { expired?: () => boolean; reserveLive?: () => boolean; lane?: 'signals' },
  ): Promise<T>;
}

export const ASSIST_BUSY_MESSAGE =
  'Claude is busy with live trade decisions right now — please try again in a minute.';

/** No shared slot freed up within the wait budget. Never started; safe to retry. */
export class AssistBusyError extends Error {
  constructor(waitedMs: number) {
    super(`${ASSIST_BUSY_MESSAGE} (no free model slot within ${Math.round(waitedMs / 1000)} s)`);
    this.name = 'AssistBusyError';
  }
}

let seq = 0;

/** The registry, re-read only when the env that shapes it changes (tests flip env between cases). */
let registryCache: { key: string; registry: AgentRegistry } | null = null;

function registryKey(env: NodeJS.ProcessEnv): string {
  const parts = [`dir=${env.AI_CONFIG_DIR ?? ''}`];
  for (const k of Object.keys(env).sort()) if (k.startsWith('AGENT_')) parts.push(`${k}=${env[k]}`);
  return parts.join('\n');
}

function registryFor(env: NodeJS.ProcessEnv): AgentRegistry {
  const key = registryKey(env);
  if (registryCache?.key !== key) registryCache = { key, registry: loadAgentRegistry(env) };
  return registryCache.registry;
}

/**
 * True when `job` skips the shared slot / signal lane because an AI agent gates it (design §4.5):
 * agents on, not a sentinel job, and not routed `in-process`. A registry that cannot be read keeps the
 * door (today's behaviour). No `job` with agents on = an unregistered caller = background agent = skip.
 */
export function agentGatesJob(job: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!agentsOn(env)) return false;
  if (job === undefined) return true;
  if (SENTINEL_GATED_JOBS.includes(job)) return false;
  try {
    return registryFor(env).profile(job).agent !== 'in-process';
  } catch {
    return false;
  }
}

function isAgentBusy(err: unknown): err is Error & { waitedMs?: number } {
  return err instanceof AgentBusyError || (err instanceof Error && err.name === 'AgentBusyError');
}

/**
 * Straight through to the agent; its "busy" becomes the advisor's {@link AssistBusyError}.
 *
 * The caller's budgets travel with the call ({@link withAgentCallBudget}): the call must START within
 * `maxWaitMs` (as the shared slot guaranteed — never started after the caller gave up), and with a
 * `timeoutMs` it is aborted then, so the agent cancels the Vertex call and frees its slot.
 */
async function viaAgent<T>(work: () => Promise<T>, maxWaitMs: number, timeoutMs?: number): Promise<T> {
  const now = Date.now();
  const budget = {
    startBy: now + Math.max(0, maxWaitMs),
    ...(typeof timeoutMs === 'number' && timeoutMs > 0 ? { abortAt: now + timeoutMs } : {}),
  };
  try {
    return await withAgentCallBudget(budget, work);
  } catch (err) {
    if (isAgentBusy(err)) {
      const waited = typeof err.waitedMs === 'number' && err.waitedMs > 0 ? err.waitedMs : maxWaitMs;
      throw new AssistBusyError(waited);
    }
    throw err;
  }
}

export function runInSharedSlot<T>(
  runner: SharedSlotRunner,
  work: () => Promise<T>,
  opts: {
    maxWaitMs: number;
    lane?: 'signals';
    job?: string;
    /** The caller's own overall timeout. Agent path: the call is aborted (and cancelled on Vertex) then. */
    timeoutMs?: number;
  },
): Promise<T> {
  if (agentGatesJob(opts.job)) return viaAgent(work, opts.maxWaitMs, opts.timeoutMs);
  let timedOut = false;
  let started = false;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (started) return;
      timedOut = true;
      reject(new AssistBusyError(opts.maxWaitMs));
    }, opts.maxWaitMs);
    // A unique id per call: the one-in-flight-per-position rule must not merge
    // two unrelated user questions, and it never collides with a tracker id.
    const id = `assist:${Date.now().toString(36)}:${(seq++).toString(36)}`;
    runner
      .runShared(
        id,
        () => {
          // Runs synchronously right after runShared took the slot, so the
          // timer cannot fire between "slot taken" and "started".
          started = true;
          clearTimeout(timer);
          return work();
        },
        // No `reserveLive` override: the default always keeps the live slot.
        { expired: () => timedOut, ...(opts.lane ? { lane: opts.lane } : {}) },
      )
      .then(resolve, (err) => {
        clearTimeout(timer);
        // After a timeout the caller already has its AssistBusyError; the
        // queued job's own rejection (SharedJobExpired on its next wake) is noise.
        if (timedOut) return;
        reject(err);
      });
  });
}
