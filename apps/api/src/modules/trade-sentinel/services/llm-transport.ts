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
export type JudgeTransportName = 'api' | 'cli' | 'bedrock';

export function judgeTransportFrom(raw: string | undefined): JudgeTransportName {
  const value = raw?.trim().toLowerCase();
  if (value === 'cli') return 'cli';
  if (value === 'bedrock') return 'bedrock';
  return 'api';
}

/** Vendor prefix Bedrock namespaces Anthropic models under. */
const BEDROCK_VENDOR_PREFIX = 'anthropic.';

/**
 * Cross-region inference profiles, which carry a geography prefix ahead of the
 * vendor one — `us.anthropic.claude-opus-5`. They are how you reach a model
 * that is not directly invocable in a single region, and they are already
 * fully-qualified.
 */
const BEDROCK_INFERENCE_PROFILE = /^(us|eu|apac|us-gov)\./;

/**
 * Map a first-party model id onto its Bedrock name.
 *
 * Bedrock namespaces models by vendor, so `claude-opus-5` is rejected there and
 * `anthropic.claude-opus-5` is accepted. Mapping at the transport boundary keeps
 * `SENTINEL_MODEL_TRIGGERED` / `SENTINEL_MODEL_ROUTINE` portable: the same env
 * value serves the API, the CLI and Bedrock, and switching `SENTINEL_JUDGE` does
 * not require rewriting two more variables to match.
 *
 * An id that is already qualified — by vendor, or by a cross-region inference
 * profile — is returned untouched. Blindly prefixing would produce
 * `anthropic.us.anthropic.…`, which fails as an unknown model rather than as a
 * configuration error, and that is a slow thing to debug.
 */
export function bedrockModelId(model: string): string {
  if (model.startsWith(BEDROCK_VENDOR_PREFIX)) return model;
  if (BEDROCK_INFERENCE_PROFILE.test(model)) return model;
  return `${BEDROCK_VENDOR_PREFIX}${model}`;
}
