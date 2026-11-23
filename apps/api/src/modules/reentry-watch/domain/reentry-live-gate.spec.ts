import { liveGate, reentryLiveLimitsFrom, REENTRY_LIVE_DEFAULTS, type LiveGateInput } from './reentry-live-gate';

/** A real instant at an IST wall-clock time on 2026-11-23. */
const ist = (hhmm: string) => new Date(`2026-11-23T${hhmm}:00+05:30`);
const L = reentryLiveLimitsFrom({});

const base = (o: Partial<LiveGateInput> = {}): LiveGateInput => ({
  mode: 'live',
  source: 'REAL',
  judge: { mode: 'on', decision: 'ENTER', ok: true },
  reentriesOfWatch: 0,
  liveToday: 0,
  liveLossesToday: 0,
  dailyLossStopHit: false,
  underlyingOpenOrInFlight: false,
  venue: 'NSE',
  underlying: 'NIFTY',
  atIst: ist('11:00'),
  venueCloseIst: '15:30',
  ...o,
});
const mcx = (o: Partial<LiveGateInput> = {}) => base({ venue: 'MCX', underlying: 'GOLD', venueCloseIst: '23:55', ...o });
const limitOf = (o: Partial<LiveGateInput>, lim = L) => {
  const r = liveGate(base(o), lim);
  return r.live ? 'LIVE' : r.limit;
};

describe('reentryLiveLimitsFrom', () => {
  it('defaults (§3 / §6a)', () => {
    const p: string[] = [];
    expect(reentryLiveLimitsFrom({}, p)).toEqual({
      riskRupees: 2000, maxPerTrade: 4, maxPerDay: 6, maxLosses: 3, fromIst: '09:45', nseUntilIst: '15:00', mcxUntilIst: '23:00', noEntryLastMin: 30,
    });
    expect(p).toEqual([]);
    expect(REENTRY_LIVE_DEFAULTS.noEntryLastMin).toBe(30);
  });

  it('reads valid env values', () => {
    const p: string[] = [];
    const l = reentryLiveLimitsFrom(
      { REENTRY_LIVE_RISK_RUPEES: '1500', REENTRY_LIVE_MAX_PER_TRADE: '2', REENTRY_LIVE_MAX_PER_DAY: '0', REENTRY_LIVE_MAX_LOSSES: '1', REENTRY_LIVE_FROM_IST: '10:00', REENTRY_LIVE_NSE_UNTIL_IST: '14:30', REENTRY_LIVE_MCX_UNTIL_IST: '9:59' },
      p,
    );
    // MCX end 09:59 is before the 10:00 start → both reset to defaults.
    expect(l).toMatchObject({ riskRupees: 1500, maxPerTrade: 2, maxPerDay: 0, maxLosses: 1, nseUntilIst: '14:30', fromIst: '09:45', mcxUntilIst: '23:00' });
    expect(p).toHaveLength(1);
  });

  it('invalid values → defaults with a problem each (never wider than allowed)', () => {
    const p: string[] = [];
    const l = reentryLiveLimitsFrom(
      { REENTRY_LIVE_RISK_RUPEES: '-5', REENTRY_LIVE_MAX_PER_TRADE: '4.5', REENTRY_LIVE_MAX_PER_DAY: '60', REENTRY_LIVE_MAX_LOSSES: 'x', REENTRY_LIVE_FROM_IST: '25:00', REENTRY_LIVE_NSE_UNTIL_IST: 'noon', REENTRY_LIVE_MCX_UNTIL_IST: '23:61' },
      p,
    );
    expect(l).toEqual(reentryLiveLimitsFrom({}));
    expect(p).toHaveLength(7);
    expect(reentryLiveLimitsFrom({ REENTRY_LIVE_RISK_RUPEES: '0' }).riskRupees).toBe(2000);
    expect(reentryLiveLimitsFrom({ REENTRY_LIVE_RISK_RUPEES: '20000' }).riskRupees).toBe(2000);
  });

  it('NSE end not after start → default window', () => {
    const p: string[] = [];
    expect(reentryLiveLimitsFrom({ REENTRY_LIVE_FROM_IST: '15:00', REENTRY_LIVE_NSE_UNTIL_IST: '15:00' }, p)).toMatchObject({ fromIst: '09:45', nseUntilIst: '15:00' });
    expect(p).toHaveLength(1);
  });
});

