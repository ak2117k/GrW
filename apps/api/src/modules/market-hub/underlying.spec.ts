import { INDEX_UNDERLYINGS, isDerivative, resolveUnderlying, type UnderlyingLookup } from './underlying';

function lookup(name: string | null, cash: Record<string, string> = {}) {
  const l = {
    contract: jest.fn(async (_exchange: string, _token: string) => (name === null ? null : { name })),
    cash: jest.fn(async (symbol: string, exchange: string) => {
      const token = cash[`${exchange}:${symbol}`];
      return token ? { token, symbol } : null;
    }),
  };
  return l as typeof l & UnderlyingLookup;
}

describe('the one index map', () => {
  it('carries every index that has options, with the Angel tokens the rest of the code uses', () => {
    expect(INDEX_UNDERLYINGS).toEqual({
      NIFTY: { exchange: 'NSE', token: '99926000', symbol: 'NIFTY' },
      BANKNIFTY: { exchange: 'NSE', token: '99926009', symbol: 'BANKNIFTY' },
      FINNIFTY: { exchange: 'NSE', token: '99926037', symbol: 'FINNIFTY' },
      MIDCPNIFTY: { exchange: 'NSE', token: '99926074', symbol: 'MIDCPNIFTY' },
      SENSEX: { exchange: 'BSE', token: '99919000', symbol: 'SENSEX' },
    });
  });
});

describe('isDerivative', () => {
  it('reads the segment, or a strike/expiry suffix after a digit', () => {
    expect(isDerivative({ exchange: 'NFO', symbol: 'NIFTY26OCT25000CE' })).toBe(true);
    expect(isDerivative({ exchange: 'MCX', symbol: 'CRUDEOIL26OCTFUT' })).toBe(true);
    expect(isDerivative({ exchange: 'bfo', symbol: 'SENSEX26OCT81000PE' })).toBe(true);
    expect(isDerivative({ exchange: '', symbol: 'RELIANCE28OCT26FUT' })).toBe(true);
    // 'RELIANCE' ends in "CE" but has no digit before it: a company, not a contract.
    expect(isDerivative({ exchange: 'NSE', symbol: 'RELIANCE' })).toBe(false);
    expect(isDerivative({ exchange: 'NSE', symbol: 'RELIANCE-EQ' })).toBe(false);
  });
});

