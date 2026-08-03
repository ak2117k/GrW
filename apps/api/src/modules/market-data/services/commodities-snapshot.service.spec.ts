import { CommoditiesSnapshotService } from './commodities-snapshot.service';
import type { QuoteResponse } from '../utils/tick-to-quote';

/** The exact key set `GET /api/market-data/commodities` has always returned and
 *  that `apps/web/src/hooks/useCommodities.ts` destructures. */
const ROW_KEYS = [
  'symbol',
  'token',
  'exchange',
  'contractSymbol',
  'expiry',
  'ltp',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'change',
  'changePercent',
].sort();

interface Contract {
  symbol: string;
  token: string;
  exchange: string;
  contractSymbol: string;
  expiry: string;
}

const CRUDE: Contract = {
  symbol: 'CRUDEOIL',
  token: '426341',
  exchange: 'MCX',
  contractSymbol: 'CRUDEOIL19AUG26FUT',
  expiry: '19AUG2026',
};
const GOLD: Contract = {
  symbol: 'GOLD',
  token: '431231',
  exchange: 'MCX',
  contractSymbol: 'GOLD05OCT26FUT',
  expiry: '05OCT2026',
};

function quote(token: string, over: Partial<QuoteResponse> = {}): QuoteResponse {
  return {
    token,
    symbol: 'CRUDEOIL',
    exchange: 'MCX',
    ltp: 5500,
    open: 5400,
    high: 5550,
    low: 5380,
    close: 5450,
    volume: 12345,
    change: 50,
    changePercent: 0.9174311926605505,
    timestamp: new Date('2026-08-03T06:30:00.000Z'),
    ...over,
  };
}

function makeService(contracts: Contract[], quotes: Map<string, QuoteResponse>) {
  const resolveFrontMonthTokens = jest.fn().mockResolvedValue(contracts);
  const resolveQuotes = jest.fn().mockResolvedValue(quotes);
  const service = new CommoditiesSnapshotService(
    { resolveFrontMonthTokens } as never,
    { resolveQuotes } as never,
  );
  return { service, resolveFrontMonthTokens, resolveQuotes };
}

