import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import type { NewsIndexReader } from '../../trade-sentinel/ports/news-index.port';
import { DELTA_POLL_MS, MAX_PER_KEY, NEWS_EVENTS_CONFIG, STALE_AFTER_MS, type NewsEventsConfig } from '../config';
import { NEWS_INGEST_BUS, type NewsIngestBus } from '../ingest-bus';
import { toIndexedArticle } from '../keys';
import { SectorMapService } from '../sector-map.service';
import { SourceHealthBook } from '../source-health';
import type { IndexedArticle, NewsPeek, NewsPosition } from '../types';
import { freshInstrument, ladderFor, layeredHeadlines } from './ladder';
import { NewsIndex } from './news-index';

const ROW_SELECT = {
  id: true, title: true, source: true, sentiment: true, publishedAt: true, fetchedAt: true, dateInferred: true,
  instruments: true, sectors: true, indices: true, markets: true,
} as const;

/** Delta-poll page size. A full page is followed by the next one on the next poll (the cursor never skips). */
const POLL_PAGE = 500;

const CANNOT_SEE = 'headlines exist that this process cannot see yet; this is NOT a finding that nothing was published';

/** The delta poll's position: the last row read, ordered by (fetchedAt, id). */
interface Cursor { at: Date; id: string }

const after = (r: { fetchedAt: Date; id: string }, c: Cursor) =>
  r.fetchedAt.getTime() > c.at.getTime() || (r.fetchedAt.getTime() === c.at.getTime() && r.id > c.id);

/**
 * Spec §3/§6: the news index. Rebuilt from the DB on boot (emitting nothing),
 * kept current by the in-process bus (push) and a 60-s delta poll on a
 * `(fetchedAt, id) > cursor` (a split worker process). `peek` is synchronous and
 * does no I/O; `onAdded` fires only for ids the index has never held (R4) — an id
 * seen once is remembered for the index horizon even after it is evicted.
 */
