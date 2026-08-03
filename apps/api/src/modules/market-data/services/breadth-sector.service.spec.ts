import { MAJOR_STOCKS, SECTOR_INDICES } from '@td/shared/constants';
import {
  BreadthSectorService,
  type BreadthQuoteRef,
  type BreadthQuoteResolver,
} from './breadth-sector.service';
import type { QuoteResponse } from '../utils/tick-to-quote';

const USER = 'user-1';

function quote(token: string, changePercent: number, ltp = 100): QuoteResponse {
  return {
    token,
    symbol: `SYM${token}`,
    exchange: 'NSE',
    ltp,
    open: ltp,
    high: ltp,
    low: ltp,
    close: ltp,
    volume: 0,
    change: (ltp * changePercent) / 100,
    changePercent,
    timestamp: new Date('2026-08-01T10:00:00Z'),
  };
}

/** Records the refs it was asked for and returns a caller-supplied map. */
function makeResolver(
  respond: (refs: BreadthQuoteRef[]) => Map<string, QuoteResponse>,
): BreadthQuoteResolver & { calls: BreadthQuoteRef[][] } {
  const calls: BreadthQuoteRef[][] = [];
  return {
    calls,
    resolveQuotes: jest.fn(async (_userId: string, refs: BreadthQuoteRef[]) => {
      calls.push(refs);
      return respond(refs);
    }),
  };
}

const STOCK_TOKENS = Object.values(MAJOR_STOCKS).map((s) => s.token);
const SECTOR_ENTRIES = Object.values(SECTOR_INDICES);
/** Sector rows the old endpoint emitted: everything except the main indices. */
const EXPECTED_SECTOR_ENTRIES = SECTOR_ENTRIES.filter(
  (s) => s.symbol !== 'NIFTY BANK',
);

