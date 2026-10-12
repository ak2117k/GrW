import type { TransportMessage, TransportRequest } from '../transport.types';

/** The providers the gateway can route a call to. */
export type ProviderName = 'anthropic-api' | 'claude-cli';

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
}

/** The reply exactly as callers saw it before the gateway, plus its metadata. */
export interface ProviderResult {
  message: TransportMessage;
  meta: CallMeta;
}

/** One way of serving a Messages-style request. */
export interface ProviderAdapter {
  readonly name: ProviderName;
  send(request: TransportRequest): Promise<ProviderResult>;
}
