import { Injectable, Logger } from '@nestjs/common';
import { CandleData } from '../../../common/interfaces/trading-strategy.interface';
import { LevelBook } from '../types/level-book.types';
import { StrongZone, ZoneScoreBreakdown } from '../types/zone.types';

/**
 * Input shape for the detector. See spec Component 1.
 */
export interface DetectZonesInput {
  token: string;
  symbol: string;
  exchange: string;
  /** Working timeframe (15m). Min 200 bars recommended for stable pivots. */
  candles15m: CandleData[];
  /** Optional HTF (1h) candles for confluence bonus. */
  candles1h?: CandleData[];
  /** Optional level book for PDH/PDL/round/VWAP confluence. */
  levelBook?: LevelBook;
  /** Last traded price — used to split zones into above/below buckets. */
  ltp: number;
  /** 14-period ATR (daily preferred, but any consistent ATR works). */
  atr14: number;
  /**
   * Working timeframe for cache keying only (default treated as '15m').
   * Bar-count windows are timeframe-relative, so the compute math is
   * unchanged — `candles15m` may hold per-TF candles for the chart path.
   * Lets the chart cache non-15m zones without colliding with the
   * trading-path 15m entry under the same token.
   */
  interval?: string;
}

/** Internal raw pivot before clustering. */
interface Pivot {
  /** 'high' = swing high (resistance), 'low' = swing low (support). */
  kind: 'high' | 'low';
  /** Index in the candles15m array. */
  index: number;
  /** Pivot price (high for highs, low for lows). */
  price: number;
  candle: CandleData;
}

/** Internal cluster shape used during scoring. */
interface PivotCluster {
  pivots: Pivot[];
  upper: number;
  lower: number;
  /** Highest index in the cluster — drives recency scoring. */
  lastIndex: number;
}

const CLUSTER_PRICE_TOLERANCE_PCT = 0.003; // 0.3% min span — guards small-ATR edge

const WEIGHTS = {
  touchCount: 0.25,
  reversalScore: 0.25,
  volumeScore: 0.15,
  recencyScore: 0.15,
  confluenceBonus: 0.1,
  wickDensity: 0.1,
} as const;

const STRONG_THRESHOLD = 70;
const MEDIUM_THRESHOLD = 40;

const CACHE_TTL_MS = 15 * 60 * 1000;

const TOP_N_PER_SIDE = 5;

/** Min body size (in ATR units) for a bar to count as an impulsive break of a zone. */
const BREAK_BODY_ATR = 0.5;
/** Below this many post-flip touches, a flipped zone is "fresh" and gets a one-tier demotion. */
const FRESH_SWAP_POST_FLIP_FLOOR = 3;

interface CachedEntry {
  computedAt: number;
  expiresAt: number;
  zones: StrongZone[];
}

/**
 * Detects strong support/resistance zones from a candle stream.
 *
 * Algorithm summary (full detail in the spec):
 *   1. 3-bar fractal pivot detection (skip last 3 bars — unconfirmed).
 *   2. Cluster pivots within `max(0.4 * ATR14, lastPrice * 0.3%)`.
 *   3. Score each cluster on 6 dimensions (touchCount, reversalScore,
 *      volumeScore, recencyScore, confluenceBonus, wickDensity).
 *   4. Weighted sum → classify (STRONG ≥70, MEDIUM ≥40, WEAK <40).
 *   5. Drop clusters below WEAK; return top 5 above + top 5 below LTP
 *      sorted by distance from LTP.
 *
 * Pure detection — no DB writes, no side effects beyond the in-memory
 * cache. Persistence is the caller's responsibility (ZoneRepository).
 */
@Injectable()
export class StrongZoneDetectorService {
  private readonly logger = new Logger(StrongZoneDetectorService.name);
  private readonly cache = new Map<string, CachedEntry>();

