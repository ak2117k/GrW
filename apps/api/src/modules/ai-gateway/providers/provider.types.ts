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
 */
export interface CallMeta {
  inputTokens: number | null;
  outputTokens: number | null;
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
