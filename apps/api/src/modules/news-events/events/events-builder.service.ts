import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { istYmd } from '../../market-cues/fetchers/ist-dates';
import { FundamentalsService } from '../../fundamentals/fundamentals.service';
import { NEWS_EVENTS_CONFIG, type NewsEventsConfig } from '../config';
import { NseClient } from '../nse-client';
import { SourceHealthBook } from '../source-health';
import type { MarketEventInput } from '../types';
import { MarketEventsRepository } from './market-events.repository';
import { loadMarketEventsFile, macroEvents, scheduleEndsAt, type MarketEventsFile } from './macro-schedule';
import { NSE_EVENT_CALENDAR_URL, nseCorporateActionsUrl, parseCorporateActions, parseEventCalendar, yahooEarningsEvent } from './nse-events';
import { eiaEvents } from './rule-events';
import { ymdInTz } from './zoned-time';

const DAY = 86_400_000;
const ddmmyyyy = (ymd: string) => `${ymd.slice(8, 10)}-${ymd.slice(5, 7)}-${ymd.slice(0, 4)}`;
export interface BuildReport { synced: string[]; failed: string[] }

/** Spec §8: builds market_events from every source; each source independent; a failure keeps that source's stored rows. */
@Injectable()
export class EventsBuilderService {
  private readonly logger = new Logger(EventsBuilderService.name);
  scheduleEnds: string | null = null;
  loadFile: () => MarketEventsFile = () => loadMarketEventsFile();

  constructor(
    @Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig,
    private readonly nse: NseClient,
    private readonly repo: MarketEventsRepository,
    private readonly health: SourceHealthBook,
    @Optional() private readonly fundamentals?: FundamentalsService,
  ) {}

  async build(now: Date, wantedSymbols: readonly string[]): Promise<BuildReport> {
    const report: BuildReport = { synced: [], failed: [] };
    const sync = async (source: string, from: Date, to: Date, rows: MarketEventInput[]) => {
      await this.repo.syncSource(source, from, to, rows, now);
      report.synced.push(source);
    };
    let holidays: string[] = [];
    let overrides: MarketEventsFile['eiaOverrides'] = [];
    try {
      const file = this.loadFile();
      holidays = file.usFederalHolidays;
      overrides = file.eiaOverrides;
      this.scheduleEnds = scheduleEndsAt(file);
      await sync('config/market-events.json', new Date(now.getTime() - DAY), new Date(now.getTime() + 400 * DAY), macroEvents(file));
      this.health.ok('market-events.json', file.macro.length, now);
      if (this.scheduleEnds && Date.parse(this.scheduleEnds) - now.getTime() < 30 * DAY) {
        this.logger.warn(`[market-events] macro schedule ends ${this.scheduleEnds} — extend config/market-events.json`);
      }
    } catch (err) {
      this.health.fail('market-events.json', msg(err), now);
      report.failed.push('config/market-events.json');
    }
    await sync('rule:eia', new Date(now.getTime() - DAY), new Date(now.getTime() + 15 * DAY), eiaEvents(ymdInTz(now.getTime(), 'America/New_York'), 14, holidays, overrides));

    const today = istYmd(now);
    const company = new Set<string>();
    for (const [source, label, url, parse, days] of [
      ['NSE event calendar', 'NSE event-calendar', NSE_EVENT_CALENDAR_URL, parseEventCalendar, 60],
      ['NSE corporate actions', 'NSE corporate-actions', nseCorporateActionsUrl(ddmmyyyy(today), ddmmyyyy(istYmd(new Date(now.getTime() + 14 * DAY)))), parseCorporateActions, 14],
    ] as const) {
      try {
        const rows = parse(await this.nse.getJson(label, url));
        await sync(source, new Date(now.getTime() - DAY), new Date(now.getTime() + days * DAY), rows);
        for (const r of rows) if (r.kind === 'results' || r.kind === 'board_meeting') company.add(r.key);
        this.health.ok(source, rows.length, now);
      } catch (err) {
        this.health.fail(source, msg(err), now);
        report.failed.push(source);
      }
    }

    const need = wantedSymbols.filter((sym) => !company.has(sym.toUpperCase()));
    if (this.fundamentals && need.length > 0) {
      const rows: MarketEventInput[] = [];
      for (const sym of need) {
        try {
          const e = yahooEarningsEvent(sym, (await this.fundamentals.get(sym, 'NSE')).nextEarningsDate);
          if (e) rows.push(e);
        } catch (err) {
          this.logger.debug(`[market-events] yahoo earnings for ${sym} failed: ${msg(err)}`);
        }
      }
      await sync('yahoo (estimate)', new Date(now.getTime() - DAY), new Date(now.getTime() + 120 * DAY), rows);
    }
    this.logger.log(`[market-events] built: ${report.synced.join(', ')}${report.failed.length ? `; FAILED: ${report.failed.join(', ')}` : ''}`);
    return report;
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
