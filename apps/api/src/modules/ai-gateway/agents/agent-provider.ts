import { APIConnectionError, APIConnectionTimeoutError, APIError } from '@anthropic-ai/sdk';
import type { ProviderAdapter, ProviderName, ProviderResult } from '../providers/provider.types';
import type { TransportRequest } from '../transport.types';
import { currentAgentCallBudget } from './agent-call-budget';
import { emitAgentEvent } from './agent-events';
import { AGENT_PROTOCOL, AgentBusyError, type AgentCallBody, type AgentCallReply } from './agent-protocol';
import { agentUrl, isTradingJob, loadAgentRegistry, type AgentGroup, type AgentProfile, type AgentRegistry } from './agent-registry';
import { isQuotaError, sharedGlobalLimiter, type GlobalLimiter } from './global-limiter';

/** How far inside the API's abort the agent's start deadline sits (at most 10 % of the remaining time). */
export const AGENT_DEADLINE_MARGIN_MS = 2_000;

/** How long an unreachable agent is skipped (calls go in-process) before it is tried again (§4.6). */
export const AGENT_DOWN_MS = 30_000;

/**
 * Share of a profile's `timeoutMs` a call may spend QUEUED (global limiter + agent semaphore) before it
 * must start; the rest is its run budget. A call that cannot start inside it is `AgentBusyError` — it is
 * never sent with a sliver of time left (which would start a Vertex call only to abort it).
 */
export const AGENT_QUEUE_SHARE = 0.25;

/** Trading jobs wait at most this long for a global-limiter slot: a stale packet is skipped, not judged. */
export const TRADING_LIMITER_WAIT_MS = 10_000;

/** A started call always keeps at least this much run time (or half its window, if that is smaller). */
export const AGENT_MIN_RUN_MS = 5_000;

/**
 * Which agent groups are marked down, until when. Process-wide by default: every caller builds its own
 * transport, and one caller finding the trading agent dead should spare the others the connect attempt.
 */
export class AgentLinkState {
  private readonly downUntil = new Map<AgentGroup, number>();
  private readonly deadListeners = new Map<AgentGroup, Set<() => void>>();

  isDown(group: AgentGroup, now: number): boolean {
    return (this.downUntil.get(group) ?? 0) > now;
  }

  /** Skip `group` (serve in-process) until `now + ms`; never shortens an existing mark. */
  markDown(group: AgentGroup, now: number, ms: number = AGENT_DOWN_MS): void {
    this.downUntil.set(group, Math.max(this.downUntil.get(group) ?? 0, now + ms));
  }

  /**
   * The health check found `group` not answering (dead, paused, or its event loop stalled): mark it down
   * AND cut off calls already in flight to it, which would otherwise wait their whole timeout on a socket
   * that accepted the connection but will never reply. Those calls are re-served in-process; a late
   * result from the agent is discarded on its side (client gone), so nothing is used twice.
   */
  markDead(group: AgentGroup, now: number, ms: number = AGENT_DOWN_MS): void {
    this.markDown(group, now, ms);
    for (const cb of [...(this.deadListeners.get(group) ?? [])]) {
      try {
        cb();
      } catch {
        /* one listener must not stop the others */
      }
    }
  }

