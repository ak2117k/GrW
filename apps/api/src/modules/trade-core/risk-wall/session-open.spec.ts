import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import { ALL_CORE_EXCHANGES, exchangesForScope, istMinutesOf, nextSessionOpen, VEHICLE_EXCHANGES } from './session-open';

const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });
const T = (iso: string) => new Date(iso);

describe('vehicle venues', () => {
  it('cash and MTF trade on NSE, option buying on NFO', () => {
    expect(VEHICLE_EXCHANGES).toEqual({ CASH_INTRADAY: ['NSE'], MTF: ['NSE'], OPTIONS_BUY: ['NFO'] });
    expect(exchangesForScope('OPTIONS_BUY')).toEqual(['NFO']);
    expect(exchangesForScope('MTF')).toEqual(['NSE']);
    expect(exchangesForScope('ALL')).toEqual(['NSE', 'NFO']);
    expect(ALL_CORE_EXCHANGES).toEqual(['NSE', 'NFO']);
  });
});

describe('nextSessionOpen (D5: a looser change waits for this)', () => {
  it('Friday 11:00 IST → Monday 09:15 IST', () => {
    expect(nextSessionOpen(clock, ['NSE'], T('2026-10-09T05:30:00.000Z'))).toEqual(T('2026-10-12T03:45:00.000Z'));
  });

  it('before today’s open → today’s open', () => {
    expect(nextSessionOpen(clock, ['NSE'], T('2026-10-12T02:30:00.000Z'))).toEqual(T('2026-10-12T03:45:00.000Z'));
  });

  it('during the session → tomorrow’s open, never later today', () => {
    expect(nextSessionOpen(clock, ALL_CORE_EXCHANGES, T('2026-10-12T05:00:00.000Z'))).toEqual(T('2026-10-13T03:45:00.000Z'));
  });

  it('skips an exchange holiday (Dussehra, Tue 2026-10-20)', () => {
    expect(nextSessionOpen(clock, ['NFO'], T('2026-10-19T10:30:00.000Z'))).toEqual(T('2026-10-21T03:45:00.000Z'));
  });

  it('picks the latest open across exchanges', () => {
    const fake = { nextOpen: (ex: string) => (ex === 'NSE' ? T('2026-10-13T03:45:00.000Z') : T('2026-10-14T03:45:00.000Z')) };
    expect(nextSessionOpen(fake, ['NSE', 'NFO'], T('2026-10-12T05:00:00.000Z'))).toEqual(T('2026-10-14T03:45:00.000Z'));
  });

  it('null when any exchange has no known open, or no exchange is given', () => {
    const fake = { nextOpen: (ex: string) => (ex === 'NSE' ? T('2026-10-13T03:45:00.000Z') : null) };
    expect(nextSessionOpen(fake, ['NSE', 'NFO'], T('2026-10-12T05:00:00.000Z'))).toBeNull();
    expect(nextSessionOpen(clock, [], T('2026-10-12T05:00:00.000Z'))).toBeNull();
  });
});

describe('istMinutesOf', () => {
  it('converts an instant to minutes since IST midnight', () => {
    expect(istMinutesOf(T('2026-10-12T05:00:00.000Z'))).toBe(10 * 60 + 30);
    expect(istMinutesOf(T('2026-10-12T18:29:00.000Z'))).toBe(23 * 60 + 59);
    expect(istMinutesOf(T('2026-10-12T18:30:00.000Z'))).toBe(0);
  });
});
