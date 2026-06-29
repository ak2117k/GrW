import { Test } from '@nestjs/testing';
import { WatchMonitorService } from './watch-monitor.service';
import { WatchService } from './watch.service';
import { WatchRepository } from '../repositories/watch.repository';
import { ChartinkScoringService } from '../../chartink/services/chartink-scoring.service';
import { RiskGuardService } from './risk-guard.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';

describe('WatchMonitorService', () => {
  let svc: WatchMonitorService;
  let repo: any;
  let scoring: any;
  let watch: any;
  let riskGuard: any;
  let feed: any;

  beforeEach(async () => {
    repo = {
      findAllActive: jest.fn(),
      createEvent: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    };
    scoring = { score: jest.fn() };
    watch = {
      transitionStopped: jest.fn(),
      transitionLossCut: jest.fn(),
      computeOpenPnl: jest.fn(),
    };
    riskGuard = { checkAndTrip: jest.fn().mockResolvedValue(false) };
    feed = { getQuote: jest.fn(), subscribeForWatch: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        WatchMonitorService,
        { provide: WatchRepository, useValue: repo },
        { provide: ChartinkScoringService, useValue: scoring },
        { provide: WatchService, useValue: watch },
        { provide: RiskGuardService, useValue: riskGuard },
        { provide: MarketFeedService, useValue: feed },
      ],
    }).compile();
    svc = mod.get(WatchMonitorService);
  });

  /** A createdAt safely outside the 10-min grace window (created 30 min ago). */
  const wellPastGrace = () => new Date(Date.now() - 30 * 60_000);
  /** A createdAt inside the 10-min grace window (created 2 min ago). */
  const insideGrace = () => new Date(Date.now() - 2 * 60_000);

  it('writes SCORE_CHANGE event when score changes', async () => {
    scoring.score.mockResolvedValue({
      score: 75, lotCount: 2,
      checks: [{ name: 'sector', passed: true, points: 10, detail: 'ok' }],
    });
    await svc.rescoreOne({
      id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
      initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
      createdAt: wellPastGrace(),
    } as any);
    expect(repo.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'SCORE_CHANGE', score: 75, scoreDelta: 3,
    }));
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      currentScore: 75, lastRescoreAt: expect.any(Date),
    }));
  });

  it('persists currentBreakdown wrapped as { checks } on a successful rescore', async () => {
    // Must match initialBreakdown's shape ({ checks: [...] }) — the watch
    // table reads breakdown.checks, so a bare array makes every factor cell
    // render the neutral dot instead of ✓/✗.
    const checks = [{ name: 'sector', passed: true, points: 10, detail: 'ok' }];
    scoring.score.mockResolvedValue({ score: 75, lotCount: 2, checks });
    await svc.rescoreOne({
      id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
      initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
      createdAt: wellPastGrace(),
    } as any);
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      currentScore: 75, currentBreakdown: { checks },
    }));
  });

  it('does NOT write event when score unchanged', async () => {
    scoring.score.mockResolvedValue({
      score: 72, lotCount: 2,
      checks: [{ name: 'sector', passed: true, points: 10, detail: 'ok' }],
    });
    await svc.rescoreOne({
      id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
      initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
      createdAt: wellPastGrace(),
    } as any);
    expect(repo.createEvent).not.toHaveBeenCalled();
  });

  it('triggers transitionStopped when score < stopLossScore (outside grace window)', async () => {
    scoring.score.mockResolvedValue({
      score: 45, lotCount: 1,
      checks: [{ name: 'sector', passed: true, points: 10, detail: 'ok' }],
    });
    await svc.rescoreOne({
      id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
      initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
      createdAt: wellPastGrace(),
    } as any);
    expect(watch.transitionStopped).toHaveBeenCalledWith('w1', 45, 'score-decay');
  });

  it('writes notes="rescore-throttled" when scoring throws rate-limit error', async () => {
    scoring.score.mockRejectedValue(new Error('rate-limit'));
    await svc.rescoreOne({
      id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
      initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
      createdAt: wellPastGrace(),
    } as any);
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      notes: expect.stringContaining('rescore-throttled'),
    }));
  });

  // ─── Task 4: 10-minute grace period ───────────────────────────────────────

  describe('score-decay grace period (first 10 minutes)', () => {
    it('does NOT trigger transitionStopped within 10 min of creation, even if score < stopLossScore', async () => {
      scoring.score.mockResolvedValue({
        score: 30, lotCount: 0,
        checks: [{ name: 'sector', passed: false, points: 0, detail: 'weak' }],
      });
      await svc.rescoreOne({
        id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
        initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
        createdAt: insideGrace(),
      } as any);
      expect(watch.transitionStopped).not.toHaveBeenCalled();
    });

    it('still updates currentScore during the grace window', async () => {
      scoring.score.mockResolvedValue({
        score: 30, lotCount: 0,
        checks: [{ name: 'sector', passed: false, points: 0, detail: 'weak' }],
      });
      await svc.rescoreOne({
        id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
        initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
        createdAt: insideGrace(),
      } as any);
      expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
        currentScore: 30, lastRescoreAt: expect.any(Date),
      }));
    });

    it('uses initialAt when createdAt is absent for the grace check', async () => {
      scoring.score.mockResolvedValue({
        score: 30, lotCount: 0,
        checks: [{ name: 'sector', passed: false, points: 0, detail: 'weak' }],
      });
      await svc.rescoreOne({
        id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
        initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
        initialAt: insideGrace(),
      } as any);
      expect(watch.transitionStopped).not.toHaveBeenCalled();
    });
  });

  // ─── Task 5: skip data-starved re-scores ──────────────────────────────────

  describe('data-starved re-score skip', () => {
    it('SKIPS the re-score entirely when result.dataStarved is true', async () => {
      scoring.score.mockResolvedValue({
        score: 20, lotCount: 0, dataStarved: true,
        checks: [{ name: 'sector', passed: false, points: 0, detail: 'no data' }],
      });
      await svc.rescoreOne({
        id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
        initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
        createdAt: wellPastGrace(),
      } as any);
      // Entry left untouched: no currentScore write, no stop.
      expect(repo.update).not.toHaveBeenCalledWith('w1', expect.objectContaining({
        currentScore: expect.anything(),
      }));
      expect(watch.transitionStopped).not.toHaveBeenCalled();
    });

    it('does NOT touch currentBreakdown on a data-starved rescore', async () => {
      scoring.score.mockResolvedValue({
        score: 20, lotCount: 0, dataStarved: true,
        checks: [{ name: 'sector', passed: false, points: 0, detail: 'no data' }],
      });
      await svc.rescoreOne({
        id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
        initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
        createdAt: wellPastGrace(),
      } as any);
      expect(repo.update).not.toHaveBeenCalledWith('w1', expect.objectContaining({
        currentBreakdown: expect.anything(),
      }));
    });

    it('NEVER stops an entry on a data-starved score (even outside grace, score < stop)', async () => {
      scoring.score.mockResolvedValue({
        score: 10, lotCount: 0, dataStarved: true,
        checks: [],
      });
      await svc.rescoreOne({
        id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
        initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
        createdAt: wellPastGrace(),
      } as any);
      expect(watch.transitionStopped).not.toHaveBeenCalled();
    });

    it('processes the re-score normally when dataStarved is false', async () => {
      scoring.score.mockResolvedValue({
        score: 80, lotCount: 3, dataStarved: false,
        checks: [{ name: 'sector', passed: true, points: 10, detail: 'ok' }],
      });
      await svc.rescoreOne({
        id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
        initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
        createdAt: wellPastGrace(),
      } as any);
      expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
        currentScore: 80,
      }));
    });
  });

  // ─── Open-loss safety net: feed-independent loss-cut ──────────────────────

  describe('open-loss safety net', () => {
    function tradedEntry(overrides: Record<string, any> = {}) {
      return {
        id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
        status: 'TRADED', initialPrice: 2000, executedPrice: 2000,
        currentPrice: 2000, currentScore: 70, stopLossScore: 50,
        createdAt: wellPastGrace(),
        ...overrides,
      };
    }

    it('loss-cuts a deeply underwater TRADED entry from the 60s loop, independent of the tick path', async () => {
      // Defense-in-depth: the per-tick loss-cut lives in applyTick; if that
      // path is wedged, the rescore loop must still catch the loss using a
      // feed-cache price that does not depend on the watch tick handler.
      jest.spyOn(svc as any, 'isMarketHours').mockReturnValue(true);
      repo.findAllActive.mockResolvedValue([tradedEntry()]);
      feed.getQuote.mockReturnValue({ ltp: 1980 }); // big adverse move
      watch.computeOpenPnl.mockReturnValue(-1500);  // loss past the ₹1,000 cut

      await svc.tickAll();

      expect(watch.transitionLossCut).toHaveBeenCalledWith('w1', 1980, -1500);
    });

    it('does NOT loss-cut when the open loss is within the ₹1,000 threshold', async () => {
      jest.spyOn(svc as any, 'isMarketHours').mockReturnValue(true);
      repo.findAllActive.mockResolvedValue([tradedEntry()]);
      feed.getQuote.mockReturnValue({ ltp: 1999 });
      watch.computeOpenPnl.mockReturnValue(-100); // small loss, within the cut
      scoring.score.mockResolvedValue({ score: 70, lotCount: 1, checks: [] });

      await svc.tickAll();

      expect(watch.transitionLossCut).not.toHaveBeenCalled();
    });

    it('does NOT loss-cut a still-WATCHING entry (no position to cut)', async () => {
      jest.spyOn(svc as any, 'isMarketHours').mockReturnValue(true);
      repo.findAllActive.mockResolvedValue([tradedEntry({ status: 'WATCHING' })]);
      feed.getQuote.mockReturnValue({ ltp: 1980 });
      watch.computeOpenPnl.mockReturnValue(-1500);
      scoring.score.mockResolvedValue({ score: 70, lotCount: 1, checks: [] });

      await svc.tickAll();

      expect(watch.transitionLossCut).not.toHaveBeenCalled();
    });
  });

  // ─── Feed re-subscription: self-heal after an API restart ─────────────────

  describe('feed re-subscription', () => {
    it('re-subscribes every active entry to the live feed each tick', async () => {
      // Feed subscriptions are in-memory and wiped on an API restart; nothing
      // else repopulates them, so open positions go dark (frozen ltp, +0
      // unrealized P&L). The rescore loop must idempotently re-subscribe.
      jest.spyOn(svc as any, 'isMarketHours').mockReturnValue(true);
      // tickAll paces entries apart by 60s/N; stub the sleep so two entries
      // don't block the test on real wall-clock time.
      jest.spyOn(svc as any, 'sleep').mockResolvedValue(undefined);
      repo.findAllActive.mockResolvedValue([
        { id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
          status: 'TRADED', executedPrice: 4000, currentPrice: 4000, currentScore: 70,
          stopLossScore: 50, createdAt: wellPastGrace(), optionsToken: null },
        { id: 'w2', symbol: 'INFY-EQ', token: '1594', exchange: 'NSE', side: 'BUY',
          status: 'WATCHING', initialPrice: 1500, currentScore: 65,
          stopLossScore: 50, createdAt: wellPastGrace(), optionsToken: null },
      ]);
      feed.getQuote.mockReturnValue(null);
      watch.computeOpenPnl.mockReturnValue(0);
      scoring.score.mockResolvedValue({ score: 70, lotCount: 1, checks: [] });

      await svc.tickAll();

      expect(feed.subscribeForWatch).toHaveBeenCalledWith('11536', 'w1');
      expect(feed.subscribeForWatch).toHaveBeenCalledWith('1594', 'w2');
    });
  });
});