  /** Called when `group` is marked dead; returns the unsubscribe function. */
  onDead(group: AgentGroup, cb: () => void): () => void {
    let set = this.deadListeners.get(group);
    if (!set) {
      set = new Set();
      this.deadListeners.set(group, set);
    }
    const listeners = set;
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  markUp(group: AgentGroup): void {
    this.downUntil.delete(group);
  }
}

const sharedLinks = new AgentLinkState();

/** The process-wide link state every `AgentProvider` uses by default (and the health service marks). */
export function sharedAgentLinks(): AgentLinkState {
  return sharedLinks;
}

export interface AgentProviderDeps {
  /** The job label for a request (the same `jobOf` the RecordedTransport records). */
  jobOf: (req: TransportRequest) => string;
  /** The in-process Vertex provider: jobs routed `in-process`, and the fallback when an agent is unreachable. */
  inProcess: ProviderAdapter;
  registry?: AgentRegistry;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  limiter?: GlobalLimiter;
  links?: AgentLinkState;
  now?: () => number;
}

/**
 * Error classes the AGENT itself answers with before any model call ran (agent-server.ts): the call is
 * safe to serve in-process, exactly like a refused connection. Model / SDK errors are NOT in here.
 */
export const AGENT_LINK_ERRORS: ReadonlySet<string> = new Set([
  'ProtocolMismatch',
  'WrongAgent',
  'AgentUnavailable',
  'BadRequest',
  'NotFound',
  'AgentInternalError',
]);

/** Thrown internally for "the agent could not be used" — never escapes `send`. */
class AgentUnreachable extends Error {}

/** Error classes rebuilt per name, so `err.constructor.name` equals the agent-reported class. */
const namedErrorClasses = new Map<string, new (message: string) => Error>();

function namedErrorClass(name: string): new (message: string) => Error {
  let C = namedErrorClasses.get(name);
  if (!C) {
    const holder = {
      [name]: class extends Error {
        constructor(message: string) {
          super(message);
          this.name = name;
        }
      },
    };
    C = holder[name];
    namedErrorClasses.set(name, C);
  }
  return C;
}

/**
 * The error an agent reported, rebuilt so callers classify it exactly as the in-process SDK error:
 * Anthropic SDK classes are rebuilt AS those classes (`instanceof RateLimitError` keeps working), and
 * anything else becomes an Error whose constructor name and `name` are the reported class, carrying
 * `status` when there was one.
 */
export function errorFromAgentReply(e: { class: string; message: string; status?: number }, job: string, waitedMs = 0): Error {
  const cls = typeof e.class === 'string' && /^[A-Za-z_$][\w$]*$/.test(e.class) ? e.class : 'Error';
  const message = typeof e.message === 'string' ? e.message : String(e.message);
  if (cls === 'AgentBusyError') return new AgentBusyError(job, waitedMs);
  if (cls === 'APIConnectionTimeoutError') return new APIConnectionTimeoutError({ message });
  if (cls === 'APIConnectionError') return new APIConnectionError({ message });
  if (typeof e.status === 'number') {
    const built = APIError.generate(e.status, undefined, message, new Headers());
    if (built.constructor.name === cls) return built;
  }
  const err = new (namedErrorClass(cls))(message);
  if (typeof e.status === 'number') (err as Error & { status?: number }).status = e.status;
  return err;
}

/** Note who served / how long it queued on an error too, for the ledger (non-enumerable, best effort). */
function tag(err: unknown, servedBy: AgentGroup | 'in-process', queuedMs: number): void {
  if (!err || typeof err !== 'object') return;
  try {
    Object.defineProperty(err, 'servedBy', { value: servedBy, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(err, 'queuedMs', { value: queuedMs, enumerable: false, configurable: true, writable: true });
  } catch {
    /* a frozen error just goes unrecorded */
  }
}

function isReply(v: unknown): v is AgentCallReply {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (typeof r.protocol !== 'number') return false;
  if (r.ok === true) return !!r.message && typeof r.message === 'object' && !!r.meta && typeof r.meta === 'object';
  if (r.ok === false) return !!r.error && typeof r.error === 'object' && typeof (r.error as { class?: unknown }).class === 'string';
  return false;
}

/**
 * Serves a request through the job's AI agent container (design §4.1), keeping the exact
 * `ProviderResult` / error contract of the in-process `AnthropicVertexProvider`.
 *
 * - Applies the job profile's non-null model / effort / max_tokens overrides (null = the caller's).
 * - Takes a slot of the API's global limiter (trading reserve, 429 back-off; §4.5a).
 * - `in-process` jobs, and groups marked down, go straight to the in-process provider.
 * - Otherwise POSTs `AgentCallBody` to `<agentUrl>/v1/messages`, aborting at the profile timeout.
 *   Unreachable (refused / reset / DNS / non-JSON / protocol mismatch) → mark down 30 s, `fallback`
 *   event, serve in-process (the crashed call never returned, so nothing is used twice).
 *   `AgentBusyError` → thrown, no fallback (that would double-spend and could double-act).
 *   Other agent errors → rebuilt with their class and status. Timeout → the SDK's timeout error.
 */
export class AgentProvider implements ProviderAdapter {
  readonly name: ProviderName = 'anthropic-vertex';
  private readonly registry: AgentRegistry;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn: typeof fetch;
  private readonly limiter: GlobalLimiter;
  private readonly links: AgentLinkState;
  private readonly now: () => number;

  constructor(private readonly deps: AgentProviderDeps) {
    this.env = deps.env ?? process.env;
    this.registry = deps.registry ?? loadAgentRegistry(this.env);
    this.fetchFn = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.limiter = deps.limiter ?? sharedGlobalLimiter(this.env);
    this.links = deps.links ?? sharedLinks;
    this.now = deps.now ?? Date.now;
  }

  modelFor(model: string): string {
    return this.deps.inProcess.modelFor?.(model) ?? model;
  }

  /** The request with the job profile's non-null overrides applied; the same object when none apply. */
  effectiveRequest(request: TransportRequest): TransportRequest {
    return applyProfile(request, this.registry.profile(this.deps.jobOf(request)));
  }

  async send(request: TransportRequest): Promise<ProviderResult> {
    const job = this.deps.jobOf(request);
    const profile = this.registry.profile(job);
    const sent = applyProfile(request, profile);
    const startedAt = this.now();
    const servedGroup: AgentGroup | 'in-process' = profile.agent;
    const trading = isTradingJob(job, profile);
    const { deadlineAt, startBy } = callWindow(startedAt, profile.timeoutMs, currentAgentCallBudget());

    // The limiter wait is the QUEUE budget, never the whole timeout; trading jobs wait only briefly.
    const limiterWait = Math.max(0, Math.min(startBy - startedAt, trading ? TRADING_LIMITER_WAIT_MS : Infinity));
    let release: () => void;
    try {
      release = await this.limiter.acquire(job, trading, limiterWait);
    } catch (err) {
      if (err instanceof AgentBusyError) emitAgentEvent('busy', { group: servedGroup, job });
      tag(err, servedGroup, Math.max(0, this.now() - startedAt));
      throw err;
    }
    const limiterWaitMs = Math.max(0, this.now() - startedAt);
    // Past its start-by (the caller already gave up, or too little run time is left): busy, never sent.
    if (this.now() > startBy) {
      release();
      const busy = new AgentBusyError(job, limiterWaitMs);
      emitAgentEvent('busy', { group: servedGroup, job });
      tag(busy, servedGroup, limiterWaitMs);
      throw busy;
    }
    try {
      if (profile.agent === 'in-process') return await this.inProcess(sent, limiterWaitMs);
      const group = profile.agent;
      if (this.links.isDown(group, this.now())) {
        emitAgentEvent('fallback', { group, job, reason: 'agent marked down' });
        return await this.inProcess(sent, limiterWaitMs);
      }
      try {
        return await this.remote(group, job, sent, deadlineAt, startBy, limiterWaitMs);
      } catch (err) {
        if (!(err instanceof AgentUnreachable)) throw err;
        this.links.markDown(group, this.now());
        emitAgentEvent('fallback', { group, job, reason: err.message });
        return await this.inProcess(sent, limiterWaitMs);
      }
    } catch (err) {
      if (isQuotaError(err)) this.limiter.noteQuota(job);
      throw err;
    } finally {
      release();
    }
  }

  private async inProcess(sent: TransportRequest, queuedMs: number): Promise<ProviderResult> {
    try {
      const r = await this.deps.inProcess.send(sent);
      return { message: r.message, meta: { ...r.meta, servedBy: 'in-process', queuedMs } };
    } catch (err) {
      tag(err, 'in-process', queuedMs);
      throw err;
    }
  }

  private async remote(
    group: AgentGroup,
    job: string,
    sent: TransportRequest,
    deadlineAt: number,
    startBy: number,
    limiterWaitMs: number,
  ): Promise<ProviderResult> {
    const now = this.now();
    const remainingMs = Math.max(1, deadlineAt - now);
    // The agent's START deadline is what is left of the queue budget (and always a little inside our
    // abort), so a call stuck in the agent's queue comes back as AgentBusyError — the caller's busy
    // path — instead of starting a Vertex call with seconds left to run.
    const insideAbort = remainingMs - Math.min(AGENT_DEADLINE_MARGIN_MS, Math.floor(remainingMs / 10));
    const startDeadlineMs = Math.max(0, Math.min(startBy - now, insideAbort));
    const body: AgentCallBody = { protocol: AGENT_PROTOCOL, job, request: sent, deadlineMs: startDeadlineMs };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    let cutOff = false;
    const offDead = this.links.onDead(group, () => {
      cutOff = true;
      controller.abort();
    });
    const timedOut = (): Error => {
      const e = new APIConnectionTimeoutError();
      tag(e, group, limiterWaitMs);
      return e;
    };
    let text: string;
    try {
      const res = await this.fetchFn(`${agentUrl(group, this.env)}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      if (cutOff) throw new AgentUnreachable('health check marked the agent down while the call was in flight');
      if (controller.signal.aborted) throw timedOut();
      throw new AgentUnreachable(`unreachable: ${describe(err)}`);
    } finally {
      clearTimeout(timer);
      offDead();
    }

    // Judged by the BODY, not the HTTP status: the agent answers calls it handled with 200, and its
    // own refusals (503 AgentUnavailable while shutting down, 400 BadRequest, 404, 500, and 200
    // ProtocolMismatch / WrongAgent) carry an AGENT_LINK_ERRORS class → served in-process below.
    // A body that is not an agent reply at all (proxy page, empty) → unreachable.
    let reply: unknown;
    try {
      reply = JSON.parse(text);
    } catch {
      throw new AgentUnreachable('reply is not JSON');
    }
    if (!isReply(reply)) throw new AgentUnreachable('reply is not an agent reply');
    if (reply.protocol !== AGENT_PROTOCOL) {
      throw new AgentUnreachable(`protocol mismatch (agent ${reply.protocol}, api ${AGENT_PROTOCOL})`);
    }
    if (!reply.ok && AGENT_LINK_ERRORS.has(reply.error.class)) {
      // The agent refused the call before running it (version / routing drift, shutting down, bad body).
      throw new AgentUnreachable(`agent refused: ${reply.error.class}`);
    }
    this.links.markUp(group);
    if (reply.ok) {
      const queuedMs = limiterWaitMs + (typeof reply.queuedMs === 'number' && reply.queuedMs > 0 ? reply.queuedMs : 0);
      return { message: reply.message, meta: { ...reply.meta, servedBy: group, queuedMs } };
    }
    const err = errorFromAgentReply(reply.error, job, limiterWaitMs);
    if (err instanceof AgentBusyError) emitAgentEvent('busy', { group, job });
    tag(err, group, limiterWaitMs);
    throw err;
  }
}

/**
 * When a call must start by, and when it is aborted: the profile's window tightened by the caller's
 * budget. The queue gets {@link AGENT_QUEUE_SHARE} of the timeout; a started call keeps at least
 * {@link AGENT_MIN_RUN_MS} (or half its window, if smaller) to run.
 */
export function callWindow(
  startedAt: number,
  timeoutMs: number,
  budget: { startBy?: number; abortAt?: number } = {},
): { deadlineAt: number; startBy: number } {
  let deadlineAt = startedAt + timeoutMs;
  if (typeof budget.abortAt === 'number' && Number.isFinite(budget.abortAt)) deadlineAt = Math.min(deadlineAt, budget.abortAt);
  let startBy = startedAt + Math.floor(timeoutMs * AGENT_QUEUE_SHARE);
  if (typeof budget.startBy === 'number' && Number.isFinite(budget.startBy)) startBy = Math.min(startBy, budget.startBy);
  const minRun = Math.min(AGENT_MIN_RUN_MS, Math.floor(Math.max(0, deadlineAt - startedAt) / 2));
  startBy = Math.min(startBy, deadlineAt - minRun);
  return { deadlineAt, startBy };
}

/** The request with a profile's non-null model / effort / maxTokens applied; the SAME object when none apply. */
export function applyProfile(request: TransportRequest, profile: AgentProfile): TransportRequest {
  const model = profile.model !== null && profile.model !== request.model ? profile.model : null;
  const effort = profile.effort !== null && profile.effort !== request.output_config?.effort ? profile.effort : null;
  const maxTokens = profile.maxTokens !== null && profile.maxTokens !== request.max_tokens ? profile.maxTokens : null;
  if (model === null && effort === null && maxTokens === null) return request;
  return {
    ...request,
    ...(model !== null ? { model } : {}),
    ...(maxTokens !== null ? { max_tokens: maxTokens } : {}),
    ...(effort !== null ? { output_config: { ...request.output_config, effort } } : {}),
  };
}

function describe(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  const cause = e?.cause?.code ?? e?.cause?.message;
  return `${e?.message ?? String(err)}${cause ? ` (${cause})` : ''}`;
}
