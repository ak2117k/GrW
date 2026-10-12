import type { TransportRequest } from '../transport.types';

/**
 * INR per million tokens. Owner-maintained in `config/ai-model-prices.json`.
 *
 * The two cache rates are DERIVED at load time from the config's top-level
 * `cacheMultipliers` (Anthropic: writes 1.25x input, reads 0.1x input) — the
 * multipliers live in the JSON with the prices, never as code constants.
 */
export interface ModelPrice {
  inputPerMTokInr: number;
  outputPerMTokInr: number;
  /** `cache_creation_input_tokens`: input rate x `cacheMultipliers.writeOfInput`. */
  cacheWritePerMTokInr: number;
  /** `cache_read_input_tokens`: input rate x `cacheMultipliers.readOfInput`. */
  cacheReadPerMTokInr: number;
}

/** Reserved top-level key (not a model id) holding the cache multipliers. */
const CACHE_KEY = 'cacheMultipliers';

function fail(msg: string): never {
  throw new Error(`ai-model-prices: ${msg}`);
}

function rate(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${where} must be a non-negative number`);
  }
  return value;
}

/**
 * Parse the price table. Keys starting with `_` are comments; `cacheMultipliers`
 * (`{ writeOfInput, readOfInput }`) is required — a table that cannot price the
 * sentinel's cached system prompt would silently undercount spend.
 */
export function loadPrices(json: unknown): Map<string, ModelPrice> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    fail('config must be a JSON object keyed by model id');
  }
  const entries = json as Record<string, unknown>;
  const cache = entries[CACHE_KEY];
  if (typeof cache !== 'object' || cache === null || Array.isArray(cache)) {
    fail(`"${CACHE_KEY}" must be an object { writeOfInput, readOfInput }`);
  }
  const c = cache as Record<string, unknown>;
  const writeOfInput = rate(c.writeOfInput, `"${CACHE_KEY}".writeOfInput`);
  const readOfInput = rate(c.readOfInput, `"${CACHE_KEY}".readOfInput`);

  const prices = new Map<string, ModelPrice>();
  for (const [model, raw] of Object.entries(entries)) {
    if (model.startsWith('_') || model === CACHE_KEY) continue;
    if (typeof raw !== 'object' || raw === null) fail(`"${model}" must be an object`);
    const r = raw as Record<string, unknown>;
    const input = rate(r.inputPerMTokInr, `"${model}".inputPerMTokInr`);
    prices.set(model, {
      inputPerMTokInr: input,
      outputPerMTokInr: rate(r.outputPerMTokInr, `"${model}".outputPerMTokInr`),
      cacheWritePerMTokInr: input * writeOfInput,
      cacheReadPerMTokInr: input * readOfInput,
    });
  }
  return prices;
}

/**
 * Cost of one call. `inTok` is the API's `input_tokens` — the UNCACHED input
 * only; cache writes and reads are reported (and billed) separately.
 */
export function costInr(
  p: ModelPrice,
  inTok: number,
  outTok: number,
  cacheWriteTok = 0,
  cacheReadTok = 0,
): number {
  return (
    (inTok * p.inputPerMTokInr +
      outTok * p.outputPerMTokInr +
      cacheWriteTok * p.cacheWritePerMTokInr +
      cacheReadTok * p.cacheReadPerMTokInr) /
    1_000_000
  );
}

/**
 * The most this request can cost (spec §4.5): every output token up to
 * `max_tokens`, plus an input estimate of one token per three JSON characters.
 * Real tokenisers average closer to four characters per token for English and
 * JSON, so three over-estimates — deliberately: this figure gates spend, and an
 * under-estimate is the only way two calls could jointly cross the cap.
 *
 * CACHE WRITES. When any system block carries `cache_control`, a cold cache
 * means the prefix up to that breakpoint is billed as a cache WRITE, which costs
 * more than plain input (1.25x). The worst case therefore prices the whole input
 * estimate at the higher of the two rates: an upper bound whether the cache is
 * cold (write), warm (read, far cheaper) or the prompt is below the cacheable
 * minimum (plain input). Requests without `cache_control` cannot write the cache
 * and keep the plain input rate.
 */
export function worstCaseInr(p: ModelPrice, request: TransportRequest): number {
  const inTok = Math.ceil(JSON.stringify(request).length / 3);
  const caches = request.system.some((b) => b.cache_control !== undefined);
  const inRate = caches ? Math.max(p.inputPerMTokInr, p.cacheWritePerMTokInr) : p.inputPerMTokInr;
  return (inTok * inRate + request.max_tokens * p.outputPerMTokInr) / 1_000_000;
}
