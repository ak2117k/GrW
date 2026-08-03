import { BatchQuotesService } from './batch-quotes.service';
import type { QuoteRequestRef, QuoteResolverLike } from './batch-quotes.service';
import type { QuoteResponse } from '../utils/tick-to-quote';

/** Build a resolver QuoteResponse with sane defaults. */
function quote(over: Partial<QuoteResponse> & { token: string }): QuoteResponse {
  return {
    symbol: 'SYM',
    exchange: 'NSE',
    ltp: 100,
    open: 90,
    high: 110,
    low: 88,
    close: 95,
    volume: 1_000,
    change: 5,
    changePercent: 5.263157894736842,
    timestamp: new Date('2026-08-01T10:00:00Z'),
    ...over,
  };
}

/**
 * Plain fake resolver: returns the seeded quote for any token it knows and
 * omits the rest — exactly the real resolver's "never throws for one bad
 * token" contract.
 */
function fakeResolver(byToken: Record<string, QuoteResponse>) {
  const calls: { userId: string; refs: QuoteRequestRef[] }[] = [];
  const resolver: QuoteResolverLike = {
    async resolveQuotes(userId, refs) {
      calls.push({ userId, refs });
      const out = new Map<string, QuoteResponse>();
      for (const r of refs) {
        const q = byToken[r.token];
        if (q) out.set(r.token, q);
      }
      return out;
    },
  };
  return { resolver, calls };
}

