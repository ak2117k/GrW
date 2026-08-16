import { sanitizeOverview } from './broker-overview.service';

/** One Angel One position row, in the broker's own casing. */
const rawPosition = (over: Record<string, unknown> = {}) => ({
  tradingsymbol: 'BDL25AUG261400CE',
  symboltoken: '54321',
  symbolname: 'BDL',
  exchange: 'NFO',
  netqty: '425',
  ltp: '40.2',
  pnl: '-1500',
  ...over,
});

const positionsFrom = (rows: unknown) =>
  sanitizeOverview({ funds: null, profile: null, positions: rows, holdings: null }).positions;

describe('sanitizeOverview — positions carry what a chart link needs', () => {
  it('keeps the CONTRACT token and the underlying name the broker already sent', () => {
    // Both were being dropped. Without symboltoken the P&L cannot link to the
    // contract's chart at all; without symbolname the symbol cell has no
    // underlying to resolve, and parsing one out of the tradingsymbol guesses
    // wrong on any name containing digits.
    const [p] = positionsFrom([rawPosition()]);
    expect(p.token).toBe('54321');
    expect(p.underlyingSymbol).toBe('BDL');
    // Resolved against the instrument master by the service, not here — this
    // function stays pure so it is testable without a database.
    expect(p.underlyingToken).toBeNull();
  });

  it('still maps the five fields it always did', () => {
    const [p] = positionsFrom([rawPosition()]);
    expect(p).toEqual(
      expect.objectContaining({
        symbol: 'BDL25AUG261400CE',
        exchange: 'NFO',
        netQty: 425,
        ltp: 40.2,
        pnl: -1500,
      }),
    );
  });

  it('normalises the underlying to upper case, so the row matches the master', () => {
    const [p] = positionsFrom([rawPosition({ symbolname: ' bdl ' })]);
    expect(p.underlyingSymbol).toBe('BDL');
  });

  it('reports a missing token as empty and a missing underlying as null', () => {
    // The two absences mean different things downstream: no token means the
    // contract chart is unavailable, no underlying means there is no second
    // chart to offer. Collapsing them would hide one behind the other.
    const [p] = positionsFrom([rawPosition({ symboltoken: undefined, symbolname: undefined })]);
    expect(p.token).toBe('');
    expect(p.underlyingSymbol).toBeNull();
  });

  it('survives a malformed positions section', () => {
    expect(positionsFrom(null)).toEqual([]);
    expect(positionsFrom(undefined)).toEqual([]);
    expect(positionsFrom({})).toEqual([]);
  });

  it('keeps a HOLDING token too, so the portfolio table can link its chart', () => {
    // A holding needs no underlying pair: it is cash equity, so the thing held
    // IS the thing charted.
    const overview = sanitizeOverview({
      funds: null,
      profile: null,
      positions: null,
      holdings: {
        holdings: [
          { tradingsymbol: 'SUZLON-EQ', symboltoken: '12018', exchange: 'NSE', quantity: '100' },
          { tradingsymbol: 'NOTOKEN-EQ', exchange: 'NSE', quantity: '5' },
        ],
      },
    });
    expect(overview.holdings[0].token).toBe('12018');
    // Empty, not undefined: the UI branches on falsiness to decide whether it
    // can link straight through or must resolve the token first.
    expect(overview.holdings[1].token).toBe('');
  });

  it('maps a cash position with its series suffix intact', () => {
    // `BDL-EQ` vs underlying `BDL` is how the UI tells cash from a derivative,
    // so the suffix must survive sanitisation.
    const [p] = positionsFrom([
      rawPosition({ tradingsymbol: 'BDL-EQ', symbolname: 'BDL', exchange: 'NSE' }),
    ]);
    expect(p.symbol).toBe('BDL-EQ');
    expect(p.underlyingSymbol).toBe('BDL');
  });
});
