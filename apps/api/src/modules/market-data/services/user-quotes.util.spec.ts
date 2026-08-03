import { groupTokensByExchange, mapFullQuotes } from './user-quotes.util';

/**
 * `GET /market-data/indices` needs a quote for ~7 index tokens on every 5s poll
 * from every open market page. Fetching them one-at-a-time would burn 7 calls
 * against Angel's 10 req/sec ceiling, so they go out as ONE `marketData` call:
 * `exchangeTokens` takes a token LIST per exchange.
 */
describe('groupTokensByExchange', () => {
  it('groups tokens under their exchange', () => {
    expect(
      groupTokensByExchange([
        { token: '99926000', exchange: 'NSE' },
        { token: '99926009', exchange: 'NSE' },
        { token: '1', exchange: 'BSE' },
      ]),
    ).toEqual({ NSE: ['99926000', '99926009'], BSE: ['1'] });
  });

  it('returns an empty object for no tokens', () => {
    expect(groupTokensByExchange([])).toEqual({});
  });

  it('de-duplicates a token repeated within one exchange', () => {
    expect(
      groupTokensByExchange([
        { token: '99926000', exchange: 'NSE' },
        { token: '99926000', exchange: 'NSE' },
      ]),
    ).toEqual({ NSE: ['99926000'] });
  });

  it('keeps the same token on two different exchanges', () => {
    expect(
      groupTokensByExchange([
        { token: '500325', exchange: 'BSE' },
        { token: '500325', exchange: 'NSE' },
      ]),
    ).toEqual({ BSE: ['500325'], NSE: ['500325'] });
  });
});

describe('mapFullQuotes', () => {
  const fetched = [
    { symbolToken: '99926000', tradingSymbol: 'NIFTY', ltp: 24500, close: 24000, tradeVolume: 10 },
    { symbolToken: '99926009', tradingSymbol: 'BANKNIFTY', ltp: 52000, close: 51500, tradeVolume: 20 },
  ];

  it('maps every fetched entry, keyed by token', () => {
    const out = mapFullQuotes(fetched);
    expect(out.size).toBe(2);
    expect(out.get('99926000')?.ltp).toBe(24500);
    expect(out.get('99926009')?.symbol).toBe('BANKNIFTY');
  });

  it('returns an empty map when nothing was fetched', () => {
    expect(mapFullQuotes([]).size).toBe(0);
  });

  it('tolerates a null/absent fetched array (throttle or no entitlement)', () => {
    // Angel answers `data: null` when throttled — must not throw.
    expect(mapFullQuotes(null).size).toBe(0);
    expect(mapFullQuotes(undefined).size).toBe(0);
  });

  it('accepts the lower-case field spellings Angel sometimes returns', () => {
    const out = mapFullQuotes([
      { symboltoken: '1594', tradingsymbol: 'INFY-EQ', ltp: 1500, close: 1490 },
    ]);
    expect(out.get('1594')?.symbol).toBe('INFY-EQ');
  });

  it('skips an entry with no resolvable token rather than keying it as ""', () => {
    const out = mapFullQuotes([{ ltp: 100 }, { symbolToken: '5', ltp: 200 }]);
    expect(out.has('')).toBe(false);
    expect(out.get('5')?.ltp).toBe(200);
  });
});
