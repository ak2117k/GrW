/**
 * The agent container's HTTP server (design §4.3).
 *
 * A PLAIN node:http server — no NestJS, no Prisma, no broker code — so one container idles well
 * under 100 MB RSS. It serves exactly one agent group (`trading` | `reading` | `background`):
 *
 *   POST /v1/messages  body {@link AgentCallBody} → reply {@link AgentCallReply} (always HTTP 200
 *                      when the agent answered, ok:true or ok:false; 400 malformed body; 503 while
 *                      shutting down — the API treats non-200 / no reply as unreachable).
 *   GET  /health       {@link AgentHealth}
 *
 * Each job runs under its own {@link JobSemaphore} (limit = registry concurrency, queue = 2 × limit).
 * A call that cannot START within `deadlineMs` (a duration from receipt) answers `AgentBusyError`.
 * Provider errors pass through with their constructor name and HTTP status so the API can rebuild an
 * error its callers classify exactly as today. A result that arrives after the client disconnected
 * is discarded and counted (`lateDiscarded`).
 *
 * Logs one line per call to stdout (group, job, ms, queued, ok/err class). Request bodies — prompts,
 * images — are NEVER logged.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AGENT_PROTOCOL, AgentBusyError, type AgentCallBody, type AgentCallReply, type AgentHealth } from '../modules/ai-gateway/agents/agent-protocol';
import type { AgentGroup, AgentRegistry } from '../modules/ai-gateway/agents/agent-registry';
import type { ProviderAdapter } from '../modules/ai-gateway/providers/provider.types';
import { JobSemaphore, SemaphoreRejected } from './job-semaphore';

/** Bodies carry images (~1 MB base64 each); anything far beyond is a bug, not a request. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
const WINDOW_MS = 5 * 60_000;

export interface AgentServerOptions {
  group: AgentGroup;
  registry: AgentRegistry;
  /** The Vertex provider in production; a fake in tests. */
  provider: Pick<ProviderAdapter, 'send'>;
  log?: (line: string) => void;
  now?: () => number;
}

interface JobStats {
  sem: JobSemaphore;
  ok: number[];
  err: number[];
}

export class AgentServer {
  readonly server: http.Server;
  private readonly jobs = new Map<string, JobStats>();
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private closing = false;
  private active = 0;
  private idleWaiters: Array<() => void> = [];
  /** Results that came back after the API had disconnected — computed, paid for, thrown away. */
  lateDiscarded = 0;

  constructor(private readonly opts: AgentServerOptions) {
    this.log = opts.log ?? ((line) => process.stdout.write(line + '\n'));
    this.now = opts.now ?? Date.now;
    this.server = http.createServer((req, res) => {
      this.route(req, res).catch((err) => {
        this.log(`[agent ${opts.group}] internal error: ${errText(err)}`);
        if (!res.headersSent) sendJson(res, 500, { protocol: AGENT_PROTOCOL, ok: false, error: { class: 'AgentInternalError', message: 'internal error' } });
      });
    });
    // Long model calls: never let Node's default request timeout cut a call short; the API owns the deadline.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 60_000;
    this.server.keepAliveTimeout = 65_000;
  }