describe('CommoditiesSnapshotService', () => {
  describe('happy path', () => {
    it('returns one fully-populated row per resolved contract', async () => {
      const quotes = new Map<string, QuoteResponse>([
        [CRUDE.token, quote(CRUDE.token)],
        [GOLD.token, quote(GOLD.token, { symbol: 'GOLD', ltp: 98000, close: 97500, change: 500, changePercent: 0.5128 })],
      ]);
      const { service } = makeService([CRUDE, GOLD], quotes);

      const result = await service.getSnapshot('user-1');

      expect(result.count).toBe(2);
      expect(result.commodities).toHaveLength(2);
      expect(result.commodities[0]).toEqual({
        symbol: 'CRUDEOIL',
        token: '426341',
        exchange: 'MCX',
        contractSymbol: 'CRUDEOIL19AUG26FUT',
        expiry: '19AUG2026',
        ltp: 5500,
        open: 5400,
        high: 5550,
        low: 5380,
        close: 5450,
        volume: 12345,
        change: 50,
        changePercent: 0.92,
      });
      expect(result.commodities[1].symbol).toBe('GOLD');
      expect(result.commodities[1].ltp).toBe(98000);
      expect(result.commodities[1].changePercent).toBe(0.51);
    });

    it('passes the resolved tokens through to the per-user quote resolver', async () => {
      const { service, resolveQuotes } = makeService(
        [CRUDE, GOLD],
        new Map<string, QuoteResponse>(),
      );

      await service.getSnapshot('user-42');

      expect(resolveQuotes).toHaveBeenCalledTimes(1);
      expect(resolveQuotes).toHaveBeenCalledWith('user-42', [
        { token: '426341', exchange: 'MCX', symbol: 'CRUDEOIL' },
        { token: '431231', exchange: 'MCX', symbol: 'GOLD' },
      ]);
    });

    it('defaults a blank contract exchange to MCX in the quote request', async () => {
      const { service, resolveQuotes } = makeService(
        [{ ...CRUDE, exchange: '' }],
        new Map<string, QuoteResponse>(),
      );

      await service.getSnapshot('user-1');

      expect(resolveQuotes).toHaveBeenCalledWith('user-1', [
        { token: '426341', exchange: 'MCX', symbol: 'CRUDEOIL' },
      ]);
    });

    it('preserves contract order and does not drop unquoted contracts', async () => {
      const quotes = new Map<string, QuoteResponse>([[GOLD.token, quote(GOLD.token)]]);
      const { service } = makeService([CRUDE, GOLD], quotes);

      const result = await service.getSnapshot('user-1');

      expect(result.commodities.map((c) => c.symbol)).toEqual(['CRUDEOIL', 'GOLD']);
      expect(result.count).toBe(2);
    });
  });

  describe('a commodity the broker cannot quote', () => {
    it('emits the row with ltp null and zeroed numerics', async () => {
      const quotes = new Map<string, QuoteResponse>([[CRUDE.token, quote(CRUDE.token)]]);
      const { service } = makeService([CRUDE, GOLD], quotes);

      const result = await service.getSnapshot('user-1');
      const gold = result.commodities.find((c) => c.symbol === 'GOLD')!;

      expect(gold).toEqual({
        symbol: 'GOLD',
        token: '431231',
        exchange: 'MCX',
        contractSymbol: 'GOLD05OCT26FUT',
        expiry: '05OCT2026',
        ltp: null,
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        volume: 0,
        change: 0,
        changePercent: 0,
      });
      // null, NOT 0 — the frontend hook uses `c.ltp == null` to skip the row.
      expect(gold.ltp).toBeNull();
    });

    it('yields ltp null for every row when the resolver returns nothing', async () => {
      const { service } = makeService([CRUDE, GOLD], new Map<string, QuoteResponse>());

      const result = await service.getSnapshot('user-1');

      expect(result.count).toBe(2);
      expect(result.commodities.every((c) => c.ltp === null)).toBe(true);
      expect(result.commodities.every((c) => c.change === 0 && c.changePercent === 0)).toBe(true);
    });

    it('keeps a quoted-but-zero ltp as 0 rather than null', async () => {
      const quotes = new Map<string, QuoteResponse>([
        [CRUDE.token, quote(CRUDE.token, { ltp: 0, close: 0, change: 0, changePercent: 0 })],
      ]);
      const { service } = makeService([CRUDE], quotes);

      const result = await service.getSnapshot('user-1');

      expect(result.commodities[0].ltp).toBe(0);
    });

    it('coerces non-finite broker numbers to 0', async () => {
      const quotes = new Map<string, QuoteResponse>([
        [
          CRUDE.token,
          quote(CRUDE.token, {
            ltp: 5500,
            open: NaN,
            high: Infinity,
            low: undefined as never,
            close: NaN,
            volume: NaN,
            change: NaN,
            changePercent: Infinity,
          }),
        ],
      ]);
      const { service } = makeService([CRUDE], quotes);

      const result = await service.getSnapshot('user-1');
      const row = result.commodities[0];

      expect(row.ltp).toBe(5500);
      expect(row.open).toBe(0);
      expect(row.high).toBe(0);
      expect(row.low).toBe(0);
      expect(row.close).toBe(0);
      expect(row.volume).toBe(0);
      expect(row.change).toBe(0);
      expect(row.changePercent).toBe(0);
    });
  });

  describe('empty contract list', () => {
    it('returns an empty snapshot', async () => {
      const { service } = makeService([], new Map<string, QuoteResponse>());

      const result = await service.getSnapshot('user-1');

      expect(result).toEqual({ commodities: [], count: 0 });
    });

    it('does not call the quote resolver at all', async () => {
      const { service, resolveQuotes } = makeService([], new Map<string, QuoteResponse>());

      await service.getSnapshot('user-1');

      expect(resolveQuotes).not.toHaveBeenCalled();
    });
  });

  describe('row shape', () => {
    it('matches the legacy endpoint field-for-field (quoted row)', async () => {
      const quotes = new Map<string, QuoteResponse>([[CRUDE.token, quote(CRUDE.token)]]);
      const { service } = makeService([CRUDE], quotes);

      const result = await service.getSnapshot('user-1');

      expect(Object.keys(result.commodities[0]).sort()).toEqual(ROW_KEYS);
    });

    it('matches the legacy endpoint field-for-field (unquoted row)', async () => {
      const { service } = makeService([CRUDE], new Map<string, QuoteResponse>());

      const result = await service.getSnapshot('user-1');

      expect(Object.keys(result.commodities[0]).sort()).toEqual(ROW_KEYS);
    });

    it('does not leak resolver-only fields (timestamp, vwap, oi) into the row', async () => {
      const quotes = new Map<string, QuoteResponse>([
        [CRUDE.token, quote(CRUDE.token, { vwap: 5470, oi: 9876 })],
      ]);
      const { service } = makeService([CRUDE], quotes);

      const result = await service.getSnapshot('user-1');
      const row = result.commodities[0] as unknown as Record<string, unknown>;

      expect(row.timestamp).toBeUndefined();
      expect(row.vwap).toBeUndefined();
      expect(row.oi).toBeUndefined();
    });

    it('takes symbol/contractSymbol/expiry from the contract, not the quote', async () => {
      const quotes = new Map<string, QuoteResponse>([
        // Angel FULL responses often carry a blank or differently-formatted symbol.
        [CRUDE.token, quote(CRUDE.token, { symbol: '', exchange: 'NFO' })],
      ]);
      const { service } = makeService([CRUDE], quotes);

      const result = await service.getSnapshot('user-1');

      expect(result.commodities[0].symbol).toBe('CRUDEOIL');
      expect(result.commodities[0].exchange).toBe('MCX');
      expect(result.commodities[0].contractSymbol).toBe('CRUDEOIL19AUG26FUT');
      expect(result.commodities[0].expiry).toBe('19AUG2026');
    });
  });
});
