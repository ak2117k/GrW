import {
  BANK_SECTORS, INDEX_UNDERLYINGS_V2, MCX_BENCHMARKS_V2, MCX_GROUP, MCX_PARENT_V2, MCX_UNDERLYINGS, SECTOR_TOKEN_NAME,
  instrumentKeysOf, keysOfTags, newsPositionOf, toIndexedArticle,
} from './keys';

describe('keys', () => {
  it('every MCX underlying resolves to a benchmark with a group', () => {
    for (const u of MCX_UNDERLYINGS) {
      const p = newsPositionOf(u, 'MCX', null);
      expect('unresolved' in p ? p.unresolved : null).toBeNull();
      if (!('unresolved' in p)) expect(MCX_GROUP[p.key]).toBeDefined();
    }
    for (const b of MCX_BENCHMARKS_V2) expect(MCX_GROUP[b]).toMatch(/^MCX (ENERGY|BULLION|BASE METALS|AGRI)$/);
    for (const [mini, parent] of Object.entries(MCX_PARENT_V2)) {
      expect(MCX_BENCHMARKS_V2).toContain(parent);
      expect(MCX_UNDERLYINGS).toContain(mini);
    }
  });

  it('positions: stock, index, commodity mini, unknown MCX, unresolved', () => {
    expect(newsPositionOf('TATAMOTORS-EQ', 'NSE', null)).toEqual({ kind: 'STOCK', underlying: 'TATAMOTORS', key: 'TATAMOTORS', exchange: 'NSE', expiry: null });
    expect(newsPositionOf('BANKNIFTY', 'NFO', '2026-10-28')).toEqual({ kind: 'INDEX', underlying: 'BANKNIFTY', key: 'BANKNIFTY', exchange: 'NFO', expiry: '2026-10-28' });
    expect(newsPositionOf('GOLDM', 'MCX', '2026-11-05')).toEqual({ kind: 'COMMODITY', underlying: 'GOLDM', key: 'GOLD', exchange: 'MCX', expiry: '2026-11-05' });
    expect(newsPositionOf('STEELREBAR', 'MCX', null)).toEqual({ unresolved: expect.stringMatching(/STEELREBAR.*NOT a finding that nothing was published/) });
    expect(newsPositionOf(null, 'NFO', null)).toEqual({ unresolved: expect.stringMatching(/could not be resolved/) });
  });

  it('instrument keys and tag keys', () => {
    expect(instrumentKeysOf({ kind: 'STOCK', underlying: 'SBIN', key: 'SBIN', exchange: 'NSE', expiry: null })).toEqual(['I:SBIN']);
    expect(instrumentKeysOf({ kind: 'INDEX', underlying: 'NIFTY', key: 'NIFTY', exchange: 'NFO', expiry: null })).toEqual(['X:NIFTY']);
    expect(instrumentKeysOf({ kind: 'COMMODITY', underlying: 'CRUDEOILM', key: 'CRUDEOIL', exchange: 'MCX', expiry: null })).toEqual(['I:CRUDEOIL']);
    expect(keysOfTags({ instruments: ['SBIN'], sectors: ['NIFTY PSU BANK'], indices: ['BANKNIFTY'], markets: ['IN'] })).toEqual([
      'I:SBIN', 'S:NIFTY PSU BANK', 'X:BANKNIFTY', 'M:IN',
    ]);
  });

  it('sector tables', () => {
    expect(SECTOR_TOKEN_NAME['99926009']).toBe('NIFTY BANK');
    expect(Object.keys(SECTOR_TOKEN_NAME)).toHaveLength(15);
    expect([...BANK_SECTORS].sort()).toEqual(['NIFTY BANK', 'NIFTY PSU BANK', 'NIFTY PVT BANK']);
    expect(INDEX_UNDERLYINGS_V2).toEqual(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX', 'SENSEX50']);
  });

  it('toIndexedArticle truncates the title to 160 chars and keeps only known market tags', () => {
    const a = toIndexedArticle({
      id: 'a1', title: 'x'.repeat(200), source: 'ET', sentiment: null, publishedAt: new Date(1000), fetchedAt: new Date(2000),
      dateInferred: false, instruments: ['SBIN'], sectors: [], indices: [], markets: ['IN', 'MARS'],
    });
    expect(a.title).toHaveLength(160);
    expect(a.title.endsWith('…')).toBe(true);
    expect(a.tags.markets).toEqual(['IN']);
    expect(a.publishedAt).toBe(1000);
  });
});