  /**
   * Compute the strong zones for the given input. Returns at most
   * 5 zones above LTP + 5 zones below LTP, sorted by distance from
   * LTP (nearest first within each side).
   *
   * Result is cached per-token for 15 minutes; pass a fresh closing
   * 15m candle (different last-bar timestamp) to invalidate via
   * {@link invalidateCache}.
   */
  detectZones(input: DetectZonesInput): StrongZone[] {
    const cacheKey = `${input.token}:${input.interval ?? '15m'}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.zones;
    }

    const zones = this.compute(input);

    this.cache.set(cacheKey, {
      computedAt: Date.now(),
      expiresAt: Date.now() + CACHE_TTL_MS,
      zones,
    });

    return zones;
  }

  /**
   * Force the next detectZones() to recompute. Called when a new 15m bar
   * closes. Clears ALL interval-keyed entries for the token (`${token}:*`)
   * so the scanner's 15m invalidation still works after the cache key
   * gained an interval suffix.
   */
  invalidateCache(token: string): void {
    const prefix = `${token}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  /** Test/admin helper — clear everything. */
  clearCache(): void {
    this.cache.clear();
  }

  // ────────────────────────────────────────────────────────────────
  // Pure compute pipeline
  // ────────────────────────────────────────────────────────────────

  private compute(input: DetectZonesInput): StrongZone[] {
    const { candles15m, atr14, ltp } = input;
    if (!Array.isArray(candles15m) || candles15m.length < 10) {
      return [];
    }
    if (!Number.isFinite(atr14) || atr14 <= 0) {
      this.logger.debug(
        `detectZones(${input.token}): atr14=${atr14} invalid, returning []`,
      );
      return [];
    }

    const pivots = this.detectPivots(candles15m);
    if (pivots.length === 0) return [];

    const clusters = this.clusterPivots(pivots, candles15m, atr14);
    const filtered = this.dropStaleSinglePivots(clusters, candles15m.length);
    if (filtered.length === 0) return [];

    const volMA20 = this.rollingVolumeAverage(candles15m, 20);

    const oneHourPivots = input.candles1h
      ? this.detectPivots(input.candles1h).map((p) => p.price)
      : [];

    const all: StrongZone[] = filtered.map((cluster) =>
      this.scoreAndBuildZone({
        cluster,
        candles: candles15m,
        atr14,
        ltp,
        token: input.token,
        symbol: input.symbol,
        exchange: input.exchange,
        levelBook: input.levelBook,
        oneHourPivotPrices: oneHourPivots,
        volMA20,
      }),
    );

    this.detectBreakthroughs(all, filtered, candles15m, atr14);

    // Keep zones at or above MEDIUM, plus any freshly-flipped zone (the
    // chart overlay still needs to render the swap badge even if the
    // post-flip strength briefly drops to WEAK; downstream filters like
    // TP1-at-obstacle apply their own classification gate).
    const aboveWeak = all.filter(
      (z) => z.strength >= MEDIUM_THRESHOLD || z.flippedAt !== undefined,
    );

    const above = aboveWeak
      .filter((z) => z.type === 'resistance')
      .sort((a, b) => this.zoneCenter(a) - ltp - (this.zoneCenter(b) - ltp))
      .slice(0, TOP_N_PER_SIDE);
    const below = aboveWeak
      .filter((z) => z.type === 'support')
      .sort((a, b) => ltp - this.zoneCenter(a) - (ltp - this.zoneCenter(b)))
      .slice(0, TOP_N_PER_SIDE);

    return [...above, ...below];
  }

  // ────────────────────────────────────────────────────────────────
  // Step 1 — pivot detection (3-bar fractal)
  // ────────────────────────────────────────────────────────────────

  private detectPivots(candles: CandleData[]): Pivot[] {
    const pivots: Pivot[] = [];
    // Confirmed pivots need 3 bars of context on either side; skip the
    // most-recent 3 bars (right-hand side cannot be confirmed yet).
    for (let i = 3; i < candles.length - 3; i++) {
      const c = candles[i];
      const isHigh =
        c.high > candles[i - 1].high &&
        c.high > candles[i - 2].high &&
        c.high > candles[i - 3].high &&
        c.high > candles[i + 1].high &&
        c.high > candles[i + 2].high &&
        c.high > candles[i + 3].high;
      if (isHigh) {
        pivots.push({ kind: 'high', index: i, price: c.high, candle: c });
        continue;
      }
      const isLow =
        c.low < candles[i - 1].low &&
        c.low < candles[i - 2].low &&
        c.low < candles[i - 3].low &&
        c.low < candles[i + 1].low &&
        c.low < candles[i + 2].low &&
        c.low < candles[i + 3].low;
      if (isLow) {
        pivots.push({ kind: 'low', index: i, price: c.low, candle: c });
      }
    }
    return pivots;
  }

  // ────────────────────────────────────────────────────────────────
  // Step 2 — cluster pivots into zones
  // ────────────────────────────────────────────────────────────────

  private clusterPivots(
    pivots: Pivot[],
    candles: CandleData[],
    atr14: number,
  ): PivotCluster[] {
    if (pivots.length === 0) return [];

    // Sort by price ascending so neighbours within tolerance group naturally.
    const sorted = [...pivots].sort((a, b) => a.price - b.price);
    const clusters: PivotCluster[] = [];

    for (const p of sorted) {
      const tol = Math.max(0.4 * atr14, p.price * CLUSTER_PRICE_TOLERANCE_PCT);
      const last = clusters[clusters.length - 1];
      if (last && p.price - last.upper <= tol) {
        last.pivots.push(p);
        last.upper = Math.max(last.upper, p.price);
        last.lower = Math.min(last.lower, p.price);
        last.lastIndex = Math.max(last.lastIndex, p.index);
      } else {
        clusters.push({
          pivots: [p],
          upper: p.price,
          lower: p.price,
          lastIndex: p.index,
        });
      }
    }
    // Suppress unused-var lint — `candles` reserved for future cluster
    // refinement (e.g. body-vs-wick boundary tightening).
    void candles;
    return clusters;
  }

  /**
   * Spec step 2 trailing rule: drop clusters that have a single pivot
   * AND the most recent touch is older than 50 bars (single-touch noise).
   */
  private dropStaleSinglePivots(
    clusters: PivotCluster[],
    barCount: number,
  ): PivotCluster[] {
    return clusters.filter((c) => {
      if (c.pivots.length > 1) return true;
      const ageBars = barCount - 1 - c.lastIndex;
      return ageBars <= 50;
    });
  }

  // ────────────────────────────────────────────────────────────────
  // Step 2.5 — swap-zone detection
  // ────────────────────────────────────────────────────────────────

  /**
   * Walk forward from each cluster's last pivot looking for an impulsive
   * close beyond the cluster's wall edge. When found, mutate the
   * corresponding zone in place: flip its type, set wasType + flippedAt +
   * preFlipTouchCount, halve touchCount (plus any post-flip pivots),
   * recompute strength + classification, and apply a one-tier freshness
   * demotion until 3+ post-flip touches accumulate.
   *
   * `zones` and `clusters` are paired by index — zones[i] was built from
   * clusters[i] via scoreAndBuildZone.
   *
   * See docs/superpowers/specs/2026-05-05-swap-zone-detection-design.md
   * §"Breakthrough detection algorithm".
   */
  private detectBreakthroughs(
    zones: StrongZone[],
    clusters: PivotCluster[],
    candles: CandleData[],
    atr14: number,
  ): void {
    const breakBodyThreshold = BREAK_BODY_ATR * atr14;

    for (let i = 0; i < zones.length; i++) {
      const zone = zones[i];
      const cluster = clusters[i];
      if (!cluster || cluster.pivots.length === 0) continue;

      let lowCount = 0;
      let highCount = 0;
      for (const p of cluster.pivots) {
        if (p.kind === 'low') lowCount++;
        else highCount++;
      }
      const naturalType: StrongZone['type'] =
        lowCount >= highCount ? 'support' : 'resistance';
      const wall = naturalType === 'support' ? cluster.lower : cluster.upper;

      // Scan from the EARLIEST pivot's bar, not the latest. cluster.lastIndex
      // is the most recent pivot — but if post-flip pivots from the NEW role
      // (e.g. swing highs at the same price level after a support breaks
      // down) have accumulated, lastIndex sits PAST the actual breakthrough
      // bar and the scan misses it entirely. Starting from cluster.pivots[0]
      // guarantees we see every candle between the cluster's earliest
      // touch and now.
      let flipBarIdx = -1;
      for (let j = cluster.pivots[0].index + 1; j < candles.length; j++) {
        const bar = candles[j];
        const body = Math.abs(bar.close - bar.open);
        if (body <= breakBodyThreshold) continue;
        if (naturalType === 'support' && bar.close < wall) {
          flipBarIdx = j;
          break;
        }
        if (naturalType === 'resistance' && bar.close > wall) {
          flipBarIdx = j;
          break;
        }
      }
      if (flipBarIdx < 0) continue;

      zone.flippedAt = candles[flipBarIdx].timestamp.getTime();
      zone.wasType = naturalType;
      zone.preFlipTouchCount = zone.touchCount;
      zone.type = naturalType === 'support' ? 'resistance' : 'support';

      const postFlipTouches = cluster.pivots.filter(
        (p) => p.index > flipBarIdx,
      ).length;
      const newTouchCount =
        Math.floor(zone.preFlipTouchCount / 2) + postFlipTouches;
      zone.touchCount = newTouchCount;

      const newTouchScore = Math.min(100, newTouchCount * 25);
      zone.scoreBreakdown.touchCount = round2(newTouchScore);
      zone.strength = Math.round(
        WEIGHTS.touchCount * newTouchScore +
          WEIGHTS.reversalScore * zone.scoreBreakdown.reversalScore +
          WEIGHTS.volumeScore * zone.scoreBreakdown.volumeScore +
          WEIGHTS.recencyScore * zone.scoreBreakdown.recencyScore +
          WEIGHTS.confluenceBonus * zone.scoreBreakdown.confluenceBonus +
          WEIGHTS.wickDensity * zone.scoreBreakdown.wickDensity,
      );

      const baseClassification: StrongZone['classification'] =
        zone.strength >= STRONG_THRESHOLD
          ? 'STRONG'
          : zone.strength >= MEDIUM_THRESHOLD
            ? 'MEDIUM'
            : 'WEAK';

      if (postFlipTouches < FRESH_SWAP_POST_FLIP_FLOOR) {
        zone.classification =
          baseClassification === 'STRONG'
            ? 'MEDIUM'
            : baseClassification === 'MEDIUM'
              ? 'WEAK'
              : 'WEAK';
      } else {
        zone.classification = baseClassification;
      }
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Step 3 — score each cluster
  // ────────────────────────────────────────────────────────────────

  private scoreAndBuildZone(args: {
    cluster: PivotCluster;
    candles: CandleData[];
    atr14: number;
    ltp: number;
    token: string;
    symbol: string;
    exchange: string;
    levelBook?: LevelBook;
    oneHourPivotPrices: number[];
    volMA20: number[];
  }): StrongZone {
    const {
      cluster,
      candles,
      atr14,
      ltp,
      token,
      symbol,
      exchange,
      levelBook,
      oneHourPivotPrices,
      volMA20,
    } = args;

    const pivotsCount = cluster.pivots.length;

    // — touchCount: 4+ touches = max
    const touchScore = Math.min(100, pivotsCount * 25);

    // — reversalScore: avg post-touch move in ATR units, 3 ATR = max
    const reversalScore = this.computeReversalScore(cluster, candles, atr14);

    // — volumeScore: avg(touch-bar volume / volMA20) / 2 = max at 2x
    const volumeScore = this.computeVolumeScore(cluster, volMA20);

    // — recencyScore: exp decay with half-life ~35 bars
    const lastIndex = cluster.lastIndex;
    const barsSinceLastTouch = candles.length - 1 - lastIndex;
    const recencyScore = clamp(
      Math.exp(-barsSinceLastTouch / 50) * 100,
      0,
      100,
    );

    // — confluence bonus
    const confluenceBonus = this.computeConfluenceBonus(
      cluster,
      atr14,
      levelBook,
      oneHourPivotPrices,
    );

    // — wick density: avg wick / body * 50, clamp 0-100
    const wickDensity = this.computeWickDensityScore(cluster);

    const breakdown: ZoneScoreBreakdown = {
      touchCount: round2(touchScore),
      reversalScore: round2(reversalScore),
      volumeScore: round2(volumeScore),
      recencyScore: round2(recencyScore),
      confluenceBonus: round2(confluenceBonus),
      wickDensity: round2(wickDensity),
    };

    const strength = Math.round(
      WEIGHTS.touchCount * touchScore +
        WEIGHTS.reversalScore * reversalScore +
        WEIGHTS.volumeScore * volumeScore +
        WEIGHTS.recencyScore * recencyScore +
        WEIGHTS.confluenceBonus * confluenceBonus +
        WEIGHTS.wickDensity * wickDensity,
    );

    const classification: StrongZone['classification'] =
      strength >= STRONG_THRESHOLD
        ? 'STRONG'
        : strength >= MEDIUM_THRESHOLD
          ? 'MEDIUM'
          : 'WEAK';

    const center = (cluster.upper + cluster.lower) / 2;
    const type: StrongZone['type'] = center >= ltp ? 'resistance' : 'support';
    const isLine = pivotsCount <= 2;

    const lastTouchCandle = cluster.pivots
      .reduce((best, p) => (p.index > best.index ? p : best), cluster.pivots[0])
      .candle;

    const computedAt = Date.now();

    return {
      id: this.makeZoneId(token, center),
      token,
      symbol,
      exchange,
      type,
      upper: round2(cluster.upper),
      lower: round2(cluster.lower),
      isLine,
      strength,
      classification,
      touchCount: pivotsCount,
      lastTouchTimestamp:
        lastTouchCandle.timestamp instanceof Date
          ? lastTouchCandle.timestamp.getTime()
          : new Date(lastTouchCandle.timestamp).getTime(),
      scoreBreakdown: breakdown,
      computedAt,
      expiresAt: computedAt + CACHE_TTL_MS,
    };
  }

  // ── reversal score: how strongly price moved away after each touch ─

  private computeReversalScore(
    cluster: PivotCluster,
    candles: CandleData[],
    atr14: number,
  ): number {
    const moves: number[] = [];
    for (const p of cluster.pivots) {
      // Look ~5 bars forward (or however many remain) and measure the
      // furthest excursion away from the pivot in the expected direction.
      const lookForward = Math.min(5, candles.length - 1 - p.index);
      if (lookForward <= 0) continue;
      const window = candles.slice(p.index + 1, p.index + 1 + lookForward);
      if (window.length === 0) continue;
      let move: number;
      if (p.kind === 'high') {
        // Resistance touch — expected reversal is DOWN
        const minLow = Math.min(...window.map((c) => c.low));
        move = Math.max(0, p.price - minLow);
      } else {
        // Support touch — expected reversal is UP
        const maxHigh = Math.max(...window.map((c) => c.high));
        move = Math.max(0, maxHigh - p.price);
      }
      moves.push(move);
    }
    if (moves.length === 0) return 0;
    const avgMove = moves.reduce((s, m) => s + m, 0) / moves.length;
    const moveInAtr = avgMove / atr14;
    return clamp((moveInAtr / 3) * 100, 0, 100);
  }

  // ── volume score: how heavy were the touches relative to recent avg ─

  private computeVolumeScore(
    cluster: PivotCluster,
    volMA20: number[],
  ): number {
    const ratios: number[] = [];
    for (const p of cluster.pivots) {
      const ma = volMA20[p.index];
      if (!ma || ma <= 0) continue;
      ratios.push(p.candle.volume / ma);
    }
    if (ratios.length === 0) return 0;
    const avgRatio = ratios.reduce((s, r) => s + r, 0) / ratios.length;
    return clamp((avgRatio / 2) * 100, 0, 100);
  }

  // ── confluence bonus: PDH/PDL/round/VWAP + 1H pivot overlap ─

  private computeConfluenceBonus(
    cluster: PivotCluster,
    atr14: number,
    levelBook: LevelBook | undefined,
    oneHourPivotPrices: number[],
  ): number {
    const center = (cluster.upper + cluster.lower) / 2;
    const tol = 0.2 * atr14;
    let bonus = 0;

    if (levelBook) {
      const levels: Array<number | null | undefined> = [
        levelBook.pdh,
        levelBook.pdl,
        levelBook.orh,
        levelBook.orl,
        levelBook.vwap,
        ...(levelBook.roundNumbers ?? []),
      ];
      const overlapsKey = levels.some(
        (lv) =>
          typeof lv === 'number' && Number.isFinite(lv) && Math.abs(lv - center) <= tol,
      );
      if (overlapsKey) bonus += 30;
    }

    const overlaps1h = oneHourPivotPrices.some(
      (price) => Math.abs(price - center) <= tol,
    );
    if (overlaps1h) bonus += 20;

    // HTF trend agreement bonus is applied by the strategy layer (which has
    // the higher-TF trend bias). We just leave the +10 hook open here.

    return Math.min(100, bonus);
  }

  // ── wick density: long wicks at touch bars = strong rejection signature ─

  private computeWickDensityScore(cluster: PivotCluster): number {
    const ratios: number[] = [];
    for (const p of cluster.pivots) {
      const c = p.candle;
      const body = Math.max(0.0001, Math.abs(c.close - c.open));
      const wick =
        p.kind === 'high'
          ? c.high - Math.max(c.close, c.open)
          : Math.min(c.close, c.open) - c.low;
      ratios.push(Math.max(0, wick) / body);
    }
    if (ratios.length === 0) return 0;
    const avg = ratios.reduce((s, r) => s + r, 0) / ratios.length;
    return clamp(avg * 50, 0, 100);
  }

  // ────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────

  /**
   * 20-bar rolling simple moving average of volume. Returns an array of
   * the same length as `candles`; positions before bar 19 use the
   * available prefix average so early pivots still get a sensible
   * volMA20 reference.
   */
  private rollingVolumeAverage(candles: CandleData[], window: number): number[] {
    const out: number[] = new Array(candles.length).fill(0);
    let sum = 0;
    for (let i = 0; i < candles.length; i++) {
      sum += candles[i].volume;
      if (i >= window) sum -= candles[i - window].volume;
      const denom = Math.min(i + 1, window);
      out[i] = denom > 0 ? sum / denom : 0;
    }
    return out;
  }

  private zoneCenter(z: StrongZone): number {
    return (z.upper + z.lower) / 2;
  }

  /**
   * Stable id based on token + zone center (rounded to 2 dp). Same token
   * + same center => same id, so chart consumers can diff updates rather
   * than blink the entire overlay.
   */
  private makeZoneId(token: string, center: number): string {
    return `zone_${token}_${Math.round(center * 100)}`;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