@Injectable()
export class NewsIndexService implements NewsIndexReader, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NewsIndexService.name);
  private readonly index: NewsIndex;
  private readonly horizonMs: number;
  private state: 'off' | 'warming' | 'ready' | 'failed' = 'off';
  private failReason = '';
  private cursor: Cursor = { at: new Date(0), id: '' };
  /** Every id ever held or present at the boot rebuild → its publishedAt (pruned at the horizon). */
  private readonly seen = new Map<string, number>();
  private readonly listeners = new Set<(items: readonly IndexedArticle[]) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsub: (() => void) | null = null;
  private starting: Promise<void> | null = null;
  private polling = false;
  clock: Pick<SessionClock, 'isOpen'> = new SessionClock({ holidays: MARKET_HOLIDAYS });
  now: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig,
    @Inject(NEWS_INGEST_BUS) private readonly bus: NewsIngestBus,
    private readonly health: SourceHealthBook,
    private readonly sectors: SectorMapService,
  ) {
    this.horizonMs = cfg.indexHours * 3_600_000;
    this.index = new NewsIndex({ horizonMs: this.horizonMs, maxItems: cfg.indexMaxItems, maxPerKey: MAX_PER_KEY });
  }

  onApplicationBootstrap(): void {
    if (!this.cfg.computing) return;
    if (!bootJobsEnabled()) {
      this.logger.log(`[news-index] ${BOOT_JOBS_DISABLED}`);
      return;
    }
    void this.start();
  }

  /** Subscribe to the bus, schedule the delta poll and run the boot rebuild. Idempotent. */
  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.state = 'warming';
    this.unsub = this.bus.subscribe((items) => this.ingest(items));
    this.timer = setInterval(() => void this.poll(), DELTA_POLL_MS);
    this.timer.unref?.();
    this.starting = this.rebuild();
    return this.starting;
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsub?.();
    this.unsub = null;
  }

  onAdded(listener: (items: readonly IndexedArticle[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Load the last `indexHours` from the DB. Emits NOTHING: a restart must not wake on old news. */
  async rebuild(): Promise<void> {
    const t0 = this.now();
    const horizon = new Date(t0 - this.horizonMs);
    try {
      const rows = await this.prisma.newsArticle.findMany({
        where: { publishedAt: { gte: horizon } }, orderBy: { publishedAt: 'asc' }, select: ROW_SELECT,
      });
      let cursor: Cursor = { at: horizon, id: '' };
      for (const r of rows) {
        const a = toIndexedArticle(r);
        this.index.upsert(a, t0); // NOT ingest(): a rebuild emits nothing
        this.seen.set(a.id, a.publishedAt);
        if (after(r, cursor)) cursor = { at: r.fetchedAt, id: r.id };
      }
      if (after({ fetchedAt: cursor.at, id: cursor.id }, this.cursor)) this.cursor = cursor;
      this.state = 'ready';
      this.logger.log(`[news-index] ready: ${this.index.size} items, ${this.index.keyCount} keys, built in ${this.now() - t0}ms`);
    } catch (err) {
      this.state = 'failed';
      this.failReason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[news-index] rebuild failed (retrying on the next poll): ${this.failReason}`);
    }
  }

  /** The 60-s delta poll (rows a split worker process inserted); retries a failed rebuild first. */
  async poll(): Promise<void> {
    if (this.polling || this.state === 'off') return;
    this.polling = true;
    try {
      if (this.state !== 'ready') {
        await this.rebuild();
        return;
      }
      const c = this.cursor;
      const rows = await this.prisma.newsArticle.findMany({
        where: { OR: [{ fetchedAt: { gt: c.at } }, { fetchedAt: c.at, id: { gt: c.id } }] },
        orderBy: [{ fetchedAt: 'asc' }, { id: 'asc' }],
        take: POLL_PAGE,
        select: ROW_SELECT,
      });
      for (const r of rows) if (after(r, this.cursor)) this.cursor = { at: r.fetchedAt, id: r.id };
      this.ingest(rows.map(toIndexedArticle));
      const now = this.now();
      this.index.prune(now);
      for (const [id, publishedAt] of this.seen) if (publishedAt < now - this.horizonMs) this.seen.delete(id);
    } catch (err) {
      this.logger.warn(`[news-index] delta poll failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.polling = false;
    }
  }

  /** Push path (bus) and the delta poll. `onAdded` gets only ids never held before. */
  ingest(items: readonly IndexedArticle[]): void {
    const now = this.now();
    const added: IndexedArticle[] = [];
    for (const a of items) {
      const r = this.index.upsert(a, now);
      if (r === 'ignored') continue;
      if (r === 'added' && !this.seen.has(a.id)) added.push(a);
      this.seen.set(a.id, a.publishedAt);
    }
    if (added.length === 0) return;
    for (const fn of [...this.listeners]) {
      try {
        fn(added);
      } catch (err) {
        this.logger.error(`[news-index] onAdded listener threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Synchronous, in-memory only: never awaits, never touches the DB or the network. */
  peek(p: NewsPosition, nowDate: Date): NewsPeek {
    if (this.state === 'off') {
      return { status: 'unavailable', reason: 'the news index is not running in this process (NEWS_EVENTS_V2_ENABLED is false)' };
    }
    if (this.state === 'warming') return { status: 'warming', reason: `the news index is still loading after a restart — ${CANNOT_SEE}` };
    if (this.state === 'failed') return { status: 'unavailable', reason: `the news index could not be loaded (${this.failReason}) — ${CANNOT_SEE}` };
    const now = nowDate.getTime();
    const rungs = ladderFor(p, this.sectors);
    const { headlines, newestAt } = layeredHeadlines(this.index, rungs, now);
    const { count, fresh } = freshInstrument(this.index, rungs, now);
    const newestFetched = this.index.newestFetchedAt();
    const lastIngestAt = this.health.lastOkAt() ?? (newestFetched === null ? null : new Date(newestFetched).toISOString());
    const open = this.clock.isOpen(p.exchange, nowDate);
    const stale = open && (lastIngestAt === null || now - Date.parse(lastIngestAt) > STALE_AFTER_MS);
    return { status: 'ok', headlines, newestAt, freshCount: count, fresh, asOf: { lastIngestAt, downSources: this.health.down(), stale } };
  }
}
