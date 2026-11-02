import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import type { PreOpenOutlookReport } from '../../pre-open-outlook/pre-open-outlook.ports';
import type { NightReportStore } from '../repositories/night-report.repository';
import { NightReportService, type MoodSource } from './night-report.service';

const NOW = new Date('2026-11-02T03:10:00Z');
const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });
const store = new Proxy({}, { get: (_t, k) => (k === 'dailyCandles' ? async () => ({ newest: null, countAtDay: 0 }) : async () => (k === 'cashTokens' ? new Map() : k.toString().startsWith('newest') || k === 'lastOvernightReviewAt' ? null : [])) }) as NightReportStore;
const mood: MoodSource = { behaviour: async () => ({ status: 'absent' }) };
const make = (src?: { forReport(now: Date): Promise<PreOpenOutlookReport> }) =>
  new NightReportService(store, mood, { clock, hold: [] }, undefined, undefined, undefined, undefined, undefined, src);

describe('NightReportService — preOpenOutlook section', () => {
  it('shows the pre-open outlook report; fails soft into { error }; null when the module is not loaded', async () => {
    const report: PreOpenOutlookReport = { source: 'stored', asOf: NOW.toISOString(), items: [{ underlying: 'CRUDEOIL', bias: 'BEARISH' } as never], note: 'n' };
    const forReport = jest.fn(async () => report);
    expect((await make({ forReport }).build('u1', NOW)).preOpenOutlook).toEqual(report);
    expect(forReport).toHaveBeenCalledWith(NOW);
    const failing = make({ forReport: async () => Promise.reject(new Error('relation "pre_open_outlooks" does not exist')) });
    expect((await failing.build('u1', NOW)).preOpenOutlook).toEqual({ error: 'relation "pre_open_outlooks" does not exist' });
    expect((await make().build('u1', NOW)).preOpenOutlook).toBeNull();
  });
});
