import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SessionClock } from '../../market-hub/session-clock';
import { baseSymbol } from '../../news-events/keys';
import {
  DAY_MS,
  distinctArticles,
  freshness,
  istMidnightOf,
  istYmd,
  isHeld,
  lastSessionDates,
  nightWindow,
  pickVerdicts,
  planInForce,
  splitNews,
  symbolRef,
  tagRef,
  underlyingName,
  underlyingRef,
  type HeldKey,
  type VerdictRow,
} from '../domain/night-report.logic';
import type {
  EventItem,
  JobItem,
  MoodView,
  NewsSection,
  NightReport,
  NightSummary,
  NightWindow,
  PositionRow,
  Section,
  SetupItem,
} from '../domain/night-report.types';
import { NIGHT_REPORT_STORE, type NightReportStore } from '../repositories/night-report.repository';

/** The part of MbmClient the report uses (fail-open by contract: every failure is `absent`). */
export interface MoodSource {
  behaviour(instrument: string): Promise<{
    status: 'ok' | 'stale' | 'absent';
    asOf?: string | null;
    horizons?: Record<string, { p: number; regime: string; q25Bp: number | null; q75Bp: number | null }>;
  }>;
}

export interface NightReportOptions {
  clock: SessionClock;
  /** AI_AUTO_EXIT_HOLD, parsed as the executor parses it (upper-cased symbols / tracker ids). */
  hold: readonly string[];
}

export const NIGHT_REPORT_OPTIONS = Symbol('NIGHT_REPORT_OPTIONS');
export const NIGHT_REPORT_MOOD = Symbol('NIGHT_REPORT_MOOD');

/** At most this many articles are read for one window (a long holiday weekend). */
const NEWS_CAP = 600;
/** How far before the window opens to look for the latest LIVE verdict. */
const VERDICT_LOOKBACK_MS = 4 * DAY_MS;
/** News is fetched round the clock; older than this and the fetcher has stopped. */
const NEWS_STALE_MS = 3 * 60 * 60 * 1000;
/** MBM rows are written during the session; the newest should reach within this of the last close. */
const MBM_GRACE_MS = 30 * 60 * 1000;

const isError = (s: unknown): s is { error: string } =>
  !!s && typeof s === 'object' && !Array.isArray(s) && typeof (s as { error?: unknown }).error === 'string';

/**
 * One morning page: everything since the last NSE close, scoped to the caller.
 * Every section is computed independently and fails soft into `{ error }`, so a
 * broken table never blanks the report.
 */
@Injectable()
export class NightReportService {
  private readonly logger = new Logger(NightReportService.name);

  constructor(
    @Inject(NIGHT_REPORT_STORE) private readonly store: NightReportStore,
    @Inject(NIGHT_REPORT_MOOD) private readonly moodSource: MoodSource,
    @Inject(NIGHT_REPORT_OPTIONS) private readonly opts: NightReportOptions,
  ) {}

  async build(userId: string, now: Date = new Date()): Promise<NightReport> {
    const window = nightWindow(now, this.opts.clock);
    const from = new Date(window.from);

    const positions = await this.safe('positions', () => this.positions(userId, from));
    const held = isError(positions) ? [] : heldKeys(positions);

    const [news, events, dailySetups, mood, jobs] = await Promise.all([
      this.safe('news', () => this.news(from, now, held)),
      this.safe('events', () => this.events(now, window, held)),
      this.safe('dailySetups', () => this.dailySetups(now)),
      this.safe('mood', () => this.mood()),
      this.safe('jobs', () => this.jobs(userId, now, from)),
    ]);

    return {
      generatedAt: now.toISOString(),
      window,
      summary: summarise(now, positions, news, events),
      positions,
      news,
      events,
      dailySetups,
      mood,
      jobs,
    };
  }

