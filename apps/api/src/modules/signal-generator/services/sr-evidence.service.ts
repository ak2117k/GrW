import { Injectable, Logger, Optional } from '@nestjs/common';
import { LevelBookService } from './level-book.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { ZoneRepository } from '../repositories/zone.repository';
import { OiWallService } from './oi-wall.service';
import { YahooFinanceService } from '../../market-data/services/yahoo-finance.service';
import { computeVolumeNodes, computeProfileLevels, type ProfileCandle } from './volume-profile';
import { adaptiveRoundNumbers, adaptiveRoundStep, roundScore } from './adaptive-round-numbers';
import { scoreAndCluster, capLevelsPerSide } from './sr-evidence-scoring';
import { lookbackDaysFor, isIntradayInterval, isPositionalInterval } from './timeframe-lookback';
import { computeAtrFromCandles } from './per-tf-atr';
import { detectWeightedPivots } from './swing-pivots';
import { maLevels, anchoredVwap } from './dynamic-sr';
import { gapLevels } from './gaps';
import { fibLevels } from './fibonacci';
import { SrLevelTrackingService } from './sr-level-tracking.service';
import type { EvidenceLevel, LevelCandidate } from '../types/evidence-level.types';

interface CacheEntry { at: number; levels: EvidenceLevel[]; }
const CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Max evidence levels drawn per side on native (non-15m) intervals. Lower
 * timeframes generate many swing-pivot HISTORY candidates; without a cap the
 * chart floods (e.g. 17 lines on 5m) and buries the primary zone walls. The
 * frozen 15m path is never capped.
 */
const EVIDENCE_MAX_PER_SIDE_INTRADAY = 3;

/**
 * Per-side evidence cap by timeframe. Intraday floods with swing-pivot HISTORY
 * so it stays tight (3). Positional TFs carry fewer, more meaningful structural
 * levels (weekly/monthly MAs, fib, gaps) and a wider price range, so they get
 * more room: 5 for daily/weekly, 6 for monthly. The frozen 15m path is never
 * capped (handled by the caller, not this helper).
 */
/**
 * Bar time as unix SECONDS (the chart's unit). Every candle source here hands
 * back a `timestamp: Date`; anything else yields undefined so a bad row is
 * simply position-less rather than NaN-positioned.
 */
