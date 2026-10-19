import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import { parseMbmConfig } from '../mbm.config';
import { MbmBarRefresherService } from './mbm-bar-refresher.service';

const cal = new SessionClock({ holidays: MARKET_HOLIDAYS });
const bar = (iso: string) => ({ timestamp: new Date(iso), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });

function build(nowIso: string, env: NodeJS.ProcessEnv = { MBM_ENABLED: 'observe', MBM_FEED_USER_ID: 'owner' }) {
  const feeds = { fetchCandleWindow: jest.fn() };
  const bars = { lastTs: jest.fn().mockResolvedValue(null), upsert: jest.fn(async (_s: string, b: unknown[]) => b.length) };
  const svc = new MbmBarRefresherService(parseMbmConfig(env), cal, () => new Date(nowIso), feeds as never, bars as never);
  return { svc, feeds, bars };
}

describe('MbmBarRefresherService', () => {
  it('a tick fetches ONE_MINUTE from today’s open for every series, serially, and upserts complete bars', async () => {
    const { svc, feeds, bars } = build('2026-10-19T04:00:20Z'); // 09:30:20 IST
    feeds.fetchCandleWindow.mockResolvedValue([bar('2026-10-19T03:58:00Z'), bar('2026-10-19T03:59:00Z'), bar('2026-10-19T04:00:00Z')]);
    const r = await svc.onTick();
    expect(r).toEqual({ ran: true, stored: 22, failed: [] }); // 11 series × 2 complete bars
    expect(feeds.fetchCandleWindow).toHaveBeenCalledTimes(11);
    expect(feeds.fetchCandleWindow).toHaveBeenCalledWith(
      'owner',
      { token: '99926000', exchange: 'NSE' },
      'ONE_MINUTE',
      new Date('2026-10-19T03:45:00Z'),
      new Date('2026-10-19T04:00:20Z'),
    );
    expect(bars.upsert).toHaveBeenCalledWith('NIFTY', [expect.objectContaining({ close: 1.5 }), expect.anything()]);
  });

  it('resumes each series from its last stored bar', async () => {
    const { svc, feeds, bars } = build('2026-10-19T04:00:20Z');
    bars.lastTs.mockResolvedValue(new Date('2026-10-19T03:55:00Z'));
    feeds.fetchCandleWindow.mockResolvedValue([]);
    await svc.onTick();
    expect(feeds.fetchCandleWindow.mock.calls[0][3]).toEqual(new Date('2026-10-19T03:55:00Z'));
  });

  it('is a no-op on a holiday, a weekend, outside the window and when off', async () => {
    for (const iso of ['2026-10-20T05:00:20Z', '2026-10-18T05:00:20Z', '2026-10-19T11:00:20Z']) {
      const { svc, feeds } = build(iso);
      expect((await svc.onTick()).ran).toBe(false);
      expect(feeds.fetchCandleWindow).not.toHaveBeenCalled();
    }
    const off = build('2026-10-19T05:00:20Z', { MBM_FEED_USER_ID: 'owner' });
    expect((await off.svc.onTick()).ran).toBe(false);
    expect((await off.svc.catchUp()).ran).toBe(false);
    const noUser = build('2026-10-19T05:00:20Z', { MBM_ENABLED: 'observe' });
    expect((await noUser.svc.onTick()).ran).toBe(false);
  });

  it('isolates a failing series: logged, the rest still stored, never throws', async () => {
    const { svc, feeds } = build('2026-10-19T04:00:20Z');
    feeds.fetchCandleWindow.mockImplementation(async (_u: string, ref: { token: string }) => {
      if (ref.token === '99926017') throw new Error('AB1004 throttled');
      return [bar('2026-10-19T03:58:00Z')];
    });
    const r = await svc.onTick();
    expect(r).toEqual({ ran: true, stored: 10, failed: ['INDIAVIX'] });
  });

  it('boot catch-up starts at the open three sessions back (holiday skipped)', async () => {
    const { svc, feeds } = build('2026-10-21T04:30:00Z'); // Wed; Tue 20 is Dussehra
    feeds.fetchCandleWindow.mockResolvedValue([]);
    const r = await svc.catchUp();
    expect(r.ran).toBe(true);
    expect(feeds.fetchCandleWindow.mock.calls[0][3]).toEqual(new Date('2026-10-16T03:45:00Z'));
  });

  it('does not overlap a pass that is still running', async () => {
    const { svc, feeds } = build('2026-10-19T04:00:20Z');
    let release!: () => void;
    feeds.fetchCandleWindow.mockImplementationOnce(() => new Promise((r) => (release = () => r([])))).mockResolvedValue([]);
    const first = svc.onTick();
    await new Promise((r) => setImmediate(r));
    expect((await svc.onTick()).ran).toBe(false);
    release();
    expect((await first).ran).toBe(true);
  });
});
