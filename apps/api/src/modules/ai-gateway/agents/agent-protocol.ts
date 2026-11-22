import type { ProviderResult } from '../providers/provider.types';
import type { TransportMessage, TransportRequest } from '../transport.types';
import type { AgentGroup } from './agent-registry';

/**
 * The API ↔ agent wire protocol (design §4.3 / §4.7a). Both sides send `protocol`; a reply with a
 * different version is treated by the API as an unreachable agent (in-process fallback + alert), so
 * a half-finished deploy degrades instead of misbehaving.
 */
export const AGENT_PROTOCOL = 1;

/**
 * `POST /v1/messages` body.
 *
 * `request` is the already-built request with the job profile's overrides applied (the agent sends it
 * to Vertex as-is; the Vertex provider maps the model id). `deadlineMs` is a DURATION in milliseconds,
 * measured from when the agent receives the body: the latest the call may START. The API sends a value
 * a little inside its own abort (AGENT_DEADLINE_MARGIN_MS), so a request that cannot start within it is
 * answered `AgentBusyError` before the API gives up; a result after the API disconnected is discarded.
 */
export interface AgentCallBody {
  protocol: number;
  job: string;
  request: TransportRequest;
  deadlineMs: number;
}

/**
 * `POST /v1/messages` reply. `error.class` is the ORIGINAL error's constructor name (e.g.
 * `RateLimitError`, `APIConnectionTimeoutError`, `AgentBusyError`) and `status` its HTTP status when it
 * had one, so the API can rebuild an error that callers classify exactly as before.
 */
export type AgentCallReply =
  | {
      protocol: number;
      ok: true;
      message: TransportMessage;
      meta: ProviderResult['meta'];
      queuedMs: number;
      agent: AgentGroup;
    }
  | { protocol: number; ok: false; error: { class: string; message: string; status?: number } };

/**
 * The agent (or the API's global limiter) could not START the call before its deadline. Never retried
 * in-process — that would double-spend and could double-act (design §4.6).
 */
export class AgentBusyError extends Error {
  readonly job: string;
  readonly waitedMs: number;

  constructor(job: string, waitedMs: number) {
    super(`AI agent busy: job "${job}" could not start within its deadline (waited ${Math.round(waitedMs)} ms)`);
    this.name = 'AgentBusyError';
    this.job = job;
    this.waitedMs = waitedMs;
    Object.setPrototypeOf(this, AgentBusyError.prototype);
  }
}

/** `GET /health` reply. */
export interface AgentHealth {
  group: AgentGroup;
  protocol: number;
  rssMb: number;
  agents: Record<string, { inFlight: number; limit: number; queued: number; okLast5m: number; errLast5m: number }>;
}
