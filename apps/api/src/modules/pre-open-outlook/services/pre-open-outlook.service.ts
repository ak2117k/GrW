import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { istDayAt } from '../../entry-engine/domain/engine-inputs';
import { headlineAbout, NEWS_THEME, newsTheme } from '../../entry-engine/domain/news-theme';
import { EntryEngineRepository } from '../../entry-engine/entry-engine.repository';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import { MarketCuesService } from '../../market-cues/market-cues.service';
import { chartMove, type GlobalChart, type GlobalMove } from '../domain/global-chart';
import {
  OUTLOOK_ORDER,
  OUTLOOK_UNIVERSE,
  outlookAlertText,
  outlookOf,
  parseHeadlineMove,
  preOpenWindowMin,
  type HeadlineMove,
  type PreOpenOutlook,
} from '../domain/outlook';
import { istYmd, outlookEnabled, PRE_OPEN_CRONS } from '../domain/schedule';
import type { PreOpenOutlookReport, PreOpenOutlookSource } from '../pre-open-outlook.ports';
import { PreOpenOutlookRepository } from '../pre-open-outlook.repository';
import { GlobalPriceService } from './global-price.service';

export const PRE_OPEN_CLOCK = Symbol('PRE_OPEN_CLOCK');

/** The part of SessionClock used. */
export interface TradingDayClock {
  isTradingDay(exchange: string, at?: Date): boolean;
}

const MIN = 60_000;
/** A stored outlook younger than this is what the night report shows; older → a fresh preview. */
const REPORT_STORED_MAX_AGE_MS = 6 * 60 * MIN;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface RunResult {
  sessionDate: string;
  outlooks: PreOpenOutlook[];
  skipped: Array<{ underlying: string; reason: string }>;
  alerted: boolean;
}

/**
 * PRE-OPEN OUTLOOK (owner 2026-11-02). 08:30 IST Mon–Fri, per underlying of {@link OUTLOOK_ORDER}
 * on its venue's trading day: last close (the line's last 1-minute bar before today's open), the
 * global move since then (live Yahoo chart → else the latest global_price_snapshots row; GIFT Nifty
 * from market-cues for the indices), the news theme back to the last close, headline price moves,
 * → outlookOf (deterministic, no LLM) → pre_open_outlooks + one Telegram ops alert (no-op until
 * TELEGRAM_ALERT_* are set). Observe only: it places nothing; the entry engine reads the stored bias.
 */
@Injectable()
export class PreOpenOutlookService implements PreOpenOutlookSource {
  private readonly logger = new Logger(PreOpenOutlookService.name);
  private running = false;

  constructor(
    private readonly repo: PreOpenOutlookRepository,
    private readonly impacts: EntryEngineRepository,
    private readonly prices: GlobalPriceService,
    @Inject(PRE_OPEN_CLOCK) private readonly clock: TradingDayClock,
    @Optional() private readonly cues?: MarketCuesService,
  ) {}

  @Cron(PRE_OPEN_CRONS.outlook, { name: 'pre-open-outlook', timeZone: 'Asia/Kolkata' })
  async tick(): Promise<void> {
    if (!outlookEnabled(process.env)) return;
    await this.run(new Date());
  }

  /** Compute, store and alert every underlying whose venue trades today. */
  async run(now: Date, opts: { alert?: boolean } = {}): Promise<RunResult> {
    const sessionDate = istYmd(now);
    if (this.running) return { sessionDate, outlooks: [], skipped: [{ underlying: '*', reason: 'previous run still going' }], alerted: false };
    this.running = true;
    const outlooks: PreOpenOutlook[] = [];
    const skipped: RunResult['skipped'] = [];
    try {
      for (const u of OUTLOOK_ORDER) {
        const venue = OUTLOOK_UNIVERSE[u].venue;
        let trading = true;
        try {
          trading = this.clock.isTradingDay(venue, now);
        } catch {
          trading = true;
        }
        if (!trading) {
          skipped.push({ underlying: u, reason: `${venue} not trading on ${sessionDate}` });
          continue;
        }
        try {
          const o = await this.compute(u, now, true);
          await this.repo.insertOutlook(o).catch((e) => this.logger.warn(`[pre-open] storing ${u} failed: ${errText(e)}`));
          outlooks.push(o);
          this.logger.log(`[pre-open] ${o.summary}`);
        } catch (e) {
          skipped.push({ underlying: u, reason: errText(e) });
          this.logger.warn(`[pre-open] ${u} failed: ${errText(e)}`);
        }
      }
    } finally {
      this.running = false;
    }
    let alerted = false;
    if (outlooks.length > 0 && opts.alert !== false) alerted = await sendOpsAlert(`pre-open:${sessionDate}`, outlookAlertText(outlooks));
    return { sessionDate, outlooks, skipped, alerted };
  }

  /** The newest stored outlook per underlying of the last 24 h. */
  latest(now: Date = new Date()): Promise<PreOpenOutlook[]> {
    return this.repo.latestOutlooks(new Date(now.getTime() - 24 * 60 * MIN));
  }

