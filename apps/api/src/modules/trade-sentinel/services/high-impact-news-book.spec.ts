import { HIGH_IMPACT_FRESH_MS, HighImpactNewsBook, mergeImpactNews } from './high-impact-news-book';
import { NewsWakeService } from './news-wake.service';
import { NewsWatchBook } from './news-watch-book';
import { parseNewsEventsConfig } from '../../news-events/config';
import { fakeNewsIndex } from '../../news-events/testing';
import { repeatIsMaterial, parseRejudgeConfig, type RejudgeSnapshot } from './rejudge-suppression';
import { newsHit } from '../tripwires/news-hit.tripwire';
import type { NewsImpactHighEvent } from '../../news-impact/news-impact.ports';

const NOW = Date.UTC(2026, 9, 23, 5, 30);
const evt = (o: Partial<NewsImpactHighEvent> = {}): NewsImpactHighEvent => ({
  clusterId: 'c1', impactId: 'i1', headline: 'TCS cuts FY27 guidance', direction: 'BEAR', magnitude: 'HIGH', horizon: 'INTRADAY',
  oneLine: 'Guidance cut; IT pressure.', targets: ['TCS'], analysedAt: new Date(NOW).toISOString(), ...o,
});

describe('HighImpactNewsBook', () => {
  it('a HIGH impact is one fresh headline per target for 30 min, re-adding the same cluster does not duplicate', () => {
    const b = new HighImpactNewsBook();
    b.add(evt(), NOW);
    b.add(evt(), NOW + 1000);
    expect(b.freshFor('tcs', NOW + 2000)).toEqual([{ id: 'impact:c1', title: expect.stringContaining('news impact HIGH BEAR') }]);
    expect(b.freshFor('INFY', NOW)).toEqual([]);
    expect(b.freshFor('TCS', NOW + 1000 + HIGH_IMPACT_FRESH_MS)).toEqual([]);
  });

  it('merges into v2 fresh ids, or legacy ids + count', () => {
    const imp = [{ id: 'impact:c1', title: 'x' }];
    expect(mergeImpactNews(imp, [{ id: 'a', title: 'a' }], { count: 1, items: null })).toEqual({ freshNews: [imp[0], { id: 'a', title: 'a' }], count: 2, items: null });
    expect(mergeImpactNews(imp, undefined, { count: 1, items: [{ id: 'a', title: 'a' }] })).toEqual({ freshNews: null, count: 2, items: [imp[0], { id: 'a', title: 'a' }] });
    expect(mergeImpactNews([], undefined, { count: 0, items: null })).toEqual({ freshNews: null, count: 0, items: null });
  });

  it('material-change gating: the impact headline is new once, then a repeat is not material', () => {
    const cfg = parseRejudgeConfig({});
    const snap = (unjudged: number, at: number): RejudgeSnapshot => ({ at, ltp: 100, qty: 1, peak: null, pullback: null, excursion: null, volumeRatio: null, noiseN: null, newsUnjudged: unjudged });
    expect(repeatIsMaterial('news-hit', snap(0, NOW), snap(1, NOW + 60_000), cfg)).toBe(true);
    expect(repeatIsMaterial('news-hit', snap(0, NOW), snap(0, NOW + 60_000), cfg)).toBe(false);
    expect(newsHit.check({ newsUnseen: [{ id: 'impact:c1', title: 'HIGH' }] } as never)?.name).toBe('news-hit');
  });
});

describe('NewsWakeService — high-impact wake dedup', () => {
  const prev = process.env.BOOT_JOBS;
  afterEach(() => {
    if (prev === undefined) delete process.env.BOOT_JOBS;
    else process.env.BOOT_JOBS = prev;
  });

  function harness(mode: string) {
    const watch = new NewsWatchBook();
    watch.upsert({ trackerId: 't1', userId: 'u1', symbol: 'TCS28OCT263500PE', exchange: 'NFO', instrumentKeys: ['I:TCS'] });
    watch.upsert({ trackerId: 't2', userId: 'u2', symbol: 'NIFTY28OCT2625000CE', exchange: 'NFO', instrumentKeys: ['X:NIFTY'] });
    const runner = { wakeForTick: jest.fn() };
    const impacts = new HighImpactNewsBook();
    const svc = new NewsWakeService(watch, runner as never, fakeNewsIndex(() => ({ status: 'warming', reason: 'x' })) as never, parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: mode }), undefined, impacts);
    jest.spyOn((svc as unknown as { logger: { log: (m: string) => void } }).logger, 'log').mockImplementation(() => undefined);
    svc.start(true);
    return { svc, runner, impacts };
  }

  it('wakes each matching tracker once per cluster (stock and index keys)', () => {
    const { svc, runner, impacts } = harness('true');
    svc.onHighImpact(evt({ targets: ['TCS', 'NIFTY'] }), NOW);
    svc.onHighImpact(evt({ targets: ['TCS', 'NIFTY'] }), NOW + 60 * 60_000);
    expect(runner.wakeForTick).toHaveBeenCalledTimes(2);
    expect(runner.wakeForTick).toHaveBeenCalledWith('u1', expect.stringContaining('news impact HIGH BEAR'), 'NFO');
    expect(impacts.freshFor('TCS', NOW)).toHaveLength(1);
  });

  it('a different cluster wakes again; observe mode only logs; the book is fed even when the push wake is off', () => {
    const t = harness('true');
    t.svc.onHighImpact(evt(), NOW);
    t.svc.onHighImpact(evt({ clusterId: 'c2' }), NOW + 60 * 60_000);
    expect(t.runner.wakeForTick).toHaveBeenCalledTimes(2);
    const o = harness('observe');
    o.svc.onHighImpact(evt(), NOW);
    expect(o.runner.wakeForTick).not.toHaveBeenCalled();
    const off = harness('false');
    off.svc.onHighImpact(evt(), NOW);
    expect(off.runner.wakeForTick).not.toHaveBeenCalled();
    expect(off.impacts.freshFor('TCS', NOW)).toHaveLength(1);
  });
});
