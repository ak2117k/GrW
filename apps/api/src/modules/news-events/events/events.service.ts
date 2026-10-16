import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import type { EventsReader } from '../../trade-sentinel/ports/events.port';
import { NEWS_EVENTS_CONFIG, type NewsEventsConfig } from '../config';
import { SourceHealthBook } from '../source-health';
import type { EventsPeek, NewsPosition, StoredMarketEvent } from '../types';
import { EventsBuilderService } from './events-builder.service';
import { selectEvents } from './events-select';
import { MarketEventsRepository } from './market-events.repository';

const EVENT_SOURCES = ['NSE event calendar', 'NSE corporate actions', 'market-events.json'];
const CANNOT_SEE = 'scheduled events exist that this process cannot see yet; this is NOT a finding that nothing is scheduled';

/** Spec §8: daily 08:15 IST build + every 2 h; in-memory cache; `peek` synchronous, no I/O. */
@Injectable()
export class EventsService implements EventsReader, OnApplicationBootstrap {
  private readonly logger = new Logger(EventsService.name);
  private all: StoredMarketEvent[] = [];
  private state: 'off' | 'warming' | 'ready' = 'off';
  private fetchedAt: string | null = null;
  private building: Promise<void> | null = null;
  private yahooTimer: ReturnType<typeof setTimeout> | null = null;
  readonly wanted = new Set<string>();
  clock = new SessionClock({ holidays: MARKET_HOLIDAYS });

  constructor(
    @Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig,
    private readonly repo: MarketEventsRepository,
    private readonly builder: EventsBuilderService,
    private readonly health: SourceHealthBook,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.cfg.computing || !bootJobsEnabled()) return;
    this.markWarming();
    void this.reload(new Date()).then(() => this.refresh(new Date()));
  }

  markWarming(): void {
    this.state = 'warming';
  }

  @Cron('0 15 8 * * *', { timeZone: 'Asia/Kolkata' })
  async daily(): Promise<void> {
    if (this.cfg.computing) await this.refresh(new Date());
  }

  @Cron('0 15 10-22/2 * * *', { timeZone: 'Asia/Kolkata' })
  async every2h(): Promise<void> {
    if (this.cfg.computing) await this.refresh(new Date());
  }

  refresh(now: Date): Promise<void> {
    if (this.building) return this.building;
    this.building = (async () => {
      try {
        await this.builder.build(now, [...this.wanted]);
        await this.reload(now);
      } catch (err) {
        this.logger.warn(`[market-events] refresh failed, serving the stored events: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.building = null;
      }
    })();
    return this.building;
  }

  async reload(now: Date): Promise<void> {
    this.all = await this.repo.listFrom(new Date(now.getTime() - 86_400_000));
    this.fetchedAt = this.all.reduce<string | null>((m, e) => {
      const t = e.fetchedAt.toISOString();
      return m === null || t > m ? t : m;
    }, null);
    if (this.state !== 'off' || this.cfg.computing) this.state = 'ready';
  }

  peek(p: NewsPosition, now: Date): EventsPeek {
    if (!this.cfg.computing) return { status: 'unavailable', reason: 'the events calendar is not running in this process (NEWS_EVENTS_V2_ENABLED is false)' };
    if (this.state !== 'ready') return { status: 'warming', reason: `the events calendar is still loading after a restart — ${CANNOT_SEE}` };
    if (p.kind === 'STOCK' && !this.wanted.has(p.key)) {
      this.wanted.add(p.key);
      this.scheduleYahoo();
    }
    const sourceNotes = this.health.all()
      .filter((h) => EVENT_SOURCES.includes(h.source) && h.consecutiveFailures > 0)
      .map((h) => `${h.source} unavailable since ${h.lastOkAt ?? 'boot'} — showing the events stored before`);
    return selectEvents(this.all, p, now, {
      horizonTradingDays: this.cfg.eventsHorizonTradingDays, clock: this.clock, scheduleEndsAt: this.builder.scheduleEnds,
      sourceNotes, fetchedAt: this.fetchedAt,
    });
  }

  /** A newly held stock gets its Yahoo estimate within a minute, off the hot path. */
  private scheduleYahoo(): void {
    if (this.yahooTimer) return;
    this.yahooTimer = setTimeout(() => {
      this.yahooTimer = null;
      void this.refresh(new Date());
    }, 60_000);
    this.yahooTimer.unref?.();
  }
}
