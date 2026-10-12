import * as fs from 'node:fs';
import type { TransportRequest } from '../transport.types';
import { resolveAiConfig } from '../routes/route-config';
import { costInr, loadPrices, worstCaseInr, type ModelPrice } from './model-prices';

const req = (): TransportRequest => ({
  model: 'm',
  max_tokens: 1000,
  output_config: { effort: 'high', format: { type: 'json_schema', schema: {} } },
  system: [{ type: 'text', text: 'sys' }],
  messages: [{ role: 'user', content: 'hello' }],
});

const CACHE = { cacheMultipliers: { writeOfInput: 1.25, readOfInput: 0.1 } };

const price = (input: number, output: number): ModelPrice => ({
  inputPerMTokInr: input,
  outputPerMTokInr: output,
  cacheWritePerMTokInr: input * 1.25,
  cacheReadPerMTokInr: input * 0.1,
});

describe('model prices', () => {
  it('loads model ids and ignores "_" keys', () => {
    const prices = loadPrices({ ...CACHE, _note: 'x', m: { inputPerMTokInr: 100, outputPerMTokInr: 500 } });
    expect(prices.get('m')).toEqual({
      inputPerMTokInr: 100,
      outputPerMTokInr: 500,
      cacheWritePerMTokInr: 125,
      cacheReadPerMTokInr: 10,
    });
    expect(prices.has('_note')).toBe(false);
    expect(prices.has('cacheMultipliers')).toBe(false);
  });

  it('derives cache rates from the config multipliers, not code constants', () => {
    const prices = loadPrices({
      cacheMultipliers: { writeOfInput: 2, readOfInput: 0.5 },
      m: { inputPerMTokInr: 100, outputPerMTokInr: 500 },
    });
    expect(prices.get('m')).toEqual(
      expect.objectContaining({ cacheWritePerMTokInr: 200, cacheReadPerMTokInr: 50 }),
    );
  });

  it('rejects a missing or malformed cacheMultipliers block', () => {
    const m = { inputPerMTokInr: 1, outputPerMTokInr: 1 };
    expect(() => loadPrices({ m })).toThrow(/^ai-model-prices: .*cacheMultipliers/);
    expect(() => loadPrices({ cacheMultipliers: { writeOfInput: 1.25 }, m })).toThrow(/^ai-model-prices: /);
    expect(() => loadPrices({ cacheMultipliers: { writeOfInput: -1, readOfInput: 0.1 }, m })).toThrow(
      /^ai-model-prices: /,
    );
    expect(() => loadPrices({ cacheMultipliers: 'x', m })).toThrow(/^ai-model-prices: /);
  });

  it('returns undefined for an unknown model', () => {
    expect(loadPrices({ ...CACHE, m: { inputPerMTokInr: 1, outputPerMTokInr: 1 } }).get('nope')).toBeUndefined();
  });

  it('rejects malformed entries', () => {
    expect(() => loadPrices({ ...CACHE, m: { inputPerMTokInr: 'x', outputPerMTokInr: 1 } })).toThrow(
      /^ai-model-prices: /,
    );
    expect(() => loadPrices({ ...CACHE, m: { inputPerMTokInr: -1, outputPerMTokInr: 1 } })).toThrow(
      /^ai-model-prices: /,
    );
    expect(() => loadPrices([])).toThrow(/^ai-model-prices: /);
  });

  it('computes cost per million tokens', () => {
    const p = price(100, 500);
    expect(costInr(p, 1_000_000, 0)).toBe(100);
    expect(costInr(p, 0, 2_000_000)).toBe(1000);
    expect(costInr(p, 10_000, 1_000)).toBeCloseTo(1 + 0.5, 10);
  });

  it('prices cache writes and cache reads at their own rates', () => {
    const p = price(100, 500);
    expect(costInr(p, 0, 0, 1_000_000, 0)).toBeCloseTo(125, 10);
    expect(costInr(p, 0, 0, 0, 1_000_000)).toBeCloseTo(10, 10);
    expect(costInr(p, 1_000, 1_000, 2_000, 10_000)).toBeCloseTo((1_000 * 100 + 1_000 * 500 + 2_000 * 125 + 10_000 * 10) / 1e6, 10);
  });

  it('worst case without cache_control = ceil(JSON chars / 3) input tokens at the input rate + max_tokens output', () => {
    const p = price(300, 1000);
    const r = req();
    const inTok = Math.ceil(JSON.stringify(r).length / 3);
    expect(worstCaseInr(p, r)).toBeCloseTo((inTok * 300 + 1000 * 1000) / 1_000_000, 10);
    expect(worstCaseInr(p, { ...r, max_tokens: 2000 })).toBeGreaterThan(worstCaseInr(p, r));
  });

  it('worst case with a cache_control block prices the whole input estimate as a cache write', () => {
    const p = price(300, 1000);
    const r: TransportRequest = { ...req(), system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }] };
    const inTok = Math.ceil(JSON.stringify(r).length / 3);
    expect(worstCaseInr(p, r)).toBeCloseTo((inTok * 375 + 1000 * 1000) / 1_000_000, 10);
  });

  it('loads the shipped config/ai-model-prices.json with the sentinel models priced and cache multipliers 1.25 / 0.1', () => {
    const raw = JSON.parse(fs.readFileSync(resolveAiConfig('ai-model-prices.json'), 'utf8'));
    expect(raw.cacheMultipliers).toEqual({ writeOfInput: 1.25, readOfInput: 0.1 });
    const prices = loadPrices(raw);
    for (const m of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5-5', 'claude-sonnet-5-5']) {
      const p = prices.get(m)!;
      expect(p).toBeDefined();
      expect(p.cacheWritePerMTokInr).toBeCloseTo(p.inputPerMTokInr * 1.25, 10);
      expect(p.cacheReadPerMTokInr).toBeCloseTo(p.inputPerMTokInr * 0.1, 10);
    }
  });
});
