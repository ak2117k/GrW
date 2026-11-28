import { rematchStrike, STRIKE_BAND } from './strike-sanity';

/** Index closes of late Nov 2026 (rounded; FINNIFTY sits ~7% above NIFTY, BANKEX ~12% above BANKNIFTY). */
const SPOTS = new Map([
  ['NIFTY', 26_000],
  ['BANKNIFTY', 59_000],
  ['SENSEX', 85_000],
  ['FINNIFTY', 27_800],
  ['MIDCPNIFTY', 13_500],
  ['BANKEX', 66_000],
]);

describe('rematchStrike — an option strike > 15% from its index is re-matched to the one index it fits', () => {
  it('the band is 15%', () => expect(STRIKE_BAND).toBe(0.15));

  it('a strike near its own index is left alone', () => {
    expect(rematchStrike({ underlying: 'SENSEX', instrumentKind: 'PE', strike: 85_500 }, SPOTS)).toEqual({ action: 'keep' });
    expect(rematchStrike({ underlying: 'NIFTY', instrumentKind: 'CE', strike: 22_500 }, SPOTS)).toEqual({ action: 'keep' }); // 13.5% off
  });

  it('a strike that fits exactly one other index is re-matched to it', () => {
    expect(rematchStrike({ underlying: 'NIFTY', instrumentKind: 'CE', strike: 13_500 }, SPOTS)).toEqual({ action: 'rematch', underlying: 'MIDCPNIFTY', from: 'NIFTY' });
    expect(rematchStrike({ underlying: 'NIFTY', instrumentKind: 'PE', strike: 85_000 }, SPOTS)).toEqual({ action: 'rematch', underlying: 'SENSEX', from: 'NIFTY' });
    // SHRI RAM "SENSEX 25850 PE" when FINNIFTY's spot is unknown: NIFTY is the only fit.
    const noFin = new Map([...SPOTS].filter(([k]) => k !== 'FINNIFTY'));
    expect(rematchStrike({ underlying: 'SENSEX', instrumentKind: 'PE', strike: 25_850 }, noFin)).toEqual({ action: 'rematch', underlying: 'NIFTY', from: 'SENSEX' });
  });

  it('two indices fit → unresolved as today (prod 2026-11-27: both examples are ambiguous under the 15% rule)', () => {
    // SHRI RAM "SENSEX 25850 PE": NIFTY 0.6% and FINNIFTY 7% away.
    expect(rematchStrike({ underlying: 'SENSEX', instrumentKind: 'PE', strike: 25_850 }, SPOTS)).toEqual({ action: 'unresolved', fits: ['NIFTY', 'FINNIFTY'] });
    // Stock Gainers "SENSEX 62500 PE": BANKNIFTY 5.9% and BANKEX 5.3% away.
    expect(rematchStrike({ underlying: 'SENSEX', instrumentKind: 'PE', strike: 62_500 }, SPOTS)).toEqual({ action: 'unresolved', fits: ['BANKNIFTY', 'BANKEX'] });
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
