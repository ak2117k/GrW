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
 *
 * `vertex` (2026-11-21) serves every call from Claude on Google Cloud Vertex AI:
 * project `VERTEX_AI_PROJECT_ID`, region `VERTEX_AI_LOCATION` (default `global`),
 * service-account key via `GOOGLE_APPLICATION_CREDENTIALS`. Model ids are mapped
 * with {@link vertexModelId}.
 */
export type JudgeTransportName = 'api' | 'cli' | 'bedrock' | 'vertex';

export function judgeTransportFrom(raw: string | undefined): JudgeTransportName {
  const value = raw?.trim().toLowerCase();
  if (value === 'cli') return 'cli';
  if (value === 'bedrock') return 'bedrock';
  if (value === 'vertex') return 'vertex';
  return 'api';
}

/**
 * The model each id is served as on Vertex: the SAME tier, its current version
 * (owner decision 2026-11-21). Code and env name `claude-opus-5` / `claude-sonnet-5`;
 * on the CLI those aliases resolved for us, on Vertex they move to the 5.5 releases.
 * Every request sets `output_config.effort` explicitly, so Opus 5.5's lower default
 * effort does not change anything. A Bedrock-style `anthropic.` prefix is dropped —
 * Vertex ids are bare.
 *
 * HAIKU: `claude-haiku-5-5` is NOT enabled on the Vertex project (404 in global, us,
 * us-east5, europe-west1 — tested 2026-11-21), and Haiku 4.5 rejects `effort`. So the
 * Haiku jobs (signal parse/vision/info/image-setup, news impact) are served by Sonnet
 * 5.5, the next tier up. Once Haiku 5.5 is enabled there, set
 * `VERTEX_MODEL_MAP=claude-haiku-5-5=claude-haiku-5-5` — no code change.
 *
 * `VERTEX_MODEL_MAP` (`from=to,from=to`) overrides or extends this table.
 */
const VERTEX_MODEL_DEFAULTS: Readonly<Record<string, string>> = {
  'claude-opus-5': 'claude-opus-5-5',
  'claude-sonnet-5': 'claude-sonnet-5-5',
  'claude-haiku-5-5': 'claude-sonnet-5-5',
};

/** `VERTEX_MODEL_MAP` parsed: `a=b,c=d` → {a: b, c: d}; malformed pairs are ignored. */
export function vertexModelMapFrom(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const [from, to] = pair.split('=').map((s) => s?.trim());
    if (from && to) out[from] = to;
  }
  return out;
}

export function vertexModelId(model: string, overrides: Readonly<Record<string, string>> = {}): string {
  const bare = model.startsWith(BEDROCK_VENDOR_PREFIX) ? model.slice(BEDROCK_VENDOR_PREFIX.length) : model;
  return overrides[bare] ?? VERTEX_MODEL_DEFAULTS[bare] ?? bare;
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