describe('resolveUnderlying', () => {
  it('resolves an index option to the index token from the one map, with no cash lookup', async () => {
    const l = lookup('NIFTY');
    const r = await resolveUnderlying({ exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' }, l);
    expect(r).toEqual({ name: 'NIFTY', ref: { exchange: 'NSE', token: '99926000', symbol: 'NIFTY' } });
    // Index rows are not in `instruments`: a cash lookup would find nothing and lose the spot.
    expect(l.cash).not.toHaveBeenCalled();
  });

  it('looks the contract up WITH its exchange (tokens collide across segments)', async () => {
    const l = lookup('BANKNIFTY');
    await resolveUnderlying({ exchange: 'nfo', token: '35002', symbol: 'BANKNIFTY26OCT52000PE' }, l);
    expect(l.contract).toHaveBeenCalledWith('NFO', '35002');
  });

  it('resolves SENSEX to BSE and MIDCPNIFTY to its own token', async () => {
    expect((await resolveUnderlying({ exchange: 'BFO', token: '1', symbol: 'SENSEX26OCT81000CE' }, lookup('SENSEX'))).ref).toEqual({
      exchange: 'BSE',
      token: '99919000',
      symbol: 'SENSEX',
    });
    expect((await resolveUnderlying({ exchange: 'NFO', token: '2', symbol: 'MIDCPNIFTY26OCT13000CE' }, lookup('midcpnifty'))).ref).toEqual({
      exchange: 'NSE',
      token: '99926074',
      symbol: 'MIDCPNIFTY',
    });
  });

  it('resolves a stock option to its NSE cash row, -EQ first, then the bare name', async () => {
    const eq = lookup('KEI', { 'NSE:KEI-EQ': '13310' });
    expect(await resolveUnderlying({ exchange: 'NFO', token: '77', symbol: 'KEI29SEP265800CE' }, eq)).toEqual({
      name: 'KEI',
      ref: { exchange: 'NSE', token: '13310', symbol: 'KEI-EQ' },
    });
    const bare = lookup('KEI', { 'NSE:KEI': '13310' });
    const r = await resolveUnderlying({ exchange: 'NFO', token: '77', symbol: 'KEI29SEP265800CE' }, bare);
    expect(bare.cash.mock.calls).toEqual([
      ['KEI-EQ', 'NSE'],
      ['KEI', 'NSE'],
    ]);
    expect(r.ref).toEqual({ exchange: 'NSE', token: '13310', symbol: 'KEI' });
  });

  it('keeps the name when no cash row matches (the level book and the news still work)', async () => {
    expect(await resolveUnderlying({ exchange: 'NFO', token: '77', symbol: 'KEI29SEP265800CE' }, lookup('KEI'))).toEqual({
      name: 'KEI',
      ref: null,
    });
  });

  it('gives an MCX future its name but no underlying ref, without a cash lookup', async () => {
    const l = lookup('CRUDEOIL');
    expect(await resolveUnderlying({ exchange: 'MCX', token: '448', symbol: 'CRUDEOIL26OCTFUT' }, l)).toEqual({
      name: 'CRUDEOIL',
      ref: null,
    });
    expect(l.cash).not.toHaveBeenCalled();
  });

  it('resolves an MCX option to the nearest FUTURE of the same name on MCX when a future lookup is given', async () => {
    const l = lookup('CRUDEOIL');
    const future = jest.fn(async (_name: string, _exchange: string) => ({ token: '472789', symbol: 'CRUDEOIL19OCT26FUT' }));
    const r = await resolveUnderlying(
      { exchange: 'MCX', token: '5001', symbol: 'CRUDEOIL15OCT268850PE' },
      { ...l, future },
    );
    expect(r).toEqual({ name: 'CRUDEOIL', ref: { exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19OCT26FUT' } });
    // The option's own master NAME, never the mini (CRUDEOILM) and never a cash row.
    expect(future).toHaveBeenCalledWith('CRUDEOIL', 'MCX', null);
    expect(l.cash).not.toHaveBeenCalled();
  });

  it('hands the future lookup the OPTION’S OWN expiry, so a far-month option can get its month', async () => {
    const expiry = new Date(2026, 10, 16);
    const l = {
      contract: jest.fn(async () => ({ name: 'CRUDEOIL', expiry })),
      cash: jest.fn(async () => null),
    };
    const future = jest.fn(async () => ({ token: '488001', symbol: 'CRUDEOIL18NOV26FUT' }));
    const r = await resolveUnderlying({ exchange: 'MCX', token: '6001', symbol: 'CRUDEOIL16NOV269000CE' }, { ...l, future });
    expect(future).toHaveBeenCalledWith('CRUDEOIL', 'MCX', expiry);
    expect(r.ref).toEqual({ exchange: 'MCX', token: '488001', symbol: 'CRUDEOIL18NOV26FUT' });
  });

  it('keeps the MCX name with no ref when no future matches', async () => {
    const l = lookup('CRUDEOIL');
    const future = jest.fn(async () => null);
    expect(await resolveUnderlying({ exchange: 'MCX', token: '5001', symbol: 'CRUDEOIL15OCT268850PE' }, { ...l, future })).toEqual({
      name: 'CRUDEOIL',
      ref: null,
    });
  });

  it('never asks the future lookup about an NFO or BFO contract', async () => {
    const future = jest.fn(async () => ({ token: 'x', symbol: 'x' }));
    await resolveUnderlying({ exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' }, { ...lookup('NIFTY'), future });
    await resolveUnderlying({ exchange: 'NFO', token: '77', symbol: 'KEI29SEP265800CE' }, { ...lookup('KEI', { 'NSE:KEI-EQ': '13310' }), future });
    await resolveUnderlying({ exchange: 'BFO', token: '1', symbol: 'SENSEX26OCT81000CE' }, { ...lookup('SENSEX'), future });
    expect(future).not.toHaveBeenCalled();
  });

  it('a contract missing from the master resolves to nothing', async () => {
    expect(await resolveUnderlying({ exchange: 'NFO', token: '9', symbol: 'X26OCT1CE' }, lookup(null))).toEqual({ name: null, ref: null });
  });

  it('lets a lookup failure through, so the caller decides whether to cache', async () => {
    const l = lookup('KEI');
    l.contract.mockRejectedValueOnce(new Error('db down'));
    await expect(resolveUnderlying({ exchange: 'NFO', token: '77', symbol: 'KEI29SEP265800CE' }, l)).rejects.toThrow('db down');
  });
});
