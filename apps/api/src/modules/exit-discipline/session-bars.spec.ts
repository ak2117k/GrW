import { BANKNIFTY_23NOV_1M, ist } from '../market-hub/testing/banknifty-2026-11-23-preopen';
import { inVenueSession, istMinuteOf, rollToSessionBuckets, sessionBucketStart, sessionOnlyBars, venueSession } from './session-bars';

const hhmm = (ts: number) => { const m = istMinuteOf(ts); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

describe('venueSession — the one source of truth', () => {
  it('NSE/NFO/BSE/BFO 09:15–15:30, MCX 09:00–23:55, unknown = null', () => {
    for (const ex of ['NSE', 'nfo', 'BSE', 'BFO']) expect(venueSession(ex)).toEqual({ fromMin: 555, toMin: 930 });
    expect(venueSession('MCX')).toEqual({ fromMin: 540, toMin: 1435 });
    expect(venueSession('CDS')).toBeNull();
    expect(venueSession(null)).toBeNull();
  });

  it('a bar must START inside the window', () => {
    expect(inVenueSession(ist('2026-11-23 09:14'), 'NSE')).toBe(false);
    expect(inVenueSession(ist('2026-11-23 09:15'), 'NSE')).toBe(true);
    expect(inVenueSession(ist('2026-11-23 15:29'), 'NSE')).toBe(true);
    expect(inVenueSession(ist('2026-11-23 15:30'), 'NSE')).toBe(false);
    expect(inVenueSession(ist('2026-11-23 09:00'), 'MCX')).toBe(true);
    expect(inVenueSession(ist('2026-11-23 03:00'), 'CDS')).toBe(true);
  });
});

describe('rollToSessionBuckets — 23-Nov BANKNIFTY pre-open', () => {
  it('drops 08:50–09:14 before bucketing; NSE 15m buckets start 09:15', () => {
    const b = rollToSessionBuckets(BANKNIFTY_23NOV_1M, 'NSE', 15);
    expect(b.map((x) => hhmm(x.ts))).toEqual(['09:15']);
    expect(b[0]).toMatchObject({ open: 65003.7, high: 65182.45, low: 63662.1, close: 63696.55 });
  });

  it('an unfiltered epoch rollup has the junk 09:00 bucket (the bug)', () => {
    const w = 15 * 60_000;
    const keys = [...new Set(BANKNIFTY_23NOV_1M.map((x) => Math.floor(x.ts / w) * w))].map(hhmm);
    expect(keys).toEqual(['08:45', '09:00', '09:15']);
  });

  it('5m buckets are session-aligned too', () => {
    expect(rollToSessionBuckets(BANKNIFTY_23NOV_1M, 'NSE', 5).map((x) => hhmm(x.ts))).toEqual(['09:15', '09:20', '09:25']);
  });

  it('MCX is unchanged: buckets from 09:00', () => {
    const mcx = [ist('2026-11-23 08:59'), ist('2026-11-23 09:00'), ist('2026-11-23 09:14'), ist('2026-11-23 09:15'), ist('2026-11-23 23:30')]
      .map((ts) => ({ ts, open: 100, high: 101, low: 99, close: 100 }));
    expect(rollToSessionBuckets(mcx, 'MCX', 15).map((x) => hhmm(x.ts))).toEqual(['09:00', '09:15', '23:30']);
    expect(sessionBucketStart(ist('2026-11-23 09:07'), 'MCX', 15)).toBe(ist('2026-11-23 09:00'));
    expect(sessionBucketStart(ist('2026-11-23 09:07'), 'NSE', 15)).toBeNull();
    expect(sessionBucketStart(ist('2026-11-23 09:29'), 'NSE', 15)).toBe(ist('2026-11-23 09:15'));
  });
});

describe('sessionOnlyBars — already-bucketed bars', () => {
  it('off-session flat bars (02:00, pre-open, post-close) are ignored; order kept', () => {
    const at = (t: string) => ({ ts: ist(`2026-11-20 ${t}`) });
    const bars = ['02:00', '08:45', '09:00', '09:15', '09:30', '15:15', '15:30', '15:45', '18:00'].map(at);
    expect(sessionOnlyBars(bars, 'NSE', 15).map((b) => hhmm(b.ts))).toEqual(['09:15', '09:30', '15:15']);
    expect(sessionOnlyBars(bars, 'MCX', 15).map((b) => hhmm(b.ts))).toEqual(['09:00', '09:15', '09:30', '15:15', '15:30', '15:45', '18:00']);
    expect(sessionOnlyBars(bars, 'CDS', 15)).toHaveLength(bars.length);
  });

  it('a bucket off the session grid (an epoch-aligned 1h 09:00–10:00 on NSE) is dropped', () => {
    const bars = ['09:00', '09:15', '10:15'].map((t) => ({ ts: ist(`2026-11-20 ${t}`) }));
    expect(sessionOnlyBars(bars, 'NSE', 60).map((b) => hhmm(b.ts))).toEqual(['09:15', '10:15']);
    expect(sessionOnlyBars([{ ts: ist('2026-11-20 09:20') }], 'NSE', 15)).toEqual([]);
  });
});
