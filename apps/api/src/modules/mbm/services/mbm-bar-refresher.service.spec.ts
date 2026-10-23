import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import { parseMbmConfig } from '../mbm.config';
import { MbmBarRefresherService } from './mbm-bar-refresher.service';

const cal = new SessionClock({ holidays: MARKET_HOLIDAYS });
const bar = (iso: string) => ({ timestamp: new Date(iso), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });

function build(
  nowIso: string,
  env: NodeJS.ProcessEnv = { MBM_ENABLED: 'observe', MBM_FEED_USER_ID: 'owner' },
  clock: () => Date = () => new Date(nowIso),
) {
  const feeds = { fetchCandleWindow: jest.fn() };
  const bars = { lastTs: jest.fn().mockResolvedValue(null), upsert: jest.fn(async (_s: string, b: unknown[]) => b.length) };
  const svc = new MbmBarRefresherService(parseMbmConfig(env), cal, clock, feeds as never, bars as never);
  const pauses: number[] = [];
  (svc as unknown as { pause: (ms: number) => Promise<void> }).pause = async (ms) => {
    pauses.push(ms);
  };
  return { svc, feeds, bars, pauses };
}

describe('MbmBarRefresherService', () => {
  it('a tick fetches ONE_MINUTE from today’s open for every series, serially, and upserts complete bars', async () => {
    const { svc, feeds, bars } = build('2026-10-19T04:00:20Z'); // 09:30:20 IST
    feeds.fetchCandleWindow.mockResolvedValue([bar('2026-10-19T03:58:00Z'), bar('2026-10-19T03:59:00Z'), bar('2026-10-19T04:00:00Z')]);
    const r = await svc.onTick();
    expect(r).toEqual({ ran: true, stored: 22, failed: [], skipped: [] }); // 11 series × 2 complete bars
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
    expect(r).toEqual({ ran: true, stored: 10, failed: ['INDIAVIX'], skipped: [] });
  });

  it('retries throttled series after a pause, so one rejected burst does not stale the prediction', async () => {
    const { svc, feeds, pauses } = build('2026-10-19T04:00:20Z');
    let niftyCalls = 0;
    feeds.fetchCandleWindow.mockImplementation(async (_u: string, ref: { token: string }) => {
      if (ref.token === '99926000' && ++niftyCalls === 1) throw new Error('throttled: data:null');
      return [bar('2026-10-19T03:58:00Z')];
    });
    const r = await svc.onTick();
    expect(r).toEqual({ ran: true, stored: 11, failed: [], skipped: [] });
    expect(niftyCalls).toBe(2);
    expect(pauses).toEqual([3000]);
  });

  it('fetches NIFTY and INDIAVIX first and finishes their retries before any other series', async () => {
    const { svc, feeds, pauses } = build('2026-10-19T04:00:20Z');
    const order: string[] = [];
    let niftyCalls = 0;
    feeds.fetchCandleWindow.mockImplementation(async (_u: string, ref: { token: string }) => {
      order.push(ref.token);
      if (ref.token === '99926000' && ++niftyCalls < 3) throw new Error('throttled: data:null');
      return [bar('2026-10-19T03:58:00Z')];
    });
    const r = await svc.onTick();
    expect(r.failed).toEqual([]);
    // NIFTY, INDIAVIX, NIFTY retry 1, NIFTY retry 2 — then BANKNIFTY and the EQ_* heavyweights.
    expect(order.slice(0, 5)).toEqual(['99926000', '99926017', '99926000', '99926000', '99926009']);
    expect(pauses).toEqual([3000, 6000]);
  });

  it('skips the low-priority series once a tick runs past its budget instead of delaying the next tick', async () => {
    let t = Date.parse('2026-10-19T04:00:20Z');
    const { svc, feeds } = build('2026-10-19T04:00:20Z', undefined, () => new Date(t));
    feeds.fetchCandleWindow.mockImplementation(async (_u: string, ref: { token: string }) => {
      if (ref.token === '2885') t += 4 * 60_000; // EQ_RELIANCE hangs for 4 minutes
      return [bar('2026-10-19T03:58:00Z')];
    });
    const r = await svc.onTick();
    expect(r.failed).toEqual([]);
    expect(r.skipped).toEqual(['EQ_HDFCBANK', 'EQ_ICICIBANK', 'EQ_INFY', 'EQ_TCS', 'EQ_BHARTIARTL', 'EQ_LT', 'EQ_ITC']);
    expect(r.stored).toBe(4); // NIFTY, INDIAVIX, BANKNIFTY, EQ_RELIANCE
  });

  it('does not retry a throttled low-priority series past the budget (skipped, not failed)', async () => {
    let t = Date.parse('2026-10-19T04:00:20Z');
    const { svc, feeds, pauses } = build('2026-10-19T04:00:20Z', undefined, () => new Date(t));
    feeds.fetchCandleWindow.mockImplementation(async (_u: string, ref: { token: string }) => {
      if (ref.token === '1660') {
        t += 4 * 60_000; // EQ_ITC, the last series, is throttled after a long wait
        throw new Error('throttled: data:null');
      }
      return [bar('2026-10-19T03:58:00Z')];
    });
    const r = await svc.onTick();
    expect(r).toEqual({ ran: true, stored: 10, failed: [], skipped: ['EQ_ITC'] });
    expect(pauses).toEqual([]);
  });

  it('boot catch-up has no budget', async () => {
    let t = Date.parse('2026-10-21T04:30:00Z');
    const { svc, feeds } = build('2026-10-21T04:30:00Z', undefined, () => new Date(t));
    feeds.fetchCandleWindow.mockImplementation(async () => {
      t += 60_000;
      return [];
    });
    const r = await svc.catchUp();
    expect(r.skipped).toEqual([]);
    expect(feeds.fetchCandleWindow).toHaveBeenCalledTimes(11);
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
