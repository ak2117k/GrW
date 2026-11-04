import { SENTINEL_CLOCK } from '../../trade-sentinel/overnight/overnight-calendar';
import { checkInputs, sessionVenue, type InputsSnapshot, type WatchedUnderlying } from './inputs-health';

/** IST wall-clock → Date. 2026-11-04 is a Wednesday (a trading day). */
const ist = (s: string) => new Date(`${s}+05:30`);
const MIN = 60_000;

const u = (o: Partial<WatchedUnderlying> & { name: string; exchange: string }): WatchedUnderlying => ({
  why: ['ENGINE'],
  barRefs: ['NFO:1'],
  lastBarAt: null,
  optionable: true,
  lastChainAt: null,
  ...o,
});

const snap = (now: Date, o: Partial<InputsSnapshot> = {}): InputsSnapshot => ({ now, underlyings: [], lastNewsAt: now, engineNews: [], ...o });
const kinds = (s: InputsSnapshot) => checkInputs(s, SENTINEL_CLOCK).map((p) => `${p.kind}:${p.underlying}`);

describe('sessionVenue', () => {
  it('maps index option venues to their spot session', () => {
    expect(sessionVenue('NFO')).toBe('NSE');
    expect(sessionVenue('BFO')).toBe('BSE');
    expect(sessionVenue('mcx')).toBe('MCX');
  });
});

describe('checkInputs — NO_BARS', () => {
  const now = ist('2026-11-04T11:00:00');

  it('raises NO_BARS when the newest bar is more than 10 min old in session (GOLD 2026-11-04: none at all)', () => {
    const s = snap(now, { underlyings: [u({ name: 'GOLD', exchange: 'MCX', lastBarAt: null, lastChainAt: now, barRefs: [] })] });
    const p = checkInputs(s, SENTINEL_CLOCK);
    expect(p.map((x) => x.kind)).toEqual(['NO_BARS']);
    expect(p[0].message).toContain('none ever stored');
    expect(p[0].message).toContain('no spot / future / cash line found');
  });

  it('is quiet when a bar is 9 min old', () => {
    const s = snap(now, { underlyings: [u({ name: 'NIFTY', exchange: 'NFO', lastBarAt: new Date(now.getTime() - 9 * MIN), lastChainAt: now })] });
    expect(kinds(s)).toEqual([]);
  });

  it('measures from the session open, not from yesterday’s last bar (09:20 is not late)', () => {
    const at = ist('2026-11-04T09:20:00');
    const s = snap(at, { underlyings: [u({ name: 'NIFTY', exchange: 'NFO', lastBarAt: ist('2026-11-03T15:29:00'), lastChainAt: at })] });
    expect(kinds(s)).toEqual([]);
    const later = ist('2026-11-04T09:30:00');
    expect(kinds({ ...s, now: later, lastNewsAt: later })).toEqual(['NO_BARS:NIFTY']);
  });
});

describe('checkInputs — NO_CHAIN', () => {
  const now = ist('2026-11-04T11:00:00');

  it('raises NO_CHAIN after 30 min without an oi_snapshot, for optionable underlyings only', () => {
    const stale = new Date(now.getTime() - 31 * MIN);
    const s = snap(now, {
      underlyings: [
        u({ name: 'GOLD', exchange: 'MCX', lastBarAt: now, lastChainAt: stale }),
        u({ name: 'CRUDEOILM', exchange: 'MCX', lastBarAt: now, lastChainAt: null, optionable: false }),
      ],
    });
    expect(kinds(s)).toEqual(['NO_CHAIN:GOLD']);
  });

  it('is quiet at 29 min', () => {
    const s = snap(now, { underlyings: [u({ name: 'BANKNIFTY', exchange: 'NFO', lastBarAt: now, lastChainAt: new Date(now.getTime() - 29 * MIN) })] });
    expect(kinds(s)).toEqual([]);
  });
});

describe('checkInputs — NEWS_SILENT', () => {
  it('raises NEWS_SILENT after 60 min in NSE hours', () => {
    const now = ist('2026-11-04T12:00:00');
    expect(kinds(snap(now, { lastNewsAt: new Date(now.getTime() - 61 * MIN) }))).toEqual(['NEWS_SILENT:NEWS']);
    expect(kinds(snap(now, { lastNewsAt: new Date(now.getTime() - 59 * MIN) }))).toEqual([]);
  });

  it('is quiet in the MCX evening (news is judged in market hours only)', () => {
    const now = ist('2026-11-04T19:00:00');
    expect(kinds(snap(now, { lastNewsAt: ist('2026-11-04T14:00:00') }))).toEqual([]);
  });
});

describe('checkInputs — ENGINE_NEWS_EMPTY', () => {
  const now = ist('2026-11-04T13:00:00');
  const base = [u({ name: 'BANKNIFTY', exchange: 'NFO', lastBarAt: now, lastChainAt: now }), u({ name: 'NIFTY', exchange: 'NFO', lastBarAt: now, lastChainAt: now })];

  it('raises when more than 80% of the session’s checks were NO_DATA (BANKNIFTY 25/25)', () => {
    const s = snap(now, { underlyings: base, engineNews: [{ underlying: 'BANKNIFTY', checks: 25, newsNoData: 25 }, { underlying: 'NIFTY', checks: 25, newsNoData: 20 }] });
    const p = checkInputs(s, SENTINEL_CLOCK);
    expect(p.map((x) => `${x.kind}:${x.underlying}`)).toEqual(['ENGINE_NEWS_EMPTY:BANKNIFTY']);
    expect(p[0].message).toContain('25/25');
  });

  it('waits for a minimum number of checks', () => {
    const s = snap(now, { underlyings: base, engineNews: [{ underlying: 'BANKNIFTY', checks: 3, newsNoData: 3 }] });
    expect(kinds(s)).toEqual([]);
  });
});

describe('checkInputs — sessions', () => {
  const dead = (now: Date): InputsSnapshot =>
    snap(now, {
      lastNewsAt: null,
      underlyings: [u({ name: 'NIFTY', exchange: 'NFO' }), u({ name: 'GOLD', exchange: 'MCX' })],
      engineNews: [{ underlying: 'NIFTY', checks: 20, newsNoData: 20 }, { underlying: 'GOLD', checks: 20, newsNoData: 20 }],
    });

  it('raises nothing before any session opens or on a weekend', () => {
    expect(kinds(dead(ist('2026-11-04T08:30:00')))).toEqual([]);
    expect(kinds(dead(ist('2026-11-07T12:00:00')))).toEqual([]); // Saturday
  });

  it('after the NSE close only MCX underlyings are judged', () => {
    const k = kinds(dead(ist('2026-11-04T18:00:00')));
    expect(k).toEqual(['NO_BARS:GOLD', 'NO_CHAIN:GOLD', 'ENGINE_NEWS_EMPTY:GOLD']);
  });

  it('on an NSE holiday (2026-11-10) NSE is quiet and MCX is judged only from its 17:00 evening open', () => {
    expect(kinds(dead(ist('2026-11-10T12:00:00')))).toEqual([]);
    expect(kinds(dead(ist('2026-11-10T17:05:00')))).toEqual(['ENGINE_NEWS_EMPTY:GOLD']);
    expect(kinds(dead(ist('2026-11-10T17:45:00')))).toEqual(['NO_BARS:GOLD', 'NO_CHAIN:GOLD', 'ENGINE_NEWS_EMPTY:GOLD']);
  });

  it('after the MCX close nothing is judged', () => {
    expect(kinds(dead(ist('2026-11-04T23:58:00')))).toEqual([]);
  });
});
