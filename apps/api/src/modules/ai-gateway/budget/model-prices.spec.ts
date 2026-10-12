import * as fs from 'node:fs';
import type { TransportRequest } from '../transport.types';
import { resolveAiConfig } from '../routes/route-config';
import { costInr, loadPrices, worstCaseInr } from './model-prices';

const req = (): TransportRequest => ({
  model: 'm',
  max_tokens: 1000,
  output_config: { effort: 'high', format: { type: 'json_schema', schema: {} } },
  system: [{ type: 'text', text: 'sys' }],
  messages: [{ role: 'user', content: 'hello' }],
});

describe('model prices', () => {
  it('loads model ids and ignores "_" keys', () => {
    const prices = loadPrices({ _note: 'x', m: { inputPerMTokInr: 100, outputPerMTokInr: 500 } });
    expect(prices.get('m')).toEqual({ inputPerMTokInr: 100, outputPerMTokInr: 500 });
    expect(prices.has('_note')).toBe(false);
  });

  it('returns undefined for an unknown model', () => {
    expect(loadPrices({ m: { inputPerMTokInr: 1, outputPerMTokInr: 1 } }).get('nope')).toBeUndefined();
  });

  it('rejects malformed entries', () => {
    expect(() => loadPrices({ m: { inputPerMTokInr: 'x', outputPerMTokInr: 1 } })).toThrow(/^ai-model-prices: /);
    expect(() => loadPrices({ m: { inputPerMTokInr: -1, outputPerMTokInr: 1 } })).toThrow(/^ai-model-prices: /);
    expect(() => loadPrices([])).toThrow(/^ai-model-prices: /);
  });

  it('computes cost per million tokens', () => {
    const p = { inputPerMTokInr: 100, outputPerMTokInr: 500 };
    expect(costInr(p, 1_000_000, 0)).toBe(100);
    expect(costInr(p, 0, 2_000_000)).toBe(1000);
    expect(costInr(p, 10_000, 1_000)).toBeCloseTo(1 + 0.5, 10);
  });

  it('worst case = ceil(JSON chars / 3) input tokens + max_tokens output tokens', () => {
    const p = { inputPerMTokInr: 300, outputPerMTokInr: 1000 };
    const r = req();
    const inTok = Math.ceil(JSON.stringify(r).length / 3);
    expect(worstCaseInr(p, r)).toBeCloseTo((inTok * 300 + 1000 * 1000) / 1_000_000, 10);
    expect(worstCaseInr(p, { ...r, max_tokens: 2000 })).toBeGreaterThan(worstCaseInr(p, r));
  });

  it('loads the shipped config/ai-model-prices.json with the sentinel models priced', () => {
    const prices = loadPrices(JSON.parse(fs.readFileSync(resolveAiConfig('ai-model-prices.json'), 'utf8')));
    for (const m of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']) {
      expect(prices.get(m)).toBeDefined();
    }
  });
});
