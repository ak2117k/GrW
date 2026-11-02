import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { cueGetJson, describeFetchError, type FetchLike } from '../../market-cues/fetchers/cue-http';
import { MARKET_CUES_DEFAULT_UA } from '../../market-cues/market-cues.config';
import { GLOBAL_SNAPSHOT_SYMBOLS, parseYahooChart, YAHOO_CHART_URL, type GlobalChart } from '../domain/global-chart';
import { globalPricesEnabled, PRE_OPEN_CRONS } from '../domain/schedule';
import { PreOpenOutlookRepository } from '../pre-open-outlook.repository';

/** Optional fetch override (tests). */
export const GLOBAL_PRICE_FETCH = Symbol('GLOBAL_PRICE_FETCH');

export type ChartRead = { ok: true; chart: GlobalChart; source: string } | { ok: false; reason: string; source: string };

/**
 * GLOBAL PRICES — read-only HTTP to Yahoo Finance's public chart endpoint (no auth; verified from the
 * prod server 2026-11-02). Every 30 min, every day: one GET per symbol (WTI, Brent, S&P futures),
 * one retry, 10 s timeout, stored in global_price_snapshots (NO_DATA rows on failure, never a zero).
 * `chart` is the outlook's live read; it never throws (a failure is `{ ok: false, reason }`).
 * GLOBAL_PRICES=off / BOOT_JOBS=false stop the cron. Owner's own use only (unofficial source).
 */
@Injectable()
export class GlobalPriceService {
  private readonly logger = new Logger(GlobalPriceService.name);
  private running = false;
  /** Pause before the single retry (tests set 0). */
  retryDelayMs = 2_000;

  constructor(
    private readonly repo: PreOpenOutlookRepository,
    @Optional() @Inject(GLOBAL_PRICE_FETCH) private readonly fetchImpl?: FetchLike,
  ) {}

  @Cron(PRE_OPEN_CRONS.globalPrices, { name: 'global-prices', timeZone: 'Asia/Kolkata' })
  async tick(): Promise<void> {
    if (!globalPricesEnabled(process.env)) return;
    await this.snapshot(new Date());
  }

  /** Fetch every snapshot symbol and store one row each. Returns the per-symbol status. */
  async snapshot(now: Date): Promise<Array<{ symbol: string; status: 'OK' | 'NO_DATA'; reason?: string }>> {
    if (this.running) return [];
    this.running = true;
    const out: Array<{ symbol: string; status: 'OK' | 'NO_DATA'; reason?: string }> = [];
    try {
      for (const symbol of GLOBAL_SNAPSHOT_SYMBOLS) {
        const r = await this.chart(symbol);
        try {
          await this.repo.insertSnapshot(
            r.ok
              ? {
                  symbol,
                  price: r.chart.price ?? r.chart.bars[r.chart.bars.length - 1]?.close ?? null,
                  priceTime: r.chart.priceAt !== null ? new Date(r.chart.priceAt) : null,
                  fetchedAt: now,
                  status: 'OK',
                  source: r.source,
                  reason: null,
                  intervalMs: r.chart.intervalMs,
                  bars: r.chart.bars.slice(-120),
                }
              : { symbol, price: null, priceTime: null, fetchedAt: now, status: 'NO_DATA', source: r.source, reason: r.reason.slice(0, 300), intervalMs: null, bars: null },
          );
        } catch (e) {
          this.logger.warn(`[global-prices] storing ${symbol} failed: ${describeFetchError(e)}`);
        }
        out.push(r.ok ? { symbol, status: 'OK' } : { symbol, status: 'NO_DATA', reason: r.reason });
      }
    } finally {
      this.running = false;
    }
    const bad = out.filter((x) => x.status !== 'OK');
    if (bad.length) this.logger.warn(`[global-prices] NO_DATA: ${bad.map((b) => `${b.symbol} (${b.reason})`).join('; ')}`);
    return out;
  }

  /** One live chart read (1h bars, 5 days). Never throws. */
  async chart(symbol: string): Promise<ChartRead> {
    const url = YAHOO_CHART_URL.replace('{symbol}', encodeURIComponent(symbol));
    const source = `Yahoo chart ${symbol}`;
    try {
      const json = await cueGetJson(url, { timeoutMs: 10_000, userAgent: MARKET_CUES_DEFAULT_UA, accept: 'application/json', retryDelayMs: this.retryDelayMs, fetchImpl: this.fetchImpl });
      return { ok: true, chart: parseYahooChart(json, symbol), source };
    } catch (e) {
      return { ok: false, reason: describeFetchError(e), source };
    }
  }
}
