import type { TransportRequest } from '../transport.types';

/** INR per million tokens. Owner-maintained in `config/ai-model-prices.json`. */
export interface ModelPrice {
  inputPerMTokInr: number;
  outputPerMTokInr: number;
}

function fail(msg: string): never {
  throw new Error(`ai-model-prices: ${msg}`);
}

function rate(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${where} must be a non-negative number`);
  }
  return value;
}

/** Parse the price table. Keys starting with `_` are comments. */
export function loadPrices(json: unknown): Map<string, ModelPrice> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    fail('config must be a JSON object keyed by model id');
  }
  const prices = new Map<string, ModelPrice>();
  for (const [model, raw] of Object.entries(json as Record<string, unknown>)) {
    if (model.startsWith('_')) continue;
    if (typeof raw !== 'object' || raw === null) fail(`"${model}" must be an object`);
    const r = raw as Record<string, unknown>;
    prices.set(model, {
      inputPerMTokInr: rate(r.inputPerMTokInr, `"${model}".inputPerMTokInr`),
      outputPerMTokInr: rate(r.outputPerMTokInr, `"${model}".outputPerMTokInr`),
    });
  }
  return prices;
}

export function costInr(p: ModelPrice, inTok: number, outTok: number): number {
  return (inTok * p.inputPerMTokInr + outTok * p.outputPerMTokInr) / 1_000_000;
}

/**
 * The most this request can cost (spec §4.5): every output token up to
 * `max_tokens`, plus an input estimate of one token per three JSON characters.
 * Real tokenisers average closer to four characters per token for English and
 * JSON, so three over-estimates — deliberately: this figure gates spend, and an
 * under-estimate is the only way two calls could jointly cross the cap.
 */
export function worstCaseInr(p: ModelPrice, request: TransportRequest): number {
  const inTok = Math.ceil(JSON.stringify(request).length / 3);
  return costInr(p, inTok, request.max_tokens);
}