function toUnixSeconds(ts: unknown): number | undefined {
  const ms = ts instanceof Date ? ts.getTime() : typeof ts === 'number' ? ts : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function maxPerSideFor(interval: string): number {
  if (interval === '1mo') return 6;
  if (interval === '1d' || interval === '1w') return 5;
  return EVIDENCE_MAX_PER_SIDE_INTRADAY;
}

/**
 * Orchestrates evidence-weighted S/R: volume nodes + adaptive round numbers +
 * OI walls + pivot history -> scored, sided EvidenceLevel[]. Cached 15 min.
 * All deps optional so test/unwired containers construct cleanly; returns []
 * rather than throwing on any failure.
 */
@Injectable()
export class SrEvidenceService {
  private readonly logger = new Logger(SrEvidenceService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Optional() private readonly levelBookService?: LevelBookService,
    @Optional() private readonly angelOneAdapter?: AngelOneAdapterService,
    @Optional() private readonly marketDataRepository?: MarketDataRepository,
    @Optional() private readonly zoneRepository?: ZoneRepository,
    @Optional() private readonly oiWallService?: OiWallService,
    @Optional() private readonly tracking?: SrLevelTrackingService,
    // Weekly/monthly candles — Angel's adapter only maps up to ONE_DAY, so
    // 1w/1mo levels must come from Yahoo. Optional so test/unwired containers
    // construct cleanly; positional weekly/monthly returns [] when absent.
    @Optional() private readonly yahooFinanceService?: YahooFinanceService,
  ) {}

  /**
   * Evidence-weighted S/R levels for a token. `interval` selects the branch:
   *
   * - `'15m'` (default — the trading/chart 15m path) is FROZEN: it computes
   *   the overlay from 5m candles + the daily `book.atr14` + the DB-stored
   *   15m zone pivots, byte-for-byte as before. Trading callers omit the
   *   arg and execute this path unchanged.
   * - any other intraday interval gets a NATIVE per-timeframe path: candles
   *   are fetched at that interval (per-TF lookback), the ATR is computed
   *   from those candles, and HISTORY candidates come from swing pivots in
   *   the same candles — never touching the shared 15m zone DB.
   */
  async levelsFor(
    token: string,
    exchange: string,
    symbol: string,
    interval: string = '15m',
  ): Promise<EvidenceLevel[]> {
    if (!token || !this.levelBookService) return [];
    const cacheKey = `${token}:${exchange}:${interval}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.levels;

    try {
      const book = await this.levelBookService.lazyLoad(token, exchange, symbol);
      if (!book) return [];
      const ltp = book.spot;
      if (!(ltp > 0)) return [];

      const isFifteen = interval === '15m';

      // Candle source + ATR unit differ by branch. 15m keeps the proven
      // 5m-candles + daily-ATR basis; non-15m uses native per-TF candles
      // and a per-TF ATR (falling back to the daily ATR only if zero).
      // Candle source by timeframe: 15m keeps its 5m basis; intraday + daily
      // come from Angel (it maps up to ONE_DAY); weekly/monthly can only come
      // from Yahoo (Angel has no weekly/monthly interval).
      const candles = isFifteen
        ? await this.fetchCandles(token, exchange, '5m', 10)
        : await this.fetchNativeCandles(token, exchange, symbol, interval);
      const atr14 = isFifteen
        ? book.atr14
        : computeAtrFromCandles(candles, 14) || book.atr14;

      const volNodes = computeVolumeNodes(candles, atr14, ltp);
      const step = adaptiveRoundStep(ltp);
      const roundGrid = adaptiveRoundNumbers(ltp);
      // OI walls + max-pain + OI-change build-up (wallsExtended adds the latter
      // two). Intraday-only: a near-expiry options concept is meaningless on a
      // positional (1d/1w/1mo) horizon, so we skip the OI candidates entirely.
      const oiWalls = (this.oiWallService && isIntradayInterval(interval))
        ? await this.oiWallService.wallsExtended(symbol, ltp)
        : [];

      const candidates: LevelCandidate[] = [];
      for (const n of volNodes) candidates.push({ price: n.price, kind: 'VOLUME', score: n.score });
      for (const r of roundGrid) {
        const rs = roundScore(r, step);
        if (rs > 0) candidates.push({ price: r, kind: 'ROUND', score: rs });
      }
      for (const w of oiWalls) candidates.push(w);

      // Volume Point-of-Control + Value-Area (intraday profile) and anchored VWAP.
      for (const p of computeProfileLevels(candles, atr14, ltp)) candidates.push(p);
      for (const p of anchoredVwap(candles, ltp)) candidates.push(p);

      // Structural levels: moving averages (20/50/200), unfilled gaps, and fib
      // retracements of the dominant swing. Intraday TFs compute these off a
      // separate DAILY series; positional TFs (1d/1w/1mo) compute them off the
      // SAME candles we fetched, so a weekly request yields weekly MAs and a
      // monthly request monthly MAs. Detectors self-skip when bars are short.
      const structuralCandles = isPositionalInterval(interval)
        ? candles
        : await this.fetchCandles(token, exchange, '1d', 365);
      if (structuralCandles.length >= 20) {
        for (const p of maLevels(structuralCandles, ltp)) candidates.push(p);
        for (const p of gapLevels(structuralCandles, ltp)) candidates.push(p);
        for (const p of fibLevels(structuralCandles, ltp)) candidates.push(p);
      }

      if (isFifteen) {
        // FROZEN 15m path — HISTORY from the DB-stored 15m zones.
        const pivots = this.zoneRepository ? await this.zoneRepository.findActiveByToken(token) : [];
        for (const p of pivots as any[]) {
          const edge = p.type === 'resistance' ? p.lower : p.upper;
          candidates.push({ price: edge, kind: 'HISTORY', score: 25 * ((p.strength ?? 0) / 100) });
        }
      } else {
        // NATIVE non-15m path — HISTORY from swing pivots in the per-TF
        // candles. Fixed score 25 (no DB strength available); never reads
        // the shared zone DB.
        for (const piv of detectWeightedPivots(candles)) {
          candidates.push({ price: piv.price, kind: piv.kind, score: piv.score });
        }
      }

      const levels = scoreAndCluster(candidates, ltp, atr14, { softRoundGrid: roundGrid });
      // Native timeframes over-produce levels; cap per side to keep the chart
      // readable. The cap is timeframe-aware (intraday 3, positional 5/6 — see
      // maxPerSideFor). 15m is FROZEN — never capped.
      const finalLevels = isFifteen
        ? levels
        : capLevelsPerSide(levels, maxPerSideFor(interval));
      this.cache.set(cacheKey, { at: Date.now(), levels: finalLevels });
      // Fire-and-forget: persist this snapshot so reactions can later be
      // classified and per-kind hold-rates calibrated (sr-hold-rate script).
      void this.tracking?.snapshot(token, exchange, interval, finalLevels, ltp, atr14).catch(() => {});
      return finalLevels;
    } catch (err) {
      this.logger.warn(`SrEvidence levelsFor failed for ${token}: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  /**
   * The per-timeframe candle series, time-stamped, for callers that need the
   * bars themselves rather than levels — today only the chart's trend-line fit.
   *
   * It deliberately routes through the SAME `fetchNativeCandles` the level
   * computation uses (same interval, same `lookbackDaysFor` window, same
   * Angel/Yahoo split), so the drawn trend and the drawn levels are derived
   * from one series and cannot disagree. The adapter's TTL historical cache
   * means the repeat call for an interval already scored is normally a cache
   * hit, not a fresh broker request.
   *
   * Note this is the NATIVE branch even for 15m: `levelsFor('15m')` is frozen
   * on a 5m basis, but a trend line drawn on a 15m chart must come from 15m
   * swings. Nothing about the frozen path is touched by asking for these bars.
   */
  async candlesFor(
    token: string,
    exchange: string,
    symbol: string,
    interval: string = '15m',
  ): Promise<ProfileCandle[]> {
    if (!token) return [];
    return this.fetchNativeCandles(token, exchange, symbol, interval);
  }

  /**
   * Candle source for the NATIVE (non-15m) branch, routed by timeframe:
   *
   * - intraday (1m–1h) and `1d`: Angel adapter (it maps up to ONE_DAY) via
   *   `fetchCandles`, over the per-TF lookback window.
   * - `1w` / `1mo`: Angel has no weekly/monthly interval, so these come from
   *   Yahoo. Our `1mo` maps to Yahoo's `1M` code; Yahoo's candle shape is
   *   converted to `ProfileCandle`. Returns [] (no throw) when Yahoo is
   *   unwired or returns null/empty.
   */
  private async fetchNativeCandles(
    token: string,
    exchange: string,
    symbol: string,
    interval: string,
  ): Promise<ProfileCandle[]> {
    if (interval === '1w' || interval === '1mo') {
      if (!this.yahooFinanceService || !symbol) return [];
      const code = interval === '1mo' ? '1M' : '1w';
      const now = new Date();
      const from = new Date(now.getTime() - lookbackDaysFor(interval) * 24 * 60 * 60 * 1000);
      try {
        const rows = await this.yahooFinanceService.getCandles(symbol, exchange, token, code, from, now);
        if (!Array.isArray(rows) || rows.length === 0) return [];
        return rows.map((c) => ({
          high: c.high,
          low: c.low,
          close: c.close,
          volume: Number(c.volume),
          time: toUnixSeconds(c.timestamp),
        }));
      } catch (err) {
        this.logger.debug(`SrEvidence Yahoo ${interval} fetch failed for ${symbol}: ${err instanceof Error ? err.message : err}`);
        return [];
      }
    }
    // intraday + 1d → Angel adapter (DB fallback), per-TF lookback.
    return this.fetchCandles(token, exchange, interval, lookbackDaysFor(interval));
  }

  /**
   * Live candles at the given interval over the last `lookbackDays` via the
   * adapter; DB fallback. Generalises the old hardcoded-5m fetch — the 15m
   * branch passes `'5m'`/10 to keep its proven basis identical.
   */
  private async fetchCandles(
    token: string,
    exchange: string,
    interval: string,
    lookbackDays: number,
  ): Promise<ProfileCandle[]> {
    const now = new Date();
    const from = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    if (this.angelOneAdapter) {
      try {
        const live = await this.angelOneAdapter.getHistoricalData(token, exchange, interval, from, now);
        if (Array.isArray(live) && live.length >= 10) {
          return live.map((c: any) => ({
            high: c.high,
            low: c.low,
            close: c.close,
            volume: Number(c.volume),
            time: toUnixSeconds(c.timestamp),
          }));
        }
      } catch (err) {
        this.logger.debug(`SrEvidence live ${interval} fetch failed for ${token}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (this.marketDataRepository) {
      const inst = await this.marketDataRepository.getInstrumentByToken(token);
      if (inst) {
        const rows = await this.marketDataRepository.getCandles(inst.id, interval, from, now, 800);
        return rows.map((r: any) => ({
          high: r.high,
          low: r.low,
          close: r.close,
          volume: Number(r.volume),
          time: toUnixSeconds(r.timestamp),
        }));
      }
    }
    return [];
  }
}