describe('BatchQuotesService', () => {
  describe('happy path', () => {
    it('returns one row per resolved token, across exchanges, in request order', async () => {
      const { resolver, calls } = fakeResolver({
        '99926000': quote({ token: '99926000', symbol: 'NIFTY', ltp: 24_500, close: 24_400 }),
        '2885': quote({ token: '2885', symbol: 'RELIANCE', exchange: 'NSE' }),
        '424961': quote({ token: '424961', symbol: 'CRUDEOIL', exchange: 'MCX', ltp: 5_800 }),
      });
      const service = new BatchQuotesService(resolver);

      const res = await service.getQuotes('user-1', [
        { token: '99926000', exchange: 'NSE' },
        { token: '2885', exchange: 'NSE' },
        { token: '424961', exchange: 'MCX' },
      ]);

      expect(res.quotes.map((q) => q.token)).toEqual(['99926000', '2885', '424961']);
      expect(res.quotes.map((q) => q.exchange)).toEqual(['NSE', 'NSE', 'MCX']);
      expect(res.count).toBe(3);
      // Resolver is called ONCE with every ref — batched, not per-token.
      expect(calls).toHaveLength(1);
      expect(calls[0].userId).toBe('user-1');
      expect(calls[0].refs).toHaveLength(3);
    });

    it('emits exactly the QuoteRow keys the frontend declares — no extras', async () => {
      const { resolver } = fakeResolver({
        '2885': quote({
          token: '2885',
          symbol: 'RELIANCE',
          ltp: 1_234.5,
          open: 1_200,
          high: 1_250,
          low: 1_190,
          close: 1_210,
          volume: 987_654,
          change: 24.5,
          changePercent: 2.0247933884297523,
          vwap: 1_222,
          oi: 42,
        }),
      });
      const service = new BatchQuotesService(resolver);

      const res = await service.getQuotes('u', [{ token: '2885', exchange: 'NSE' }]);

      expect(res.quotes[0]).toEqual({
        token: '2885',
        exchange: 'NSE',
        ltp: 1_234.5,
        open: 1_200,
        high: 1_250,
        low: 1_190,
        close: 1_210,
        volume: 987_654,
        change: 24.5,
        changePercent: 2.02,
      });
      // symbol / timestamp / vwap / oi must NOT leak into the watchlist row.
      expect(Object.keys(res.quotes[0]).sort()).toEqual([
        'change',
        'changePercent',
        'close',
        'exchange',
        'high',
        'low',
        'ltp',
        'open',
        'token',
        'volume',
      ]);
    });

    it('rounds change / changePercent to 2dp and zeroes non-finite numbers', async () => {
      const { resolver } = fakeResolver({
        '1': quote({
          token: '1',
          ltp: Number.NaN,
          volume: Infinity,
          change: 1.239,
          changePercent: -0.005,
        }),
      });
      const service = new BatchQuotesService(resolver);

      const [row] = (await service.getQuotes('u', [{ token: '1', exchange: 'NSE' }])).quotes;

      expect(row.ltp).toBe(0);
      expect(row.volume).toBe(0);
      expect(row.change).toBe(1.24);
      // -0.005 rounds to -0.01 or -0; either way it must be a finite number.
      expect(Number.isFinite(row.changePercent)).toBe(true);
    });

    it('upper-cases the exchange it echoes back', async () => {
      const { resolver, calls } = fakeResolver({ '2885': quote({ token: '2885' }) });
      const service = new BatchQuotesService(resolver);

      const res = await service.getQuotes('u', [{ token: '2885', exchange: 'nse' }]);

      expect(res.quotes[0].exchange).toBe('NSE');
      expect(calls[0].refs[0].exchange).toBe('NSE');
    });

    it('echoes the requested exchange even when the resolver reports another', async () => {
      const { resolver } = fakeResolver({
        '424961': quote({ token: '424961', exchange: 'MCX_FO' }),
      });
      const service = new BatchQuotesService(resolver);

      const res = await service.getQuotes('u', [{ token: '424961', exchange: 'MCX' }]);

      expect(res.quotes[0].exchange).toBe('MCX');
    });
  });

  describe('unquotable tokens', () => {
    it('omits tokens the resolver could not quote', async () => {
      const { resolver } = fakeResolver({
        '2885': quote({ token: '2885' }),
        '3045': quote({ token: '3045' }),
      });
      const service = new BatchQuotesService(resolver);

      const res = await service.getQuotes('u', [
        { token: '2885', exchange: 'NSE' },
        { token: 'BADTOKEN', exchange: 'NSE' },
        { token: '3045', exchange: 'NSE' },
      ]);

      expect(res.quotes.map((q) => q.token)).toEqual(['2885', '3045']);
      expect(res.count).toBe(2);
    });

    it('returns an empty list when nothing resolves', async () => {
      const { resolver } = fakeResolver({});
      const service = new BatchQuotesService(resolver);

      const res = await service.getQuotes('u', [
        { token: '1', exchange: 'NSE' },
        { token: '2', exchange: 'NSE' },
      ]);

      expect(res).toEqual({ quotes: [], count: 0 });
    });
  });

  describe('empty / malformed input', () => {
    it('returns an empty list for an empty items array without calling the resolver', async () => {
      const { resolver, calls } = fakeResolver({ '1': quote({ token: '1' }) });
      const service = new BatchQuotesService(resolver);

      await expect(service.getQuotes('u', [])).resolves.toEqual({ quotes: [], count: 0 });
      expect(calls).toHaveLength(0);
    });

    it.each([[undefined], [null]])('returns an empty list for %p items', async (items) => {
      const { resolver, calls } = fakeResolver({ '1': quote({ token: '1' }) });
      const service = new BatchQuotesService(resolver);

      await expect(
        service.getQuotes('u', items as unknown as { token: string; exchange: string }[]),
      ).resolves.toEqual({ quotes: [], count: 0 });
      expect(calls).toHaveLength(0);
    });

    it('drops entries missing a token or an exchange', async () => {
      const { resolver, calls } = fakeResolver({ '2885': quote({ token: '2885' }) });
      const service = new BatchQuotesService(resolver);

      const res = await service.getQuotes('u', [
        { token: '', exchange: 'NSE' },
        { token: '2885', exchange: '' },
        { token: '2885', exchange: 'NSE' },
        null as unknown as { token: string; exchange: string },
      ]);

      expect(calls[0].refs).toEqual([{ token: '2885', exchange: 'NSE' }]);
      expect(res.quotes).toHaveLength(1);
    });

    it('never calls the resolver when every entry is malformed', async () => {
      const { resolver, calls } = fakeResolver({});
      const service = new BatchQuotesService(resolver);

      await expect(service.getQuotes('u', [{ token: '', exchange: '' }])).resolves.toEqual({
        quotes: [],
        count: 0,
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe('de-duplication', () => {
    it('sends and returns a repeated token only once', async () => {
      const { resolver, calls } = fakeResolver({
        '2885': quote({ token: '2885' }),
        '3045': quote({ token: '3045' }),
      });
      const service = new BatchQuotesService(resolver);

      const res = await service.getQuotes('u', [
        { token: '2885', exchange: 'NSE' },
        { token: '3045', exchange: 'NSE' },
        { token: '2885', exchange: 'NSE' },
        { token: '2885', exchange: 'nse' }, // same instrument, different casing
      ]);

      expect(calls[0].refs).toEqual([
        { token: '2885', exchange: 'NSE' },
        { token: '3045', exchange: 'NSE' },
      ]);
      expect(res.quotes.map((q) => q.token)).toEqual(['2885', '3045']);
      expect(res.count).toBe(2);
    });

    it('keeps the same token on two different exchanges as two refs', async () => {
      const { resolver, calls } = fakeResolver({ '1234': quote({ token: '1234' }) });
      const service = new BatchQuotesService(resolver);

      const res = await service.getQuotes('u', [
        { token: '1234', exchange: 'NSE' },
        { token: '1234', exchange: 'MCX' },
      ]);

      expect(calls[0].refs).toEqual([
        { token: '1234', exchange: 'NSE' },
        { token: '1234', exchange: 'MCX' },
      ]);
      expect(res.quotes.map((q) => q.exchange)).toEqual(['NSE', 'MCX']);
    });
  });

  describe('per-user isolation', () => {
    it('forwards the caller userId verbatim to the resolver', async () => {
      const { resolver, calls } = fakeResolver({ '1': quote({ token: '1' }) });
      const service = new BatchQuotesService(resolver);

      await service.getQuotes('user-a', [{ token: '1', exchange: 'NSE' }]);
      await service.getQuotes('user-b', [{ token: '1', exchange: 'NSE' }]);

      expect(calls.map((c) => c.userId)).toEqual(['user-a', 'user-b']);
    });
  });
});
