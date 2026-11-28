import { rematchStrike, STRIKE_BAND } from './strike-sanity';

/**
 * ASSUMED 2026-11-27 closes (no prod DB access from the implementer; NIFTY ~25 690 per the controller, the rest
 * rounded from the late-Nov levels): FINNIFTY sits ~6% above NIFTY, BANKEX ~12% above BANKNIFTY.
 */
const SPOTS = new Map([
  ['NIFTY', 25_690],
  ['BANKNIFTY', 58_900],
  ['SENSEX', 84_500],
  ['FINNIFTY', 27_300],
  ['MIDCPNIFTY', 13_400],
  ['BANKEX', 65_800],
]);

describe('rematchStrike — an option strike > 15% from its index is re-matched', () => {
  it('the band is 15%', () => expect(STRIKE_BAND).toBe(0.15));

  it('a strike near its own index is left alone', () => {
    expect(rematchStrike({ underlying: 'SENSEX', instrumentKind: 'PE', strike: 85_500 }, SPOTS)).toEqual({ action: 'keep' });
    expect(rematchStrike({ underlying: 'NIFTY', instrumentKind: 'CE', strike: 22_400 }, SPOTS)).toEqual({ action: 'keep' }); // 12.8% off
  });

  it('a strike that fits exactly one other index is re-matched to it', () => {
    expect(rematchStrike({ underlying: 'NIFTY', instrumentKind: 'CE', strike: 13_400 }, SPOTS)).toEqual({ action: 'rematch', underlying: 'MIDCPNIFTY', from: 'NIFTY', candidates: ['MIDCPNIFTY'] });
    expect(rematchStrike({ underlying: 'NIFTY', instrumentKind: 'PE', strike: 84_500 }, SPOTS)).toEqual({ action: 'rematch', underlying: 'SENSEX', from: 'NIFTY', candidates: ['SENSEX'] });
  });

  it('SHRI RAM "SENSEX 25850 PE": NIFTY (0.6%) beats FINNIFTY (5.3%) — closest spot wins', () => {
    expect(rematchStrike({ underlying: 'SENSEX', instrumentKind: 'PE', strike: 25_850 }, SPOTS)).toEqual({ action: 'rematch', underlying: 'NIFTY', from: 'SENSEX', candidates: ['NIFTY', 'FINNIFTY'] });
  });

  it('Stock Gainers "SENSEX 62500 PE": BANKEX (5.0%) is closer than BANKNIFTY (6.1%) under the ruling', () => {
    expect(rematchStrike({ underlying: 'SENSEX', instrumentKind: 'PE', strike: 62_500 }, SPOTS)).toEqual({ action: 'rematch', underlying: 'BANKEX', from: 'SENSEX', candidates: ['BANKEX', 'BANKNIFTY'] });
  });

  it('a strike off an index step disqualifies that index', () => {
    // 62 550 is not on the 100 step of BANKNIFTY / BANKEX: nothing fits.
    expect(rematchStrike({ underlying: 'SENSEX', instrumentKind: 'PE', strike: 62_550 }, SPOTS)).toEqual({ action: 'unresolved', fits: [] });
    // 25 825 is on neither 50 step: unresolved.
    expect(rematchStrike({ underlying: 'SENSEX', instrumentKind: 'PE', strike: 25_825 }, SPOTS)).toEqual({ action: 'unresolved', fits: [] });
  });

  it('an exact distance tie goes by liquidity (NIFTY > … > BANKEX)', () => {
    const tie = new Map([['SENSEX', 84_500], ['NIFTY', 26_000], ['FINNIFTY', 26_000]]);
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
