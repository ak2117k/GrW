import {
  COMMODITY_SESSION,
  EQUITY_SESSION,
  isAnyExchangeOpen,
  isAnyMarketOpen,
  isExchangeOpen,
  minutesToClose,
  sessionFor,
} from './market-sessions';

/** IST helper: `2026-08-18T16:30 IST` -> the UTC instant. */
const ist = (hhmm: string, day = '2026-08-18') =>
  new Date(`${day}T${hhmm}:00+05:30`);

/**
 * THE BUG THIS FILE EXISTS FOR. The sentinel's session gate was 09:15–15:30
 * applied to every position regardless of venue. Correct for NSE, wrong for MCX,
 * which trades until 23:30 — so a commodity position was structurally unwatched
 * for eight hours of its own trading day, and nothing said so. The runner simply
 * returned early on every tick, and a quiet monitor is indistinguishable from a
 * calm market.
 */
describe('market sessions', () => {
  it('keeps a commodity open long after the equity close', () => {
    const evening = ist('16:30'); // Tuesday
    expect(isExchangeOpen('NSE', evening)).toBe(false);
    expect(isExchangeOpen('NFO', evening)).toBe(false);
    expect(isExchangeOpen('MCX', evening)).toBe(true);
  });

  it('closes MCX at 23:30, not midnight', () => {
    expect(isExchangeOpen('MCX', ist('23:29'))).toBe(true);
    expect(isExchangeOpen('MCX', ist('23:31'))).toBe(false);
  });

  it('treats a derivative segment as its cash market', () => {
    // NFO/BFO trade the equity hours of the market they derive from.
    expect(sessionFor('NFO')).toEqual(EQUITY_SESSION);
    expect(sessionFor('BFO')).toEqual(EQUITY_SESSION);
    expect(sessionFor('MCX')).toEqual(COMMODITY_SESSION);
  });

  it('falls back to the NARROWEST window for an unknown venue', () => {
    // An unrecognised exchange should be watched for LESS time, not more —
    // judging a position on prices that are not moving is the worse error.
    expect(sessionFor('WHATEVER')).toEqual(EQUITY_SESSION);
  });

  it('is closed everywhere at the weekend', () => {
    const saturday = ist('11:00', '2026-08-22');
    expect(isExchangeOpen('NSE', saturday)).toBe(false);
    expect(isExchangeOpen('MCX', saturday)).toBe(false);
    expect(isAnyMarketOpen(saturday)).toBe(false);
  });

  describe('isAnyExchangeOpen', () => {
    it('wakes a mixed book in the evening for the commodity alone', () => {
      expect(isAnyExchangeOpen(['NFO', 'MCX'], ist('16:30'))).toBe(true);
    });

    it('leaves an equity-only book asleep in the evening', () => {
      // The reason this is per-user: one tenant's commodity must not keep every
      // other tenant's equity positions polling all evening, spending money to
      // re-read prices that stopped moving at 15:30.
      expect(isAnyExchangeOpen(['NFO', 'NSE'], ist('16:30'))).toBe(false);
    });

    it('treats an empty book as CLOSED', () => {
      // Nothing held means nothing to watch. Defaulting to open would poll a
      // user with no positions forever.
      expect(isAnyExchangeOpen([], ist('11:00'))).toBe(false);
    });
  });

  describe('minutesToClose', () => {
    it('counts down to the venue’s OWN close', () => {
      expect(minutesToClose('NSE', ist('15:00'))).toBe(30);
      // The same instant, on a commodity, has seven and a half hours left.
      expect(minutesToClose('MCX', ist('16:00'))).toBe(450);
    });

    it('is null outside the session rather than zero', () => {
      // Zero would read as "the bell is about to ring".
      expect(minutesToClose('NSE', ist('16:00'))).toBeNull();
      expect(minutesToClose('MCX', ist('08:00'))).toBeNull();
    });
  });

  describe('isAnyMarketOpen', () => {
    it('spans the widest window any venue keeps', () => {
      expect(isAnyMarketOpen(ist('09:05'))).toBe(true); // MCX open, NSE not yet
      expect(isAnyMarketOpen(ist('22:00'))).toBe(true); // MCX only
    });

    it('is false when nothing can possibly be trading', () => {
      // This is the branch that keeps a 03:00 tick from touching the database.
      expect(isAnyMarketOpen(ist('03:00'))).toBe(false);
      expect(isAnyMarketOpen(ist('23:45'))).toBe(false);
    });
  });
});
