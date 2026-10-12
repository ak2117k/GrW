/**
 * The transport seam (`TransportContentBlock`, `TransportMessage`,
 * `TransportRequest`, `MessagesTransport`) now lives in the AI gateway; it is
 * re-exported here so every existing import keeps resolving unchanged. See
 * `ai-gateway/transport.types.ts` for why the interface is drawn where it is.
 */
export type {
  TransportContentBlock,
  TransportMessage,
  TransportRequest,
  MessagesTransport,
} from '../../ai-gateway/transport.types';

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
