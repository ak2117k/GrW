import { describe, it, expect } from 'vitest';
import {
  collectHeldExchanges,
  exchangeInSession,
  hasOpenInSessionTracker,
  shouldAutoRefreshPortfolio,
} from './portfolio-session';

/** A fixed instant expressed in IST. 2026-10-12 is a Monday. */
function ist(dateIso: string): Date {
  return new Date(`${dateIso}+05:30`);
}

const MON_1930 = ist('2026-10-12T19:30:00');
const MON_1000 = ist('2026-10-12T10:00:00');
const SAT_1000 = ist('2026-10-10T10:00:00');
const SAT_1930 = ist('2026-10-10T19:30:00');

describe('exchangeInSession', () => {
  it('NSE/NFO trade 09:15-15:30 IST on weekdays', () => {
    expect(exchangeInSession('NSE', MON_1000)).toBe(true);
    expect(exchangeInSession('NFO', MON_1000)).toBe(true);
    expect(exchangeInSession('NFO', MON_1930)).toBe(false);
    expect(exchangeInSession('NSE', ist('2026-10-12T09:10:00'))).toBe(false);
  });

  it('MCX trades into the evening, including the 23:55 late close', () => {
    expect(exchangeInSession('MCX', MON_1930)).toBe(true);
    expect(exchangeInSession('mcx', ist('2026-10-12T23:50:00'))).toBe(true);
    expect(exchangeInSession('MCX', ist('2026-10-12T23:59:00'))).toBe(false);
    expect(exchangeInSession('MCX', ist('2026-10-12T08:55:00'))).toBe(false);
  });

  it('nothing is in session at the weekend', () => {
    expect(exchangeInSession('NSE', SAT_1000)).toBe(false);
    expect(exchangeInSession('MCX', SAT_1930)).toBe(false);
  });
});

describe('shouldAutoRefreshPortfolio', () => {
  it('polls at 19:30 on a weekday when an MCX instrument is held', () => {
    expect(shouldAutoRefreshPortfolio(['NSE', 'MCX'], MON_1930)).toBe(true);
  });

  it('does NOT poll at 19:30 on a weekday when only NSE/NFO instruments are held', () => {
    expect(shouldAutoRefreshPortfolio(['NSE', 'NFO'], MON_1930)).toBe(false);
    expect(shouldAutoRefreshPortfolio([], MON_1930)).toBe(false);
  });

  it('polls at 10:00 on a weekday (NSE session) whatever is held', () => {
    expect(shouldAutoRefreshPortfolio([], MON_1000)).toBe(true);
    expect(shouldAutoRefreshPortfolio(['MCX'], MON_1000)).toBe(true);
  });

  it('does NOT poll on a Saturday, even with an MCX holding', () => {
    expect(shouldAutoRefreshPortfolio(['MCX'], SAT_1000)).toBe(false);
    expect(shouldAutoRefreshPortfolio(['MCX'], SAT_1930)).toBe(false);
  });
});

describe('hasOpenInSessionTracker', () => {
  const t = (exchange: string, status: 'OPEN' | 'CLOSED') => ({ exchange, status });

  it('is true only for an OPEN tracker whose exchange is trading now', () => {
    expect(hasOpenInSessionTracker([t('MCX', 'OPEN')], MON_1930)).toBe(true);
    expect(hasOpenInSessionTracker([t('NFO', 'OPEN')], MON_1930)).toBe(false);
    expect(hasOpenInSessionTracker([t('MCX', 'CLOSED')], MON_1930)).toBe(false);
    expect(hasOpenInSessionTracker([t('NFO', 'OPEN')], MON_1000)).toBe(true);
    expect(hasOpenInSessionTracker([t('MCX', 'OPEN')], SAT_1930)).toBe(false);
    expect(hasOpenInSessionTracker(null, MON_1000)).toBe(false);
  });
});

describe('collectHeldExchanges', () => {
  it('unions overview positions/holdings with OPEN trackers only', () => {
    const got = collectHeldExchanges(
      { positions: [{ exchange: 'MCX' }], holdings: [{ exchange: 'NSE' }] },
      [
        { exchange: 'NFO', status: 'OPEN' },
        { exchange: 'BSE', status: 'CLOSED' },
      ],
    );
    expect([...got].sort()).toEqual(['MCX', 'NFO', 'NSE']);
  });

  it('is empty-safe', () => {
    expect([...collectHeldExchanges(null, null)]).toEqual([]);
  });
});
