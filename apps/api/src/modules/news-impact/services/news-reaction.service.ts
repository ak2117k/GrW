import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { istYmd } from '../../market-cues/fetchers/ist-dates';
import { istMidnightOf } from '../../night-report/domain/night-report.logic';
import type { SessionClock } from '../../market-hub/session-clock';
import { atrOf, isComplete, mergePoints, pointsFrom, type SessionSpan } from '../domain/reaction';
import { NEWS_IMPACT_CONFIG, type NewsImpactConfig } from '../news-impact.config';
import { NewsImpactRepository, type StoredReaction } from '../news-impact.repository';
import { NEWS_IMPACT_CLOCK } from './news-impact.service';

/** A reaction still incomplete this long after its next session's close is closed as-is (missing points stay null). */
export const GIVE_UP_AFTER_MS = 24 * 3_600_000;
const LOOKBACK_MS = 7 * 86_400_000;

/** The NSE session span on `at`'s IST date, or null on a non-trading day. */
export function sessionSpanOf(clock: SessionClock, at: Date): SessionSpan | null {
  const w = clock.tradingWindow('NSE', at);
  if (!w) return null;
  const midnight = istMidnightOf(istYmd(at)).getTime();
  return { openAt: midnight + w.openMin * 60_000, closeAt: midnight + w.closeMin * 60_000 };
}

/**
 * Layer 4 (factor collection): every 15 min fill each incomplete reaction's p0 / +15 m / +60 m /
 * close / next close from 1m bars (NIFTY / BANKNIFTY / MBM equities from mbm_bars_1m, other stocks
 * from candles 1m) and its daily ATR. Missing bars stay null. Reads only.
 */
@Injectable()
export class NewsReactionService {
  private readonly logger = new Logger(NewsReactionService.name);
  private running = false;

  constructor(
    private readonly repo: NewsImpactRepository,
    @Inject(NEWS_IMPACT_CONFIG) private readonly cfg: NewsImpactConfig,
    @Inject(NEWS_IMPACT_CLOCK) private readonly clock: SessionClock,
  ) {}

  @Cron('0 7-59/15 * * * *', { name: 'news-impact-reactions', timeZone: 'Asia/Kolkata' })
  async onTick(): Promise<number> {
    if (!this.cfg.enabled || !bootJobsEnabled() || this.running) return 0;
    this.running = true;
    try {
      return await this.fill(new Date());
    } catch (e) {
      this.logger.warn(`[news-impact] reaction fill failed: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** Returns how many rows were updated. */
  async fill(now: Date): Promise<number> {
    const rows = await this.repo.incompleteReactions(new Date(now.getTime() - LOOKBACK_MS));
    let n = 0;
    for (const r of rows) {
      if (r.anchorAt.getTime() > now.getTime()) continue;
      try {
        if (await this.fillOne(r, now)) n++;
      } catch (e) {
        this.logger.debug(`[news-impact] reaction ${r.id} (${r.symbol}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return n;
  }

  async fillOne(r: StoredReaction, now: Date): Promise<boolean> {
    const session = sessionSpanOf(this.clock, r.anchorAt);
    if (!session) {
      await this.repo.updateReaction(r.id, { ...pick(r), complete: true }, now);
      return true;
    }
    const nextOpen = this.clock.nextOpen('NSE', new Date(session.closeAt));
    const next = nextOpen ? sessionSpanOf(this.clock, nextOpen) : null;
    const until = Math.min(now.getTime(), (next ?? session).closeAt);
    const bars = await this.repo.minuteBars(r.symbol, new Date(session.openAt), new Date(until));
    const found = pointsFrom(bars, r.anchorAt.getTime(), r.anchorIsOpen, session, next, now.getTime());
    const merged = mergePoints(pick(r), found);
    const atr = r.atr ?? atrOf(await this.repo.dailyBars(r.symbol, new Date(session.openAt)).catch(() => []));
    const giveUp = now.getTime() > (next ?? session).closeAt + GIVE_UP_AFTER_MS;
    const changed = JSON.stringify(merged) !== JSON.stringify(pick(r)) || atr !== r.atr || giveUp || isComplete(merged);
    if (!changed) return false;
    await this.repo.updateReaction(r.id, { ...merged, atr, complete: isComplete(merged) || giveUp }, now);
    return true;
  }
}

const pick = (r: StoredReaction) => ({ p0: r.p0, p15: r.p15, p60: r.p60, pClose: r.pClose, pNextClose: r.pNextClose });