describe('BreadthSectorService', () => {
  describe('getBreadth', () => {
    it('counts advances, declines and unchanged (exact zero is unchanged)', async () => {
      const resolver = makeResolver((refs) => {
        const map = new Map<string, QuoteResponse>();
        refs.forEach((ref, i) => {
          // 0, +1, -1, 0, +1, -1 ...
          const pct = i % 3 === 0 ? 0 : i % 3 === 1 ? 1.5 : -2.25;
          map.set(ref.token, quote(ref.token, pct));
        });
        return map;
      });
      const service = new BreadthSectorService(resolver);

      const result = await service.getBreadth(USER);

      const refs = resolver.calls[0];
      const expectUnchanged = refs.filter((_, i) => i % 3 === 0).length;
      const expectAdv = refs.filter((_, i) => i % 3 === 1).length;
      const expectDec = refs.filter((_, i) => i % 3 === 2).length;

      expect(result.unchanged).toBe(expectUnchanged);
      expect(result.advances).toBe(expectAdv);
      expect(result.declines).toBe(expectDec);
      expect(result.total).toBe(refs.length);
      expect(Object.keys(result).sort()).toEqual([
        'adRatio',
        'advances',
        'declines',
        'total',
        'unchanged',
      ]);
    });

    it('rounds adRatio to two decimals', async () => {
      // 2 up, 3 down => 0.6667 -> 0.67
      const resolver = makeResolver((refs) => {
        const map = new Map<string, QuoteResponse>();
        map.set(refs[0].token, quote(refs[0].token, 1));
        map.set(refs[1].token, quote(refs[1].token, 1));
        map.set(refs[2].token, quote(refs[2].token, -1));
        map.set(refs[3].token, quote(refs[3].token, -1));
        map.set(refs[4].token, quote(refs[4].token, -1));
        return map;
      });
      const service = new BreadthSectorService(resolver);

      const result = await service.getBreadth(USER);

      expect(result).toEqual({
        advances: 2,
        declines: 3,
        unchanged: 0,
        adRatio: 0.67,
        total: 5,
      });
    });

    it('falls back to the advance count when there are no declines', async () => {
      const resolver = makeResolver((refs) => {
        const map = new Map<string, QuoteResponse>();
        map.set(refs[0].token, quote(refs[0].token, 1));
        map.set(refs[1].token, quote(refs[1].token, 2));
        return map;
      });
      const service = new BreadthSectorService(resolver);

      const result = await service.getBreadth(USER);

      expect(result.adRatio).toBe(2);
      expect(result.advances).toBe(2);
    });

    it('reports adRatio 0 when nothing advanced or declined', async () => {
      const resolver = makeResolver((refs) => {
        const map = new Map<string, QuoteResponse>();
        map.set(refs[0].token, quote(refs[0].token, 0));
        return map;
      });
      const service = new BreadthSectorService(resolver);

      expect(await service.getBreadth(USER)).toEqual({
        advances: 0,
        declines: 0,
        unchanged: 1,
        adRatio: 0,
        total: 1,
      });
    });

    it('skips tokens missing from the resolver map instead of calling them unchanged', async () => {
      const resolver = makeResolver((refs) => {
        const map = new Map<string, QuoteResponse>();
        // Only the first two tokens price.
        map.set(refs[0].token, quote(refs[0].token, 1));
        map.set(refs[1].token, quote(refs[1].token, -1));
        return map;
      });
      const service = new BreadthSectorService(resolver);

      const result = await service.getBreadth(USER);

      expect(result).toEqual({
        advances: 1,
        declines: 1,
        unchanged: 0,
        adRatio: 1,
        total: 2,
      });
    });

    it('returns all zeros for an empty resolver map', async () => {
      const service = new BreadthSectorService(makeResolver(() => new Map()));

      expect(await service.getBreadth(USER)).toEqual({
        advances: 0,
        declines: 0,
        unchanged: 0,
        adRatio: 0,
        total: 0,
      });
    });

    it('degrades to zeros instead of throwing when the resolver rejects', async () => {
      const service = new BreadthSectorService({
        resolveQuotes: jest.fn().mockRejectedValue(new Error('no broker session')),
      });

      await expect(service.getBreadth(USER)).resolves.toEqual({
        advances: 0,
        declines: 0,
        unchanged: 0,
        adRatio: 0,
        total: 0,
      });
    });

    it('asks for the major stocks and the sector indices, de-duplicated', async () => {
      const resolver = makeResolver(() => new Map());
      await new BreadthSectorService(resolver).getBreadth(USER);

      const refs = resolver.calls[0];
      const keys = refs.map((r) => `${r.exchange}:${r.token}`);
      expect(new Set(keys).size).toBe(keys.length);
      for (const token of STOCK_TOKENS) {
        expect(refs.some((r) => r.token === token)).toBe(true);
      }
      for (const sector of SECTOR_ENTRIES) {
        expect(refs.some((r) => r.token === sector.token)).toBe(true);
      }
      expect(resolver.resolveQuotes).toHaveBeenCalledWith(USER, refs);
    });
  });

  describe('getSectorPerformance', () => {
    it('returns sector rows sorted best-first with the original field shape', async () => {
      const bySymbol: Record<string, number> = {
        'NIFTY IT': -1.2,
        'NIFTY PHARMA': 2.4,
        'NIFTY AUTO': 0.5,
      };
      const resolver = makeResolver((refs) => {
        const map = new Map<string, QuoteResponse>();
        for (const ref of refs) {
          const pct = bySymbol[ref.symbol ?? ''];
          if (pct === undefined) continue;
          map.set(ref.token, quote(ref.token, pct, 1000));
        }
        return map;
      });
      const service = new BreadthSectorService(resolver);

      const sectors = await service.getSectorPerformance(USER);

      expect(sectors).toEqual([
        {
          sector: 'Pharma',
          symbol: 'NIFTY PHARMA',
          token: SECTOR_INDICES.NIFTY_PHARMA.token,
          changePercent: 2.4,
          ltp: 1000,
        },
        {
          sector: 'Auto',
          symbol: 'NIFTY AUTO',
          token: SECTOR_INDICES.NIFTY_AUTO.token,
          changePercent: 0.5,
          ltp: 1000,
        },
        {
          sector: 'IT',
          symbol: 'NIFTY IT',
          token: SECTOR_INDICES.NIFTY_IT.token,
          changePercent: -1.2,
          ltp: 1000,
        },
      ]);
    });

    it('excludes main-index symbols such as NIFTY BANK', async () => {
      const resolver = makeResolver((refs) => {
        const map = new Map<string, QuoteResponse>();
        for (const ref of refs) map.set(ref.token, quote(ref.token, 1));
        return map;
      });
      const service = new BreadthSectorService(resolver);

      const sectors = await service.getSectorPerformance(USER);

      expect(sectors.some((s) => s.symbol === 'NIFTY BANK')).toBe(false);
      expect(sectors).toHaveLength(EXPECTED_SECTOR_ENTRIES.length);
      expect(new Set(sectors.map((s) => s.sector))).toEqual(
        new Set(EXPECTED_SECTOR_ENTRIES.map((s) => s.sector)),
      );
    });

    it('omits sectors the resolver could not price', async () => {
      const resolver = makeResolver((refs) => {
        const map = new Map<string, QuoteResponse>();
        map.set(refs[0].token, quote(refs[0].token, 1.1, 500));
        return map;
      });
      const service = new BreadthSectorService(resolver);

      const sectors = await service.getSectorPerformance(USER);

      expect(sectors).toHaveLength(1);
      expect(sectors[0].changePercent).toBe(1.1);
      expect(sectors[0].ltp).toBe(500);
    });

    it('returns an empty array for an empty resolver map', async () => {
      const service = new BreadthSectorService(makeResolver(() => new Map()));
      await expect(service.getSectorPerformance(USER)).resolves.toEqual([]);
    });

    it('returns an empty array instead of throwing when the resolver rejects', async () => {
      const service = new BreadthSectorService({
        resolveQuotes: jest.fn().mockRejectedValue(new Error('boom')),
      });
      await expect(service.getSectorPerformance(USER)).resolves.toEqual([]);
    });

    it('coerces non-finite broker numbers to 0', async () => {
      const resolver = makeResolver((refs) => {
        const bad = { ...quote(refs[0].token, 0), changePercent: NaN, ltp: NaN };
        return new Map([[refs[0].token, bad]]);
      });
      const service = new BreadthSectorService(resolver);

      const sectors = await service.getSectorPerformance(USER);

      expect(sectors[0].changePercent).toBe(0);
      expect(sectors[0].ltp).toBe(0);
    });

    it('never asks for a main index token', async () => {
      const resolver = makeResolver(() => new Map());
      await new BreadthSectorService(resolver).getSectorPerformance(USER);

      const refs = resolver.calls[0];
      expect(refs.some((r) => r.symbol === 'NIFTY BANK')).toBe(false);
      expect(refs).toHaveLength(EXPECTED_SECTOR_ENTRIES.length);
    });
  });
});
