import { expiryEvent, horizonEnd, selectEvents } from './events-select';
import type { NewsPosition, StoredMarketEvent } from '../types';

const clock = {
  // 2026-10-16 is a Friday; 2026-10-20 is made an NSE holiday for the test.
  isTradingDay: (ex: string, at: Date) => {
    const ymd = new Date(at.getTime() + 19_800_000).toISOString().slice(0, 10);
    const wd = new Date(`${ymd}T00:00:00Z`).getUTCDay();
    return wd !== 0 && wd !== 6 && !(ex !== 'MCX' && ymd === '2026-10-20');
  },
  tradingWindow: (ex: string) => (ex === 'MCX' ? { openMin: 540, closeMin: 1410 } : { openMin: 555, closeMin: 930 }),
};
const NOW = new Date('2026-10-16T04:00:00Z'); // 09:30 IST Fri
const ev = (o: Partial<StoredMarketEvent>): StoredMarketEvent => ({
  id: o.id ?? `${o.kind}:${o.key}`, scope: 'market', kind: 'fomc', key: 'US', title: 'x', startsAt: new Date('2026-10-16T10:00:00Z'),
  allDay: false, impact: 'high', source: 's', sourceRef: null, fetchedAt: new Date('2026-10-16T02:45:00Z'), ...o,
});
const INFY: NewsPosition = { kind: 'STOCK', underlying: 'INFY', key: 'INFY', exchange: 'NSE', expiry: null };
const CRUDE: NewsPosition = { kind: 'COMMODITY', underlying: 'CRUDEOILM', key: 'CRUDEOIL', exchange: 'MCX', expiry: '2026-10-19' };
const opts = { horizonTradingDays: 3, clock, scheduleEndsAt: '2027-03-31', sourceNotes: [], fetchedAt: '2026-10-16T02:45:00.000Z' };

it('horizon = end of the 3rd trading day, skipping weekends and holidays (Fri, Mon, Wed)', () => {
  expect(new Date(horizonEnd('NSE', NOW, 3, clock)).toISOString()).toBe('2026-10-21T18:29:59.999Z');
  expect(new Date(horizonEnd('MCX', NOW, 3, clock)).toISOString()).toBe('2026-10-20T18:29:59.999Z');
});

it('relevance: own company, IN only for Indian venues, US for all, commodity by benchmark; past timed events dropped', () => {
  const all = [
    ev({ id: 'res', scope: 'company', kind: 'results', key: 'INFY', allDay: true, startsAt: new Date('2026-10-16T03:45:00Z') }),
    ev({ id: 'other', scope: 'company', kind: 'results', key: 'TCS', allDay: true, startsAt: new Date('2026-10-16T03:45:00Z') }),
    ev({ id: 'rbi', kind: 'rbi_mpc', key: 'IN', startsAt: new Date('2026-10-19T04:30:00Z') }),
    ev({ id: 'fomc', kind: 'fomc', key: 'US', startsAt: new Date('2026-10-21T18:00:00Z') }),
    ev({ id: 'eia', scope: 'commodity', kind: 'eia_petroleum', key: 'CRUDEOIL', startsAt: new Date('2026-10-16T14:30:00Z') }),
    ev({ id: 'past', kind: 'us_cpi', key: 'US', startsAt: new Date('2026-10-16T03:59:00Z') }),
    ev({ id: 'far', kind: 'us_cpi', key: 'US', startsAt: new Date('2026-10-23T12:30:00Z') }),
  ];
  const a = selectEvents(all, INFY, NOW, opts);
  expect(a.status === 'ok' && a.events.map((e) => e.id)).toEqual(['res', 'rbi', 'fomc']);
  const c = selectEvents(all, CRUDE, NOW, opts);
  expect(c.status === 'ok' && c.events.map((e) => e.id)).toEqual(['eia', 'expiry:CRUDEOIL:2026-10-19']);
});

it('minutesAway, IST labels, all-day "today" = 0, and minutesToNextHighImpact over TIMED events only', () => {
  const all = [
    ev({ id: 'res', scope: 'company', kind: 'results', key: 'INFY', title: 'INFY results', allDay: true, startsAt: new Date('2026-10-16T03:45:00Z') }),
    ev({ id: 'now', kind: 'us_cpi', key: 'US', title: 'US CPI', startsAt: NOW }),
    ev({ id: 'nfp', kind: 'us_nfp', key: 'US', impact: 'medium', startsAt: new Date('2026-10-16T05:00:00Z') }),
  ];
  const p = selectEvents(all, INFY, NOW, opts);
  if (p.status !== 'ok') throw new Error('expected ok');
  expect(p.events.map((e) => [e.id, e.minutesAway, e.atIst])).toEqual([
    ['res', 0, '2026-10-16 (time not announced)'],
    ['now', 0, '2026-10-16 09:30 IST'],
    ['nfp', 60, '2026-10-16 10:30 IST'],
  ]);
  expect(p.minutesToNextHighImpact).toBe(0);
});

it('no timed high-impact event: null with a reason naming an all-day one', () => {
  const p = selectEvents([ev({ id: 'res', scope: 'company', kind: 'results', key: 'INFY', title: 'INFY results', allDay: true, startsAt: new Date('2026-10-19T03:45:00Z') })], INFY, NOW, opts);
  expect(p.status === 'ok' && [p.minutesToNextHighImpact, p.noHighImpactReason]).toEqual([
    null, 'no timed high-impact event in the next 3 trading days; INFY results on 2026-10-19 (time not announced)',
  ]);
});

it('≤ 5 events; notes carry an expiring macro schedule and down sources', () => {
  const many = Array.from({ length: 9 }, (_, i) => ev({ id: `e${i}`, kind: 'us_cpi', startsAt: new Date(NOW.getTime() + (i + 1) * 3_600_000) }));
  const p = selectEvents(many, INFY, NOW, { ...opts, scheduleEndsAt: '2026-11-01', sourceNotes: ['NSE event calendar unavailable'] });
  expect(p.status === 'ok' && p.events).toHaveLength(5);
  expect(p.status === 'ok' && p.notes).toEqual(['macro schedule ends 2026-11-01', 'NSE event calendar unavailable']);
});

it('expiry event at the venue close (MCX 23:30 IST)', () => {
  expect(expiryEvent(CRUDE, clock)).toMatchObject({ kind: 'expiry', scope: 'expiry', impact: 'high', startsAt: new Date('2026-10-19T18:00:00.000Z') });
  expect(expiryEvent(INFY, clock)).toBeNull();
});
