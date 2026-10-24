import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { NEWS_IMPACT_HIGH_EVENT, type NewsImpactHighEvent } from '../../news-impact/news-impact.ports';
import { HighImpactNewsBook } from './high-impact-news-book';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { FRESH_WINDOW_MS, NEWS_EVENTS_CONFIG, type NewsEventsConfig } from '../../news-events/config';
import { keysOfTags } from '../../news-events/keys';
import type { IndexedArticle } from '../../news-events/types';
import { NEWS_INDEX, type NewsIndexReader } from '../ports/news-index.port';
import { NewsWatchBook } from './news-watch-book';
import { SENTINEL_ENABLED_KEY, SentinelRunnerService } from './sentinel-runner.service';

/** Per-tracker cap on remembered article ids (oldest dropped first). */
const SEEN_CAP = 500;

/**
 * Spec §9 (push, not poll). A NEW article (index `onAdded`) whose instrument-layer
 * key matches an open watched position runs that user's ordinary sensor pass now
 * (`wakeForTick` — session gate, in-flight guard and every cap apply there); the
 * pass's edge-triggered news-hit produces the fire. Once per (tracker, article);
 * at most one wake per tracker per NEWS_WAKE_COOLDOWN_MIN. Sector/market headlines
 * never wake (N6). `observe` logs the wake it would have made.
 * It never places, modifies or cancels anything — it can only ask for a look.
 */
@Injectable()
export class NewsWakeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NewsWakeService.name);
  private off: (() => void) | null = null;
  private readonly lastWake = new Map<string, number>();
  private readonly seen = new Map<string, Set<string>>();

  constructor(
    private readonly book: NewsWatchBook,
    private readonly runner: SentinelRunnerService,
    @Optional() @Inject(NEWS_INDEX) private readonly index?: NewsIndexReader,
    @Optional() @Inject(NEWS_EVENTS_CONFIG) private readonly cfg?: NewsEventsConfig,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly impactBook?: HighImpactNewsBook,
  ) {}

  onModuleInit(): void {
    this.start(this.config?.get<string>(SENTINEL_ENABLED_KEY) === 'true');
  }

  /** Subscribe to the index's additions. False (and nothing subscribed) unless computing, wired, shadow on and boot jobs on. */
  start(shadow: boolean): boolean {
    if (!this.cfg?.computing || !this.index || !shadow || !bootJobsEnabled()) return false;
    this.off = this.index.onAdded((items) => this.onAdded(items, Date.now()));
    this.logger.log(
      `[news-wake] ${this.cfg.mode}: own-instrument headlines ${this.cfg.rendering ? 'wake' : 'would wake'} the judge (cooldown ${this.cfg.wakeCooldownMin}m)`,
    );
    return true;
  }

  /**
   * News impact (2026-10-24): a HIGH impact on a held symbol / NIFTY / BANKNIFTY. Always lands in the
   * impact book (the tick source shows it to the news sensor as one fresh headline, id
   * `impact:<clusterId>`, so the cycle's seen-set and the material-change gating let it through
   * exactly once). When the push wake is running it also asks each matching tracker's owner for a
   * sensor pass now — once per (tracker, cluster), inside the usual cooldown. Never throws.
   */
  @OnEvent(NEWS_IMPACT_HIGH_EVENT)
  onHighImpact(evt: NewsImpactHighEvent, now: number = Date.now()): void {
    try {
      this.impactBook?.add(evt, now);
      const cfg = this.cfg;
      if (!this.off || !cfg?.computing) return;
      const id = `impact:${evt.clusterId}`;
      const keys = evt.targets.flatMap((t) => [`I:${t}`, `X:${t}`]);
      for (const w of this.book.matching(keys)) {
        const seen = this.seen.get(w.trackerId) ?? new Set<string>();
        this.seen.set(w.trackerId, seen);
        if (seen.has(id)) continue;
        seen.add(id);
        if (!cfg.rendering) {
          this.logger.log(`[news-wake] observe: would wake ${w.userId} for ${w.symbol} — HIGH impact "${evt.oneLine}"`);
          continue;
        }
        if (now - (this.lastWake.get(w.trackerId) ?? -Infinity) < cfg.wakeCooldownMin * 60_000) continue;
        this.lastWake.set(w.trackerId, now);
        this.runner.wakeForTick(w.userId, `news impact HIGH ${evt.direction} on ${w.symbol}: "${evt.oneLine}"`, w.exchange);
      }
    } catch (err) {
      this.logger.warn(`[news-wake] high-impact wake failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  onModuleDestroy(): void {
    this.off?.();
    this.off = null;
  }

  onAdded(items: readonly IndexedArticle[], now: number): void {
    const cfg = this.cfg;
    if (!cfg?.computing) return;
    for (const id of [...this.seen.keys()]) if (!this.book.has(id)) this.seen.delete(id);
    for (const a of items) {
      if (a.dateInferred || now - a.publishedAt > FRESH_WINDOW_MS) continue;
      // Exactly the keys an instrument rung can hold: I:<company|benchmark> and X:<index>.
      const keys = keysOfTags({ instruments: a.tags.instruments, sectors: [], indices: a.tags.indices, markets: [] });
      for (const w of this.book.matching(keys)) {
        const seen = this.seen.get(w.trackerId) ?? new Set<string>();
        this.seen.set(w.trackerId, seen);
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value as string);
        if (!cfg.rendering) {
          this.logger.log(`[news-wake] observe: would wake ${w.userId} for ${w.symbol} — "${a.title}"`);
          continue;
        }
        if (now - (this.lastWake.get(w.trackerId) ?? -Infinity) < cfg.wakeCooldownMin * 60_000) continue;
        this.lastWake.set(w.trackerId, now);
        try {
          this.runner.wakeForTick(w.userId, `news-hit on ${w.symbol}: "${a.title}"`, w.exchange);
        } catch (err) {
          // Called from the index's publisher: a failure here must never escape into ingestion.
          this.logger.warn(`[news-wake] wake for ${w.userId} (${w.symbol}) failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
}