  /** Night report: the stored outlooks when fresh (≤ 6 h), else a preview from DB data only (no HTTP, nothing stored). */
  async forReport(now: Date): Promise<PreOpenOutlookReport> {
    const stored = await this.repo.latestOutlooks(new Date(now.getTime() - REPORT_STORED_MAX_AGE_MS));
    if (stored.length > 0) return { source: 'stored', asOf: stored.map((o) => o.at).sort().pop() ?? now.toISOString(), items: stored, note: 'Computed by the 08:30 IST pre-open outlook (deterministic; observe only).' };
    const items: PreOpenOutlook[] = [];
    for (const u of OUTLOOK_ORDER) {
      try {
        items.push(await this.compute(u, now, false));
      } catch (e) {
        this.logger.warn(`[pre-open] preview ${u} failed: ${errText(e)}`);
      }
    }
    return { source: 'preview', asOf: now.toISOString(), items, note: 'Preview from the stored global price snapshots and news so far; the 08:30 IST run replaces it.' };
  }

  /** One underlying's outlook at `now`. `live` = may fetch Yahoo / market-cues; else DB / cache only. */
  async compute(underlying: string, now: Date, live: boolean): Promise<PreOpenOutlook> {
    const u = underlying.toUpperCase();
    const entry = OUTLOOK_UNIVERSE[u];
    if (!entry) throw new Error(`no pre-open outlook for ${u}`);
    const sessionStart = istDayAt(now, entry.openMin);
    const line = INDEX_UNDERLYINGS[u] ?? (await this.repo.nearestFuture(u, istDayAt(now, 0)));
    const last = line ? await this.repo.lastBarBefore(line.exchange, line.token, sessionStart, entry.openMin, entry.closeMin) : null;
    const lastClose = last ? { price: last.price, at: new Date(last.at.getTime() + MIN).toISOString() } : null;
    const closeT = lastClose ? new Date(lastClose.at) : null;

    const move = await this.globalMove(u, closeT, now, live);
    const windowMin = preOpenWindowMin(now, closeT, NEWS_THEME.preOpen.windowMin, NEWS_THEME.preOpen.maxWindowMin);
    const impacts = await this.impacts.impacts(new Date(now.getTime() - windowMin * MIN), now);
    const theme = newsTheme(impacts, u, now, { windowMin, halfLifeMin: NEWS_THEME.preOpen.halfLifeMin });
    const clusters = await this.repo.clustersBetween(closeT ?? new Date(now.getTime() - 24 * 60 * MIN), now);
    const headlineMoves = clusters
      .filter((c) => headlineAbout(u, c.headline))
      .map((c) => parseHeadlineMove(u, c.id, c.headline))
      .filter((x): x is HeadlineMove => x !== null);
    return outlookOf({ underlying: u, sessionDate: istYmd(now), at: now, lastClose, move, theme, headlineMoves });
  }

  /** The first usable global move of the underlying's list (GIFT for the indices, then Yahoo symbols). */
  private async globalMove(u: string, closeT: Date | null, now: Date, live: boolean): Promise<(GlobalMove & { beta: number }) | null> {
    const entry = OUTLOOK_UNIVERSE[u];
    let lastFail: (GlobalMove & { beta: number }) | null = null;
    for (const sym of entry.globals) {
      const beta = entry.beta[sym] ?? 1;
      if (sym === 'GIFT') {
        const g = await this.giftMove(now, live);
        if (g && g.status !== 'NO_DATA') return { ...g, beta };
        lastFail = { ...(g ?? { status: 'NO_DATA', symbol: 'GIFT NIFTY', from: null, to: null, movePct: null, source: 'market-cues gift', reason: 'market-cues not loaded' }), beta };
        continue;
      }
      if (!closeT) return { status: 'NO_DATA', symbol: sym, from: null, to: null, movePct: null, source: 'n/a', reason: 'no last close for the underlying', beta };
      let chart: GlobalChart | null = null;
      let source = '';
      let why = '';
      if (live) {
        const r = await this.prices.chart(sym);
        if (r.ok) {
          chart = r.chart;
          source = r.source;
        } else why = `live: ${r.reason}`;
      }
      if (!chart) {
        chart = await this.repo.latestChart(sym, now).catch(() => null);
        source = `global_price_snapshots ${sym}`;
        if (!chart) why = `${why ? `${why}; ` : ''}no stored snapshot`;
      }
      const m = chartMove(chart ? { ...chart, symbol: sym } : null, closeT.getTime(), now.getTime(), source, why || undefined);
      if (m.status !== 'NO_DATA') return { ...m, symbol: sym, beta };
      lastFail = { ...m, symbol: sym, beta };
    }
    return lastFail;
  }

  private async giftMove(now: Date, live: boolean): Promise<GlobalMove | null> {
    if (!this.cues) return null;
    try {
      const snap = live ? await this.cues.ensure(['gift'], now) : this.cues.peek(now);
      const rec = snap.gift;
      const v = rec.values;
      if (!v || v.gapPercent === null || !v.niftyFuture) {
        return { status: 'NO_DATA', symbol: 'GIFT NIFTY', from: null, to: null, movePct: null, source: rec.source, reason: rec.reason ?? (snap.enabled ? 'no GIFT gap' : 'MARKET_CUES_ENABLED is not true') };
      }
      return {
        status: rec.status === 'ok' ? 'OK' : 'STALE',
        symbol: 'GIFT NIFTY',
        from: { price: v.niftyFuture.close, at: v.niftyFuture.closedAt ?? v.niftyFuture.sessionDate },
        to: { price: v.gift.price, at: v.gift.at },
        movePct: Math.round(v.gapPercent * 100) / 100,
        source: rec.source,
        ...(rec.status === 'ok' ? {} : { reason: rec.reason ?? rec.status }),
      };
    } catch (e) {
      return { status: 'NO_DATA', symbol: 'GIFT NIFTY', from: null, to: null, movePct: null, source: 'market-cues gift', reason: errText(e) };
    }
  }
}
