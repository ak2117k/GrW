import { Injectable, Logger } from '@nestjs/common';
import { MtfAlignmentService } from '../services/mtf-alignment.service';
import { LevelBookService } from '../services/level-book.service';
import { NseSectorIndexService } from '../../market-data/services/nse-sector-index.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { classifyTrend } from '../../chartink/services/chartink-scoring.service';
import type { DetectionContext } from './pattern-observation.types';

/** At or inside this many ATRs of the nearest S/R level counts as "at a level". */
const AT_LEVEL_ATR = 0.5;

/** Input the enrichment needs; all of it is known at the detection bar. */
interface ComputeInput {
  token: string;
  exchange: string;
  symbol: string;
  bias: 'BULLISH' | 'BEARISH';
  spot: number;
  atr: number;
}

/**
 * Single point of Bucket-A context computation for ML observations. Wraps the
 * three existing "as-of-now" context services (MTF alignment, S/R level book,
 * sector-index trend) into one versioned {@link DetectionContext} snapshot.
 *
 * Fail-open PER SIGNAL is the load-bearing property: each sub-signal is computed
 * in its own try/catch and degrades to `null` on any failure, so one service
 * being down nulls only its own slice — never the whole snapshot, and never
 * throws. A capture path can therefore always persist a row (the null slices
 * honestly say "no trustworthy context for this signal").
 *
 * Because it is "as-of-now" it is only correct at the live edge; the scan path
 * that calls it enforces that gate. Reused at serving time for train/serve
 * parity. See docs/superpowers/specs/2026-07-17-ml-detection-context-enrichment-design.md.
 */
@Injectable()
export class DetectionContextService {
  private readonly logger = new Logger(DetectionContextService.name);

  constructor(
    private readonly mtf: MtfAlignmentService,
    private readonly levelBook: LevelBookService,
    private readonly nseSector: NseSectorIndexService,
    private readonly adapter: AngelOneAdapterService,
  ) {}

  async compute(input: ComputeInput): Promise<DetectionContext> {
    // Run the three sub-signals concurrently — they hit independent services and
    // each already fails open to null, so Promise.all can never reject.
    const [mtf, sr, sector] = await Promise.all([
      this.computeMtf(input),
      this.computeSr(input),
      this.computeSector(input),
    ]);
    return { v: 1, mtf, sr, sector };
  }

  private async computeMtf(input: ComputeInput): Promise<DetectionContext['mtf']> {
    try {
      const r = await this.mtf.check(input.token, input.exchange);
      return { aligned: r.aligned, direction: r.agreedDirection };
    } catch (err) {
      this.logger.warn(
        `mtf context failed for ${input.exchange}:${input.token} — ${this.msg(err)}`,
      );
      return null;
    }
  }

  private async computeSr(input: ComputeInput): Promise<DetectionContext['sr']> {
    try {
      // ATR is the yardstick the distance is expressed in; a non-positive ATR
      // makes distance-in-ATR meaningless, so there's no trustworthy S/R signal
      // (and no reason to spend a book load).
      if (!(input.atr > 0)) return null;

      const book = await this.levelBook.lazyLoad(
        input.token, input.exchange, input.symbol, 'bulk',
      );
      if (!book) return null;

      // The horizontal price levels the book maintains as genuine S/R: prior-day
      // high/low, prior close, today's + yesterday's opening range, and VWAP.
      // A level left at 0 / null is unpopulated (book seeded but not yet ticked)
      // — filter it out so it can't masquerade as a level sitting at price 0.
      const levels = [
        book.pdh, book.pdl, book.prevClose,
        book.orh, book.orl, book.prevOrh, book.prevOrl,
        book.vwap,
      ].filter((l): l is number => typeof l === 'number' && Number.isFinite(l) && l > 0);
      if (levels.length === 0) return null;

      const nearest = Math.min(...levels.map((l) => Math.abs(input.spot - l)));
      const distanceAtr = nearest / input.atr;
      return { distanceAtr, atLevel: distanceAtr <= AT_LEVEL_ATR };
    } catch (err) {
      this.logger.warn(
        `sr context failed for ${input.exchange}:${input.token} — ${this.msg(err)}`,
      );
      return null;
    }
  }

  private async computeSector(input: ComputeInput): Promise<DetectionContext['sector']> {
    try {
      // Mirror chartink-process: strip the NSE series suffix before the sector
      // lookup (the resolver strips too, but a bare symbol keeps the fetch key clean).
      const bare = input.symbol.replace(/-EQ$|-BE$|-BL$|-IV$/, '');
      const sectorToken = await this.nseSector.getSectorIndexForSymbol(bare);
      if (!sectorToken) return null; // no sector mapping → no trustworthy sector signal

      const closes = await this.fetchRecentCloses(sectorToken);
      // classifyTrend returns UP/DOWN/INDETERMINATE/null (null when <26 closes);
      // fold both "no clear trend" cases to NEUTRAL for the snapshot vocabulary.
      const raw = classifyTrend(closes);
      const trend: 'UP' | 'DOWN' | 'NEUTRAL' | null =
        raw === 'UP' ? 'UP' : raw === 'DOWN' ? 'DOWN' : raw === null ? null : 'NEUTRAL';

      return { trend, alignment: this.alignSector(trend, input.bias) };
    } catch (err) {
      this.logger.warn(
        `sector context failed for ${input.symbol} — ${this.msg(err)}`,
      );
      return null;
    }
  }

  /**
   * A trend agrees with the bias when both point the same way (UP+BULLISH /
   * DOWN+BEARISH → 'with'), conflicts when they oppose ('against'), and is
   * 'neutral' whenever the trend has no directional opinion (NEUTRAL / null).
   */
  private alignSector(
    trend: 'UP' | 'DOWN' | 'NEUTRAL' | null,
    bias: 'BULLISH' | 'BEARISH',
  ): 'with' | 'against' | 'neutral' {
    if (trend === 'UP') return bias === 'BULLISH' ? 'with' : 'against';
    if (trend === 'DOWN') return bias === 'BEARISH' ? 'with' : 'against';
    return 'neutral';
  }

  /**
   * Last 50 closes of 15m candles over the past week — the exact series
   * chartink-process feeds classifyTrend for the sector direction gate. Uses
   * getHistoricalData (auto-chunked, rate-paced) and returns [] on empty history
   * so classifyTrend degrades to null (→ NEUTRAL) rather than throwing.
   */
  private async fetchRecentCloses(token: string): Promise<number[]> {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const candles = (await this.adapter.getHistoricalData(
      token, 'NSE', '15m', from, to,
    )) as Array<{ close: number | string }>;
    if (!candles || candles.length === 0) return [];
    return candles.slice(-50).map((c) => Number(c.close));
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