describe('liveGate', () => {
  it('all clear → live', () => {
    expect(liveGate(base(), L)).toEqual({ live: true });
    expect(liveGate(mcx({ atIst: ist('20:00') }), L)).toEqual({ live: true });
  });

  it('MODE: off / paper never live', () => {
    expect(limitOf({ mode: 'paper' })).toBe('MODE');
    expect(limitOf({ mode: 'off' })).toBe('MODE');
    expect(limitOf({ mode: 'LIVE' as never })).toBe('MODE');
  });

  it('SOURCE: a PAPER exit never re-enters live', () => {
    expect(limitOf({ source: 'PAPER' })).toBe('SOURCE');
  });

  it('JUDGE: only mode on + ok + ENTER', () => {
    expect(limitOf({ judge: { mode: 'observe', decision: 'ENTER', ok: true } })).toBe('JUDGE');
    expect(limitOf({ judge: { mode: 'off', decision: null, ok: true } })).toBe('JUDGE');
    expect(limitOf({ judge: { mode: 'on', decision: null, ok: false } })).toBe('JUDGE');
    expect(limitOf({ judge: { mode: 'on', decision: 'ENTER', ok: false } })).toBe('JUDGE');
    expect(limitOf({ judge: { mode: 'on', decision: 'SKIP', ok: true } })).toBe('JUDGE');
    expect(limitOf({ judge: { mode: 'on', decision: 'WAIT', ok: true } })).toBe('JUDGE');
    expect(limitOf({ judge: { mode: 'on', decision: 'REJECT', ok: true } })).toBe('JUDGE');
    expect(limitOf({ judge: null as never })).toBe('JUDGE');
  });

  it('MAX_PER_TRADE: 4th allowed (3 before), 5th blocked (4 before)', () => {
    expect(limitOf({ reentriesOfWatch: 3 })).toBe('LIVE');
    const r = liveGate(base({ reentriesOfWatch: 4 }), L);
    expect(r).toEqual({ live: false, limit: 'MAX_PER_TRADE', detail: 'MAX_PER_TRADE 4/4' });
  });

  it('MAX_PER_DAY: 6th allowed (5 today), 7th blocked (6 today)', () => {
    expect(limitOf({ liveToday: 5 })).toBe('LIVE');
    expect(liveGate(base({ liveToday: 6 }), L)).toEqual({ live: false, limit: 'MAX_PER_DAY', detail: 'MAX_PER_DAY 6/6' });
  });

  it('LOSS_STOP: 2 losses allowed, the 3rd loss stops the day', () => {
    expect(limitOf({ liveLossesToday: 2 })).toBe('LIVE');
    expect(limitOf({ liveLossesToday: 3 })).toBe('LOSS_STOP');
  });

  it('DAILY_LOSS_STOP', () => {
    expect(limitOf({ dailyLossStopHit: true })).toBe('DAILY_LOSS_STOP');
  });

  it('UNDERLYING_OPEN', () => {
    expect(limitOf({ underlyingOpenOrInFlight: true })).toBe('UNDERLYING_OPEN');
  });

  it('TIME_WINDOW NSE/BSE: 09:44 blocked, 09:45 live, 14:59 live, 15:00 blocked', () => {
    expect(limitOf({ atIst: ist('09:44') })).toBe('TIME_WINDOW');
    expect(limitOf({ atIst: ist('09:45') })).toBe('LIVE');
    expect(limitOf({ atIst: ist('14:59') })).toBe('LIVE');
    expect(limitOf({ atIst: ist('15:00') })).toBe('TIME_WINDOW');
    expect(limitOf({ venue: 'BSE', underlying: 'SENSEX', atIst: ist('15:00') })).toBe('TIME_WINDOW');
    expect(limitOf({ venue: 'BSE', underlying: 'SENSEX', atIst: ist('09:45') })).toBe('LIVE');
  });

  it('TIME_WINDOW MCX: 09:44 blocked, 22:59 live, 23:00 blocked', () => {
    const at = (t: string) => {
      const r = liveGate(mcx({ atIst: ist(t) }), L);
      return r.live ? 'LIVE' : r.limit;
    };
    expect(at('09:44')).toBe('TIME_WINDOW');
    expect(at('09:45')).toBe('LIVE');
    expect(at('22:59')).toBe('LIVE');
    expect(at('23:00')).toBe('TIME_WINDOW');
  });

  it('TIME_WINDOW last 30 min of the venue: 30 min to close live, 29 blocked, after close blocked', () => {
    expect(limitOf({ venueCloseIst: '14:00', atIst: ist('13:30') })).toBe('LIVE');
    expect(limitOf({ venueCloseIst: '14:00', atIst: ist('13:31') })).toBe('TIME_WINDOW');
    expect(limitOf({ venueCloseIst: '14:00', atIst: ist('14:10') })).toBe('TIME_WINDOW');
    // MCX closing 23:30 (US summer): 22:59 is 31 min to close → live; 23:01 would be blocked by both rules.
    const r = liveGate(mcx({ venueCloseIst: '23:30', atIst: ist('22:59') }), L);
    expect(r.live).toBe(true);
    const r2 = liveGate(mcx({ venueCloseIst: '23:20', atIst: ist('22:59') }), L);
    expect(r2).toMatchObject({ live: false, limit: 'TIME_WINDOW' });
  });

  it('each null / unreadable input → UNKNOWN_INPUT (never live)', () => {
    const cases: Partial<LiveGateInput>[] = [
      { reentriesOfWatch: null },
      { liveToday: null },
      { liveLossesToday: null },
      { dailyLossStopHit: null },
      { underlyingOpenOrInFlight: null },
      { venueCloseIst: null },
      { venueCloseIst: 'late' },
      { atIst: new Date('nope') },
      { atIst: null as never },
      { reentriesOfWatch: -1 },
      { liveToday: Number.NaN },
      { liveLossesToday: 1.5 },
      { venue: 'NFO' as never },
      { underlying: 'TCS' },
    ];
    for (const c of cases) {
      const r = liveGate(base(c), L);
      expect({ c, r: r.live ? 'LIVE' : r.limit }).toEqual({ c, r: 'UNKNOWN_INPUT' });
    }
  });

  it('unreadable limits → UNKNOWN_INPUT', () => {
    expect(limitOf({}, { ...L, maxPerDay: Number.NaN })).toBe('UNKNOWN_INPUT');
    expect(limitOf({}, { ...L, fromIst: 'x' })).toBe('UNKNOWN_INPUT');
    expect(limitOf({}, null as never)).toBe('UNKNOWN_INPUT');
  });

  it('UNKNOWN_INPUT wins over the caps (unreadable is checked before counts)', () => {
    expect(limitOf({ liveToday: null, reentriesOfWatch: 9 })).toBe('UNKNOWN_INPUT');
  });

  it('every underlying in the universe can go live (§3 #11)', () => {
    for (const u of ['NIFTY', 'BANKNIFTY']) expect(limitOf({ underlying: u })).toBe('LIVE');
    expect(limitOf({ underlying: 'SENSEX', venue: 'BSE' })).toBe('LIVE');
    for (const u of ['CRUDEOIL', 'GOLD', 'SILVER']) expect(liveGate(mcx({ underlying: u }), L).live).toBe(true);
  });
});
