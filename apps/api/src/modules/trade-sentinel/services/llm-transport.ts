/**
 * The NARROW slice of the Anthropic client that this module actually uses.
 *
 * WHY AN INTERFACE RATHER THAN `Anthropic`. The sentinel can be served two ways:
 * the Anthropic API (billed per token, schema-enforced, typed errors) or a local
 * `claude -p` subprocess running on the operator's own Claude subscription. Both
 * produce a JSON verdict from a system prompt plus one user turn, which is all
 * `SentinelAgentService` and `ThesisService` ever ask for — so the seam is drawn
 * exactly there and nothing downstream of it changes.
 *
 * `Anthropic` satisfies this structurally, so the API path is the same object it
 * always was, injected under the same token.
 *
 * THIS INTERFACE IS DELIBERATELY NOT WIDER. Every field the two callers read
 * appears below and nothing else does. A transport that cannot honestly produce
 * one of these fields must fail loudly rather than default it — a fabricated
 * `stop_reason` would turn a truncated reply into a parse error, and Task 13's
 * replay reads "could not parse" as a prompt regression.
 */

/** One block of an assistant reply. Only text blocks carry `text`. */
export interface TransportContentBlock {
  type: string;
  text?: string;
}

/**
 * The reply, in the shape `extractJson` reads.
 *
 * `stop_reason` is load-bearing, not diagnostic: `refusal`, `max_tokens` and
 * `model_context_window_exceeded` are each rejected with their own message, and
 * conflating them loses the difference between "the model declined", "the budget
 * ran out" and "the packet was too big".
 */
export interface TransportMessage {
  content: TransportContentBlock[];
  stop_reason: string | null;
}

/** The request, mirroring the Messages API parameters these callers pass. */
export interface TransportRequest {
  model: string;
  max_tokens: number;
  output_config: {
    effort: 'low' | 'medium' | 'high';
    format: { type: 'json_schema'; schema: Record<string, unknown> };
  };
  system: Array<{
    type: 'text';
    text: string;
    cache_control?: { type: 'ephemeral' };
  }>;
  messages: Array<{ role: 'user'; content: string }>;
}

export interface MessagesTransport {
  messages: {
    create(params: TransportRequest): Promise<TransportMessage>;
  };
}

/**
 * Which transport serves the sentinel, read from `SENTINEL_JUDGE`.
 *
 * Defaults to `api`. The CLI path depends on an interactive OAuth session on the
 * host, which a deployed container does not have — so a missing or misspelt
 * value must land on the transport that works from configuration alone rather
 * than on the one that works from a developer's laptop.
 */
export type JudgeTransportName = 'api' | 'cli';

export function judgeTransportFrom(raw: string | undefined): JudgeTransportName {
  return raw?.trim().toLowerCase() === 'cli' ? 'cli' : 'api';
}
