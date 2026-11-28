import { rematchStrike, STRIKE_BAND } from './strike-sanity';

/**
 * The REAL 2026-11-27 closes (controller, from candles_1d): NIFTY 25 607.2, BANKNIFTY 63 040.9, FINNIFTY 28 337.15,
 * SENSEX 83 339.26. BANKEX has no data (omitted). MIDCPNIFTY is ASSUMED (13 400) for the single-fit case only.
 */
const SPOTS = new Map([
  ['NIFTY', 25_607.2],
  ['BANKNIFTY', 63_040.9],
  ['SENSEX', 83_339.26],
  ['FINNIFTY', 28_337.15],
  ['MIDCPNIFTY', 13_400],
]);

describe('rematchStrike — an option strike > 15% from its index is re-matched', () => {
  it('the band is 15%', () => expect(STRIKE_BAND).toBe(0.15));

  it('a strike near its own index is left alone', () => {
    expect(rematchStrike({ underlying: 'SENSEX', instrumentKind: 'PE', strike: 83_500 }, SPOTS)).toEqual({ action: 'keep' });
    expect(rematchStrike({ underlying: 'NIFTY', instrumentKind: 'CE', strike: 22_400 }, SPOTS)).toEqual({ action: 'keep' }); // 12.5% off
  });

  it('a strike that fits exactly one other index is re-matched to it', () => {
    expect(rematchStrike({ underlying: 'NIFTY', instrumentKind: 'CE', strike: 13_400 }, SPOTS)).toEqual({ action: 'rematch', underlying: 'MIDCPNIFTY', from: 'NIFTY', candidates: ['MIDCPNIFTY'] });
    expect(rematchStrike({ underlying: 'NIFTY', instrumentKind: 'PE', strike: 83_300 }, SPOTS)).toEqual({ action: 'rematch', underlying: 'SENSEX', from: 'NIFTY', candidates: ['SENSEX'] });
  });

  it('SHRI RAM "SENSEX 25850 PE": NIFTY (0.9%) beats FINNIFTY (8.8%) — closest spot wins', () => {
    expect(rematchStrike({ underlying: 'SENSEX', instrumentKind: 'PE', strike: 25_850 }, SPOTS)).toEqual({ action: 'rematch', underlying: 'NIFTY', from: 'SENSEX', candidates: ['NIFTY', 'FINNIFTY'] });
  });

  it('Stock Gainers "SENSEX 62500 PE": BANKNIFTY (0.9% off, the only fit with BANKEX unknown)', () => {
    expect(rematchStrike({ underlying: 'SENSEX', instrumentKind: 'PE', strike: 62_500 }, SPOTS)).toEqual({ action: 'rematch', underlying: 'BANKNIFTY', from: 'SENSEX', candidates: ['BANKNIFTY'] });
  });

  it('a strike off an index step disqualifies that index', () => {
    // 62 550 is not on BANKNIFTY's 100 step: nothing fits.
    expect(rematchStrike({ underlying: 'SENSEX', instrumentKind: 'PE', strike: 62_550 }, SPOTS)).toEqual({ action: 'unresolved', fits: [] });
    // 25 825 is on neither 50 step: unresolved.
    expect(rematchStrike({ underlying: 'SENSEX', instrumentKind: 'PE', strike: 25_825 }, SPOTS)).toEqual({ action: 'unresolved', fits: [] });
  });

  it('an exact distance tie goes by liquidity (NIFTY > … > BANKEX)', () => {
    const tie = new Map([['SENSEX', 83_339.26], ['NIFTY', 26_000], ['FINNIFTY', 26_000]]);
    expect(rematchStrike({ underlying: 'SENSEX', instrumentKind: 'PE', strike: 26_000 }, tie)).toMatchObject({ underlying: 'NIFTY', candidates: ['NIFTY', 'FINNIFTY'] });
  });

  it('no index fits → unresolved', () => {
    expect(rematchStrike({ underlying: 'NIFTY', instrumentKind: 'CE', strike: 2_000 }, SPOTS)).toEqual({ action: 'unresolved', fits: [] });
  });

  it('futures, stocks and indices with no known spot are never checked', () => {
    expect(rematchStrike({ underlying: 'SENSEX', instrumentKind: 'FUT', strike: null }, SPOTS)).toEqual({ action: 'keep' });
    expect(rematchStrike({ underlying: 'RELIANCE', instrumentKind: 'CE', strike: 25_850 }, SPOTS)).toEqual({ action: 'keep' });
    expect(rematchStrike({ underlying: 'SENSEX', instrumentKind: 'PE', strike: 25_850 }, new Map([['NIFTY', 26_000]]))).toEqual({ action: 'keep' });
  });
});