  listen(port: number, host?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve((this.server.address() as AddressInfo).port);
      });
    });
  }

  /** Stop accepting, let in-flight calls finish (up to `graceMs`), then close. Resolves true if drained. */
  async stop(graceMs = 10_000): Promise<boolean> {
    this.closing = true;
    const closed = new Promise<void>((r) => this.server.close(() => r()));
    this.server.closeIdleConnections?.();
    const drained = await Promise.race([
      this.active === 0 ? Promise.resolve(true) : new Promise<boolean>((r) => this.idleWaiters.push(() => r(true))),
      new Promise<boolean>((r) => setTimeout(() => r(false), graceMs).unref()),
    ]);
    this.server.closeAllConnections?.();
    await closed;
    return drained;
  }

  health(): AgentHealth & { lateDiscarded: number } {
    const agents: AgentHealth['agents'] = {};
    // Registry entries as written (a `backtest.*` entry is one shared semaphore) plus jobs served so far.
    const names = new Set(this.opts.registry.jobsOf(this.opts.group));
    for (const j of this.jobs.keys()) names.add(j);
    const cutoff = this.now() - WINDOW_MS;
    for (const job of [...names].sort()) {
      const s = this.stats(job);
      prune(s.ok, cutoff);
      prune(s.err, cutoff);
      agents[job] = { inFlight: s.sem.inFlight, limit: s.sem.limit, queued: s.sem.queued, okLast5m: s.ok.length, errLast5m: s.err.length };
    }
    return {
      group: this.opts.group,
      protocol: AGENT_PROTOCOL,
      rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      agents,
      lateDiscarded: this.lateDiscarded,
    };
  }

  private stats(job: string): JobStats {
    let s = this.jobs.get(job);
    if (!s) {
      const limit = this.opts.registry.profile(job).concurrency;
      s = { sem: new JobSemaphore(limit), ok: [], err: [] };
      this.jobs.set(job, s);
    }
    return s;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && url === '/health') {
      sendJson(res, 200, this.health());
      return;
    }
    if (req.method === 'POST' && url === '/v1/messages') {
      if (this.closing) {
        res.setHeader('Connection', 'close');
        sendJson(res, 503, errorReply('AgentUnavailable', 'agent is shutting down'));
        req.resume();
        return;
      }
      this.active++;
      try {
        await this.handleCall(req, res);
      } finally {
        this.active--;
        if (this.active === 0) {
          const w = this.idleWaiters;
          this.idleWaiters = [];
          w.forEach((f) => f());
        }
      }
      return;
    }
    sendJson(res, 404, errorReply('NotFound', `no route ${req.method} ${url}`));
  }

  private async handleCall(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const receivedAt = this.now();
    const group = this.opts.group;

    let raw: string;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, 400, errorReply('BadRequest', errText(err)));
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      sendJson(res, 400, errorReply('BadRequest', 'body is not JSON'));
      return;
    }
    const b = body as Partial<AgentCallBody> | null;
    if (!b || typeof b !== 'object') {
      sendJson(res, 400, errorReply('BadRequest', 'body must be an object'));
      return;
    }
    if (b.protocol !== AGENT_PROTOCOL) {
      this.log(`[agent ${group}] job=${safeJob(b.job)} ms=0 err=ProtocolMismatch got=${String(b.protocol)}`);
      sendJson(res, 200, errorReply('ProtocolMismatch', `agent speaks protocol ${AGENT_PROTOCOL}, got ${String(b.protocol)}`));
      return;
    }
    const invalid = validate(b);
    if (invalid) {
      sendJson(res, 400, errorReply('BadRequest', invalid));
      return;
    }
    const call = b as AgentCallBody;
    const job = call.job;

    const profile = this.opts.registry.profile(job);
    if (profile.agent !== group) {
      this.log(`[agent ${group}] job=${job} ms=0 err=WrongAgent routed=${profile.agent}`);
      sendJson(res, 200, errorReply('WrongAgent', `job "${job}" belongs to "${profile.agent}", this is "${group}"`));
      return;
    }

    // The client can go away at any point (API timeout, API restart). Track it.
    const gone = new AbortController();
    const onClose = (): void => {
      if (!res.writableEnded) gone.abort();
    };
    res.on('close', onClose);

    const stats = this.stats(this.opts.registry.keyOf(job));
    let release: (() => void) | null = null;
    try {
      release = await stats.sem.acquire({ deadlineAt: receivedAt + call.deadlineMs, signal: gone.signal });
    } catch (err) {
      const waited = this.now() - receivedAt;
      if (err instanceof SemaphoreRejected && err.reason === 'cancelled') {
        this.log(`[agent ${group}] job=${job} ms=${waited} err=ClientGone (while queued)`);
        return;
      }
      stats.err.push(this.now());
      const busy = new AgentBusyError(job, waited);
      this.log(`[agent ${group}] job=${job} ms=${waited} err=AgentBusyError reason=${err instanceof SemaphoreRejected ? err.reason : 'unknown'}`);
      if (!gone.signal.aborted) sendJson(res, 200, errorReply(busy.name, busy.message));
      return;
    }

    const startedAt = this.now();
    const queuedMs = startedAt - receivedAt;
    let reply: AgentCallReply;
    let outcome: string;
    try {
      // The client-gone signal cancels the Vertex call: an abandoned call (API timeout, caller gave up)
      // stops spending and frees this job's slot instead of running on for minutes.
      const result = await this.opts.provider.send(call.request, { signal: gone.signal });
      reply = { protocol: AGENT_PROTOCOL, ok: true, message: result.message, meta: result.meta, queuedMs, agent: group };
      stats.ok.push(this.now());
      outcome = 'ok';
    } catch (err) {
      const e = err as { name?: unknown; message?: unknown; status?: unknown; constructor?: { name?: unknown } } | null;
      const cls = errorClass(e);
      const status = typeof e?.status === 'number' ? e.status : undefined;
      reply = {
        protocol: AGENT_PROTOCOL,
        ok: false,
        error: { class: cls, message: typeof e?.message === 'string' ? e.message : String(err), ...(status !== undefined ? { status } : {}) },
      };
      stats.err.push(this.now());
      outcome = `err=${cls}${status !== undefined ? ` status=${status}` : ''}`;
    } finally {
      release();
    }
    const ms = this.now() - receivedAt;
    if (gone.signal.aborted || res.destroyed) {
      this.lateDiscarded++;
      this.log(`[agent ${group}] job=${job} ms=${ms} queued=${queuedMs} ${outcome} DISCARDED (client gone, late=${this.lateDiscarded})`);
      return;
    }
    res.off('close', onClose);
    this.log(`[agent ${group}] job=${job} ms=${ms} queued=${queuedMs} ${outcome}`);
    sendJson(res, 200, reply);
  }
}