  private async safe<T>(name: string, fn: () => Promise<T>): Promise<Section<T>> {
    try {
      return await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`[night-report] section ${name} failed: ${message}`);
      return { error: message || 'failed' };
    }
  }

  private async positions(userId: string, from: Date): Promise<PositionRow[]> {
    const trackers = await this.store.openTrackers(userId);
    if (trackers.length === 0) return [];

    const names = new Map(trackers.map((t) => [t.id, underlyingName(t.symbol, t.exchange)]));
    const cashNames = [
      ...new Set(
        trackers
          .filter((t) => t.exchange.toUpperCase() !== 'MCX')
          .map((t) => names.get(t.id))
          .filter((n): n is string => !!n),
      ),
    ];
    // A token lookup failure costs only the instant link; the web resolves the chip by search.
    const tokens = await this.store.cashTokens(cashNames).catch(() => new Map<string, string>());

    const rows = await this.store.verdictsSince(
      userId,
      trackers.map((t) => t.id),
      new Date(from.getTime() - VERDICT_LOOKBACK_MS),
    );
    const byTracker = new Map<string, VerdictRow[]>();
    for (const r of rows) byTracker.set(r.trackerId, [...(byTracker.get(r.trackerId) ?? []), r]);

    return trackers.map((t) => {
      const name = names.get(t.id) ?? null;
      return {
        trackerId: t.id,
        instrument: symbolRef(t.symbol, t.exchange, t.token || null),
        underlying: name ? underlyingRef(name, t.exchange, tokens.get(name) ?? null) : null,
        kind: t.kind,
        qty: t.qty,
        entryPrice: t.entryPrice,
        ltp: t.lastLtp,
        pnl: t.pnl,
        pnlPct: t.pnlPercent,
        held: isHeld(this.opts.hold, t),
        ...pickVerdicts(byTracker.get(t.id) ?? []),
      };
    });
  }

  private async news(from: Date, now: Date, held: HeldKey[]): Promise<NewsSection> {
    return splitNews(await this.store.newsPublishedBetween(from, now, NEWS_CAP), held);
  }

  /** Events from IST midnight today through the end of the next session's day. */
  private async events(now: Date, window: NightWindow, held: HeldKey[]): Promise<EventItem[]> {
    const from = istMidnightOf(istYmd(now));
    const lastDay = window.nextOpen ? istYmd(new Date(window.nextOpen)) : istYmd(now);
    const to = new Date(istMidnightOf(lastDay < istYmd(now) ? istYmd(now) : lastDay).getTime() + DAY_MS);
    const rows = await this.store.eventsBetween(from, to);
    return rows.map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      startsAt: e.startsAt.toISOString(),
      allDay: e.allDay,
      impact: e.impact ?? null,
      scope: e.scope ?? null,
      touchesPositions: held.filter((h) => h.label === baseSymbol(e.key)).map((h) => h.ref),
    }));
  }

  private async dailySetups(now: Date): Promise<SetupItem[]> {
    const sessions = lastSessionDates(now, this.opts.clock, 2);
    // signal_date is a DATE column: Prisma reads and writes it as UTC midnight.
    const rows = await this.store.dailySignalsOn(sessions.map((d) => new Date(`${d}T00:00:00.000Z`)));
    return rows.map((r) => ({
      instrument: tagRef(r.instrument),
      setup: r.setup,
      action: r.action,
      signalDate: r.signalDate.toISOString().slice(0, 10),
      close: r.close,
      ret5dBp: r.ret5dBp,
      ret10dBp: r.ret10dBp,
      ret20dBp: r.ret20dBp,
    }));
  }

  private async mood(): Promise<MoodView> {
    const b = await this.moodSource.behaviour('NIFTY');
    const horizons: MoodView['horizons'] = {};
    for (const [k, h] of Object.entries(b.horizons ?? {})) {
      horizons[k] = { p: h.p, regime: h.regime, q25Bp: h.q25Bp ?? null, q75Bp: h.q75Bp ?? null };
    }
    return { status: b.status, asOf: b.asOf ?? null, horizons };
  }

  private async jobs(userId: string, now: Date, from: Date): Promise<JobItem[]> {
    const lastDay = istYmd(from);
    const mbmSince = new Date(from.getTime() - MBM_GRACE_MS);
    const item = async (
      name: string,
      read: () => Promise<{ status: JobItem['status']; at: Date | null; detail: string }>,
    ): Promise<JobItem> => {
      try {
        const r = await read();
        return { name, status: r.status, at: r.at ? r.at.toISOString() : null, detail: r.detail };
      } catch (e) {
        return { name, status: 'missing', at: null, detail: `read failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    };
    const since = (at: Date | null, what: string) => (at ? `newest ${what} ${at.toISOString()}` : `no ${what} yet`);

    return Promise.all([
      item('News fetch', async () => {
        const at = await this.store.newestNewsFetchedAt();
        return { status: freshness(at, new Date(now.getTime() - NEWS_STALE_MS)), at, detail: since(at, 'article fetched') };
      }),
      item('Daily candles', async () => {
        const c = await this.store.dailyCandles(istMidnightOf(lastDay));
        const status = c.countAtDay > 0 ? 'ok' : c.newest ? 'stale' : 'missing';
        return { status, at: c.newest, detail: `${c.countAtDay} instruments have the ${lastDay} daily bar` };
      }),
      item('MBM predictions', async () => {
        const at = await this.store.newestMbmPredictionAt();
        return { status: freshness(at, mbmSince), at, detail: since(at, 'NIFTY prediction') };
      }),
      item('MBM chain snapshots', async () => {
        const at = await this.store.newestMbmChainAt();
        return { status: freshness(at, mbmSince), at, detail: since(at, 'NIFTY chain capture') };
      }),
      item('Sentinel overnight review', async () => {
        const at = await this.store.lastOvernightReviewAt(userId);
        return { status: freshness(at, from), at, detail: since(at, 'after-close verdict') };
      }),
    ]);
  }
}

/** What the news and events matchers key on: each position's underlying, or its own cash symbol. */
function heldKeys(rows: PositionRow[]): HeldKey[] {
  const seen = new Map<string, HeldKey>();
  for (const r of rows) {
    const ref = r.underlying ?? r.instrument;
    const label = r.underlying ? r.underlying.symbol : baseSymbol(r.instrument.symbol);
    const key = `${label}|${r.instrument.exchange.toUpperCase()}`;
    if (!seen.has(key)) seen.set(key, { label, exchange: r.instrument.exchange, ref });
  }
  return [...seen.values()];
}

function summarise(
  now: Date,
  positions: Section<PositionRow[]>,
  news: Section<NewsSection>,
  events: Section<EventItem[]>,
): NightSummary {
  const rows = isError(positions) ? [] : positions;
  const plans = rows.map((r) => planInForce(r)?.verdict ?? null);
  const today = istYmd(now);
  return {
    positions: rows.length,
    exitAtOpen: plans.filter((v) => v === 'EXIT_AT_OPEN').length,
    tighten: plans.filter((v) => v === 'TIGHTEN_AT_OPEN').length,
    held: rows.filter((r) => r.held).length,
    newsOnPositions: isError(news) ? 0 : distinctArticles(news.onPositions),
    eventsToday: isError(events) ? 0 : events.filter((e) => istYmd(new Date(e.startsAt)) === today).length,
  };
}
