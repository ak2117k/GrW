import type { TransportMessage, TransportRequest } from '../transport.types';
import type { AgentGroup } from '../agents/agent-registry';

/** The providers the gateway can route a call to. */
export type ProviderName = 'anthropic-api' | 'claude-cli' | 'anthropic-vertex';

/**
 * What one call cost, as the provider reported it.
 *
 * Tokens are `null` when the provider did not report them — never estimated or
 * defaulted to 0. A fabricated count would be indistinguishable from a real one
 * in the ledger and would quietly corrupt every cost figure derived from it.
 * `billed` is true only for calls that spend metered API credit.
 *
 * PROMPT CACHING. The API reports cache traffic SEPARATELY from
 * `input_tokens` (which counts only the uncached remainder):
 * `cache_creation_input_tokens` (written to the cache, billed above the input
 * rate) and `cache_read_input_tokens` (served from it, billed far below). The
 * sentinel marks its system prompt `cache_control: ephemeral`, so on a billed
 * call most of the prompt shows up here, not in `inputTokens` — reading only
 * `input_tokens` would undercount spend. Same rule: `null` when not reported.
 */
export interface CallMeta {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  billed: boolean;
  /**
   * AI agents (2026-11-22): which agent container served the call, or `in-process` when the API
   * called Vertex itself (job routed in-process, or agent unreachable → fallback). Absent on every
   * non-agent path. Recorded in `ai_calls.agent`.
   */
  servedBy?: AgentGroup | 'in-process';
  /** AI agents: ms the call waited for a slot (API global limiter + the agent's semaphore). Absent = 0. */
  queuedMs?: number;
}

/** The reply exactly as callers saw it before the gateway, plus its metadata. */
export interface ProviderResult {
  message: TransportMessage;
  meta: CallMeta;
}

/** Per-call options a provider may honour. */
export interface SendOptions {
  /** Aborting it cancels the model call (the AI agent passes its client-gone signal, so an abandoned call frees its slot). */
  signal?: AbortSignal;
}

/** One way of serving a Messages-style request. */
export interface ProviderAdapter {
  readonly name: ProviderName;
  send(request: TransportRequest, opts?: SendOptions): Promise<ProviderResult>;
  /** The model id this provider actually serves for a requested id (Vertex maps ids); absent = unchanged. */
  modelFor?(model: string): string;
  /**
   * The request as this provider will actually send it (before model-id mapping), when it changes
   * fields itself — the AI agent profile's model / effort / max_tokens overrides. The ledger records
   * model, effort and max_tokens from it. Absent = the request is sent as given.
   */
  effectiveRequest?(request: TransportRequest): TransportRequest;
}

/**
 * The WHOLE prompt the call consumed: uncached input + cache writes + cache reads.
 *
 * This is what the `ai_calls.inputTokens` column records. `inputTokens` alone is
 * only the uncached remainder — with the sentinel's cached system prompt it is a
 * handful of tokens (the CLI reported ~2 per call on a ~10 k-char packet), which
 * made the ledger read as if no prompt had been sent at all. The three parts stay
 * separately in `response.usage`; cost is still priced per part (`costInr`).
 *
 * `null` only when the provider reported NONE of the three — never invented.
 */
export function totalInputTokens(meta: CallMeta): number | null {
  const parts = [meta.inputTokens, meta.cacheCreationInputTokens, meta.cacheReadInputTokens];
  if (parts.every((p) => p === null || p === undefined)) return null;
  return parts.reduce<number>((sum, p) => sum + (p ?? 0), 0);
}