function errorReply(cls: string, message: string, status?: number): AgentCallReply {
  return { protocol: AGENT_PROTOCOL, ok: false, error: { class: cls, message, ...(status !== undefined ? { status } : {}) } };
}

/** The original error's class: constructor name (SDK errors set it), else `name`, else 'Error'. */
function errorClass(e: { name?: unknown; constructor?: { name?: unknown } } | null): string {
  const ctor = e?.constructor?.name;
  if (typeof ctor === 'string' && ctor && ctor !== 'Object' && ctor !== 'Error') return ctor;
  if (typeof e?.name === 'string' && e.name) return e.name;
  return typeof ctor === 'string' && ctor ? ctor : 'Error';
}

function validate(b: Partial<AgentCallBody>): string | null {
  if (typeof b.job !== 'string' || !b.job.trim() || b.job.length > 200) return 'job must be a non-empty string';
  if (typeof b.deadlineMs !== 'number' || !Number.isFinite(b.deadlineMs) || b.deadlineMs < 0) return 'deadlineMs must be a non-negative number';
  const r = b.request as unknown as Record<string, unknown> | undefined;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'request must be an object';
  if (typeof r.model !== 'string' || !r.model) return 'request.model must be a string';
  if (typeof r.max_tokens !== 'number') return 'request.max_tokens must be a number';
  if (!Array.isArray(r.messages)) return 'request.messages must be an array';
  return null;
}

function safeJob(job: unknown): string {
  return typeof job === 'string' ? job.slice(0, 80).replace(/\s/g, '_') : '?';
}

function prune(times: number[], cutoff: number): void {
  let i = 0;
  while (i < times.length && times[i] < cutoff) i++;
  if (i > 0) times.splice(0, i);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        reject(new Error(`body over ${limit} bytes`));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}
