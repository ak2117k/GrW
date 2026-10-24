import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import type { NightReportStore } from '../repositories/night-report.repository';
import { NightReportService, type MoodSource } from './night-report.service';

const NOW = new Date('2026-10-24T02:30:00Z'); // Sat 08:00 IST
const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });
const mood: MoodSource = { behaviour: async () => ({ status: 'absent' }) };
const base = (extra: Record<string, unknown>) =>
  new Proxy(extra, {
    get: (t, k) =>
      k in t
        ? (t as Record<string | symbol, unknown>)[k]
        : k === 'dailyCandles'
          ? async () => ({ newest: null, countAtDay: 0 })
          : k === 'then'
            ? undefined
            : async () => (k === 'cashTokens' ? new Map() : k.toString().startsWith('newest') || k === 'lastOvernightReviewAt' ? null : []),
  }) as unknown as NightReportStore;

describe('NightReportService — Telegram channel views', () => {
  it('lists the day\'s INFO items (channel, underlying, bias, levels, condition) and the weighted lean, since min(last close, 24 h ago)', async () => {
    const channelInfosBetween = jest.fn(async () => ({
      rows: [
        {
          channelId: 'c1', channelTitle: 'Stock Wale Bhaiyaa Learning Group', postedAt: new Date('2026-10-23T10:00:00Z'),
          items: [
            { underlying: 'CRUDEOIL', bias: 'BULL', levels: [110, 120], targetLevel: 110, oi: null, condition: null, horizon: null },
            { underlying: 'NIFTY', bias: 'BEAR', levels: [21000], targetLevel: 21000, oi: null, condition: { driver: 'CRUDE', direction: 'UP' }, horizon: null },
          ],
        },
      ],
      accuracy: null,
    }));
    const r = await new NightReportService(base({ channelInfosBetween }), mood, { clock, hold: [] }).build('u1', NOW);
    const [from, to] = channelInfosBetween.mock.calls[0] as unknown as [Date, Date];
    expect(to).toEqual(NOW);
    expect(from.getTime()).toBeLessThanOrEqual(NOW.getTime() - 86_400_000);
    expect(r.channelViews).toMatchObject({
      items: [
        { channel: 'Stock Wale Bhaiyaa Learning Group', underlying: 'CRUDEOIL', bias: 'BULL', levels: [110, 120] },
        { channel: 'Stock Wale Bhaiyaa Learning Group', underlying: 'NIFTY', bias: 'BEAR', condition: { driver: 'CRUDE', direction: 'UP' } },
      ],
      sentiment: [expect.objectContaining({ underlying: 'CRUDEOIL', lean: 'BULL' }), expect.objectContaining({ underlying: 'NIFTY', lean: 'BEAR' })],
    });
  });

  it('fails soft into { error }; null when the store cannot read channel_infos', async () => {
    const failing = base({
      channelInfosBetween: async () => {
        throw new Error('relation "channel_infos" does not exist');
      },
    });
    expect((await new NightReportService(failing, mood, { clock, hold: [] }).build('u1', NOW)).channelViews).toEqual({ error: 'relation "channel_infos" does not exist' });
    const none = base({ channelInfosBetween: undefined });
    expect((await new NightReportService(none, mood, { clock, hold: [] }).build('u1', NOW)).channelViews).toBeNull();
  });
});
