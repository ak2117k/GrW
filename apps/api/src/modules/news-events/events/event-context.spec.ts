import type { StoredMarketEvent } from '../types';
import { eventAffects, eventContextFor } from './event-context';

const row = (o: Partial<StoredMarketEvent> & Pick<StoredMarketEvent, 'kind' | 'startsAt'>): StoredMarketEvent => ({
  id: `${o.kind}-${o.startsAt.toISOString()}`, scope: 'market', key: 'US', title: o.kind, allDay: false, impact: 'high',
  source: 'config/market-events.json', sourceRef: null, fetchedAt: new Date('2026-11-01T00:00:00Z'), ...o,
});

// A built calendar always holds the forward macro schedule; this far-off row keeps it "non-empty".
const FAR = row({ kind: 'rbi_mpc', key: 'IN', startsAt: new Date('2027-02-05T04:30:00Z') });
const repoOf = (rows: StoredMarketEvent[]) => ({ listFrom: jest.fn(async () => rows) });
const OFF = { MARKET_EVENT_DAYS: 'off' };

describe('eventContextFor', () => {
  it('2026-11-04 GOLD → US_MIDTERM_RESULTS, expectMove true (MARKET_EVENT_DAYS code default)', async () => {
    const at = new Date('2026-11-04T05:31:00Z'); // 11:01 IST, the GOLD CE call
    const ctx = await eventContextFor('GOLD', at, { repo: repoOf([FAR]), env: {} });
    expect(ctx.status).toBe('present');
    if (ctx.status !== 'present') return;
    const ev = ctx.events.find((e) => e.name === 'US_MIDTERM_RESULTS');
    expect(ev).toEqual(expect.objectContaining({ impact: 'high', expectMove: true }));
    expect(ev!.affects).toEqual(expect.arrayContaining(['GOLD', 'SILVER', 'CRUDEOIL', 'NIFTY', 'BANKNIFTY', 'SENSEX']));
  });

  it('a stored us_election row and the configured day both show for GOLDM (gold family)', async () => {
    const election = row({ kind: 'us_election', title: 'US midterm election results', startsAt: new Date('2026-11-04T00:00:00Z') });
    const ctx = await eventContextFor('GOLDM', new Date('2026-11-04T05:31:00Z'), { repo: repoOf([election, FAR]), env: {} });
    expect(ctx.status === 'present' && ctx.events.map((e) => e.name)).toEqual(['US midterm election results', 'US_MIDTERM_RESULTS']);
  });

  it('FOMC date → GOLD and NIFTY affected; the window reaches the next session’s first 2 h', async () => {
    // FOMC 2026-12-09 14:00 New York = 19:00Z = 00:30 IST 10 Dec.
    const fomc = row({ kind: 'fomc', title: 'FOMC rate decision', startsAt: new Date('2026-12-09T19:00:00Z') });
    const deps = { repo: repoOf([fomc, FAR]), env: OFF };
    for (const u of ['GOLD', 'NIFTY']) {
      const ctx = await eventContextFor(u, new Date('2026-12-10T04:00:00Z'), deps); // 09:30 IST 10 Dec
      expect(ctx).toEqual({ status: 'present', events: [expect.objectContaining({ name: 'FOMC rate decision', expectMove: true, at: '2026-12-10 00:30 IST' })] });
    }
    // 10 Dec is a Thursday: the window ends 11 Dec 11:15 IST.
    const inside = await eventContextFor('NIFTY', new Date('2026-12-11T05:40:00Z'), deps); // 11:10 IST Fri
    expect(inside.status === 'present' && inside.events).toHaveLength(1);
    const after = await eventContextFor('NIFTY', new Date('2026-12-11T05:50:00Z'), deps); // 11:20 IST Fri
    expect(after).toEqual({ status: 'present', events: [] });
    // The morning before (IST 9 Dec) is not yet inside the event's IST session.
    const before = await eventContextFor('GOLD', new Date('2026-12-09T05:00:00Z'), deps);
    expect(before).toEqual({ status: 'present', events: [] });
  });

  it('a Friday event window runs through Monday’s first 2 h', async () => {
    const nfp = row({ kind: 'us_nfp', title: 'US non-farm payrolls', impact: 'medium', startsAt: new Date('2026-11-06T13:30:00Z') });
    const ctx = await eventContextFor('GOLD', new Date('2026-11-09T05:00:00Z'), { repo: repoOf([nfp, FAR]), env: OFF }); // Mon 10:30 IST
    expect(ctx).toEqual({ status: 'present', events: [expect.objectContaining({ name: 'US non-farm payrolls', impact: 'medium', expectMove: false })] });
  });

  it('RBI → indices only; OPEC → CRUDEOIL only', async () => {
    const rbi = row({ kind: 'rbi_mpc', key: 'IN', title: 'RBI monetary policy decision', startsAt: new Date('2026-12-04T04:30:00Z') });
    const opec = row({ kind: 'opec', key: 'CRUDEOIL', scope: 'commodity', title: 'OPEC+ meeting', startsAt: new Date('2026-12-04T10:00:00Z') });
    const deps = { repo: repoOf([rbi, opec, FAR]), env: OFF };
    const at = new Date('2026-12-04T05:00:00Z');
    const names = async (u: string) => { const c = await eventContextFor(u, at, deps); return c.status === 'present' ? c.events.map((e) => e.name) : c.reason; };
    expect(await names('BANKNIFTY')).toEqual(['RBI monetary policy decision']);
    expect(await names('CRUDEOILM')).toEqual(['OPEC+ meeting']);
    expect(await names('GOLD')).toEqual([]);
  });

  it('repository throws → absent with reason (never "no event")', async () => {
    const repo = { listFrom: jest.fn(async () => { throw new Error('connection refused'); }) };
    const ctx = await eventContextFor('GOLD', new Date('2026-12-10T04:00:00Z'), { repo, env: OFF });
    expect(ctx.status).toBe('absent');
    if (ctx.status !== 'absent') return;
    expect(ctx.reason).toMatch(/connection refused/);
    expect(ctx.reason).toMatch(/NOT a finding that nothing is scheduled/);
  });

  it('repository throws on a configured event day → absent, and the reason names the configured event', async () => {
    const repo = { listFrom: jest.fn(async () => { throw new Error('timeout'); }) };
    const ctx = await eventContextFor('GOLD', new Date('2026-11-04T05:31:00Z'), { repo, env: {} });
    expect(ctx.status === 'absent' && ctx.reason).toMatch(/US_MIDTERM_RESULTS/);
  });

  it('an empty calendar (nothing stored at all) → absent, not "no events"', async () => {
    const ctx = await eventContextFor('GOLD', new Date('2026-12-10T04:00:00Z'), { repo: repoOf([]), env: OFF });
    expect(ctx.status).toBe('absent');
  });

  it('no events → present with []', async () => {
    const ctx = await eventContextFor('GOLD', new Date('2026-11-18T05:00:00Z'), { repo: repoOf([FAR]), env: OFF });
    expect(ctx).toEqual({ status: 'present', events: [] });
  });

  it('ignores non-macro stored rows (company results, expiry, EIA)', async () => {
    const tcs = row({ kind: 'results', scope: 'company', key: 'TCS', startsAt: new Date('2026-11-18T10:00:00Z') });
    const eia = row({ kind: 'eia_petroleum', scope: 'commodity', key: 'CRUDEOIL', startsAt: new Date('2026-11-18T15:30:00Z') });
    const ctx = await eventContextFor('CRUDEOIL', new Date('2026-11-18T05:00:00Z'), { repo: repoOf([tcs, eia, FAR]), env: OFF });
    expect(ctx).toEqual({ status: 'present', events: [] });
  });
});

describe('eventAffects', () => {
  it('maps configured MARKET_EVENT_DAYS names by prefix', () => {
    expect(eventAffects('US_MIDTERM_RESULTS')).toContain('GOLD');
    expect(eventAffects('RBI_POLICY')).toEqual(['NIFTY', 'BANKNIFTY', 'SENSEX']);
    expect(eventAffects('UNION_BUDGET')).toEqual(['NIFTY', 'BANKNIFTY', 'SENSEX']);
    expect(eventAffects('OPEC_MEETING')).toEqual(['CRUDEOIL']);
  });
});
