import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { parseNewsImpactConfig } from '../news-impact.config';
import type { StoredReaction } from '../news-impact.repository';
import { NewsReactionService } from './news-reaction.service';

const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });
const OPEN = Date.parse('2026-10-23T03:45:00Z'); // Fri 09:15 IST
const ANCHOR = new Date(OPEN + 60 * 60_000);

function row(o: Partial<StoredReaction> = {}): StoredReaction {
  return {
    id: 'r1', impactId: 'i1', clusterId: 'c1', symbol: 'NIFTY', kind: 'INDEX', direction: 'BULL', magnitude: 'HIGH', horizon: 'INTRADAY',
    anchorAt: ANCHOR, anchorIsOpen: false, judgeSession: '2026-10-23', atr: null, createdAt: ANCHOR,
    p0: null, p15: null, p60: null, pClose: null, pNextClose: null, ...o,
  };
}

function setup(bars: Array<{ t: number; open: number; close: number }>, r: StoredReaction = row(), daily: Record<string, number> = {}) {
  const repo = {
    incompleteReactions: jest.fn(async () => [r]),
    dailyCloseOn: jest.fn(async (_s: string, day: Date) => daily[day.toISOString()] ?? null),
    minuteBars: jest.fn(async () => bars),
    dailyBars: jest.fn(async () => Array.from({ length: 10 }, () => ({ high: 25_200, low: 25_000, close: 25_100 }))),
    updateReaction: jest.fn(async () => undefined),
  };
  return { svc: new NewsReactionService(repo as never, parseNewsImpactConfig({}), clock), repo };
}

describe('NewsReactionService — filling reactions', () => {
  it('fills the points whose time has passed and the ATR; not complete before the next close', async () => {
    const bars = Array.from({ length: 375 }, (_, i) => ({ t: OPEN + i * 60_000, open: 25_000 + i, close: 25_001 + i }));
    const { svc, repo } = setup(bars);
    const now = new Date(ANCHOR.getTime() + 90 * 60_000);
    expect(await svc.fill(now)).toBe(1);
    expect(repo.updateReaction).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ p0: 25_061, p15: 25_076, p60: 25_121, pClose: null, pNextClose: null, atr: 200, complete: false }),
      now,
    );
  });

  it('missing bars stay null; given up (complete) a day after the next close', async () => {
    const { svc, repo } = setup([]);
    const late = new Date('2026-10-28T10:00:00Z');
    await svc.fill(late);
    expect(repo.updateReaction).toHaveBeenCalledWith('r1', expect.objectContaining({ p0: null, complete: true }), late);
  });

  it('a DAYS stock reaction without 1m bars takes its session closes from the daily candles', async () => {
    // Session 23 Oct (IST midnight 2026-10-22T18:30Z) and the next, Mon 26 Oct (2026-10-25T18:30Z).
    const r = row({ symbol: 'MARUTI', kind: 'STOCK', horizon: 'DAYS', judgeSession: '2026-10-26' });
    const { svc, repo } = setup([], r, { '2026-10-22T18:30:00.000Z': 16_000, '2026-10-25T18:30:00.000Z': 16_240 });
    const now = new Date('2026-10-26T11:00:00Z'); // after Monday's close
    await svc.fill(now);
    expect(repo.updateReaction).toHaveBeenCalledWith('r1', expect.objectContaining({ p0: null, pClose: 16_000, pNextClose: 16_240 }), now);
  });

  it('no daily fallback for INTRADAY or index rows, nor before the session closed', async () => {
    const { svc, repo } = setup([], row({ symbol: 'MARUTI', kind: 'STOCK', horizon: 'INTRADAY' }), { '2026-10-22T18:30:00.000Z': 16_000 });
    await svc.fill(new Date('2026-10-26T11:00:00Z'));
    expect(repo.dailyCloseOn).not.toHaveBeenCalled();
    const early = setup([], row({ symbol: 'MARUTI', kind: 'STOCK', horizon: 'DAYS' }), { '2026-10-22T18:30:00.000Z': 16_000 });
    await early.svc.fill(new Date(ANCHOR.getTime() + 60 * 60_000));
    expect(early.repo.dailyCloseOn).not.toHaveBeenCalled();
  });
});
