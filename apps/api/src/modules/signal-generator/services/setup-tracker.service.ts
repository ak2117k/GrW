import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import {
  SetupRepository,
  SetupUpdateInput,
} from '../repositories/setup.repository';
import { SetupContext } from '../types/setup-context.types';

export interface RecommendedStrike {
  strike: number;
  side: 'CE' | 'PE';
  expiry: string;
  ltp: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  oi: number;
  volume: number;
  /** Expected premium gain per share if spot reaches target (delta + half-gamma estimate). */
  expectedProfitPerShare: number;
  /** Expected premium loss per share if spot hits stop. */
  expectedLossPerShare: number;
  lotSize: number;
  expectedProfitPerLot: number;
  expectedLossPerLot: number;
  reason: string;
}

export type SetupStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'PARTIAL_BOOKED'
  | 'TARGET_HIT'
  | 'STOPPED'
  | 'TRAIL_STOPPED'
  | 'EOD'
  | 'INVALIDATED';

export interface LockedSetup {
  id: string;
  token: string;
  symbol: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  setupType: 'BREAKOUT' | 'REVERSAL';
  levelType: SetupContext['levelType'];
  levelValue: number;
  entry: number;
  stoploss: number;
  target: number;
  /** 1×SL distance in profit. When spot reaches this, 50% is booked and SL ratchets to break-even. */
  partialTakeAt: number;
  /** Null until PARTIAL_BOOKED, then ratchets toward profit. */
  trailingSl: number | null;
  grade: 'A' | 'B' | 'C';
  atr14: number;
  status: SetupStatus;
  createdAt: Date;
  triggeredAt: Date | null;
  partialBookedAt: Date | null;
  runnerExitAt: Date | null;
  closedAt: Date | null;
  closeReason: SetupStatus | null;
  high: number;
  low: number;
  indicators: SetupContext['indicators'];
  higherTimeframeTrend: SetupContext['higherTimeframeTrend'];
  regime: SetupContext['regime'];
  intradayRangeRatio: number;
  reason: string;
  /**
   * Strike recommendation locked in at setup-detection time. Frozen across
   * subsequent polls so the panel doesn't churn as option LTP drifts.
   */
  recommendedStrike: RecommendedStrike | null;
  /**
   * Adaptive-invalidation classification, set when a setup is closed early
   * via one of the three short-circuit paths (structural retrace,
   * counter-setup confirmation, time-MFE stagnation). Null on
   * target/SL/EOD closes and on still-open setups.
   */
  invalidationKind: 'structural' | 'counter-setup' | 'time-mfe' | null;
  /** Human-readable explanation of why the setup was invalidated. */
  invalidationReason: string | null;
  /** Running max-favorable-excursion in R units, 0 at entry. Updated each tick once ACTIVE. */
  mfeR: number;
  /** Running max-adverse-excursion in R units (deepest unfavorable spot move
   *  from entry, 0 at entry). NEW field for forensics — paired with mfeR
   *  this tells us whether a stop-out came from a setup that ever showed
   *  promise vs. one that immediately went underwater. */
  maeR: number;
  /** Set when status first transitions to ACTIVE. Used to compute bars elapsed for the time-MFE check. */
  triggerBarTimestamp: Date | null;
  /**
   * Bars since the setup transitioned to ACTIVE. Updated alongside mfeR
   * on each tick once ACTIVE — captured here so close() can persist it
   * as the final barsToOutcome.
   */
  barsSinceEntry: number;
  /**
   * Cuid of the persisted Setup row. Null when persistence failed (the
   * tracker keeps running in-memory regardless). Used by update/close
   * paths to find the row to patch.
   */
  dbId: string | null;
  /**
   * Tick counter for debounced persistence. We flush to DB on status
   * transitions and every PERSIST_TICK_INTERVAL non-status ticks.
   */
  ticksSinceLastPersist: number;
  /**
   * How TP1 was placed on this setup. 'obstacle' = TP1 was backed off the
   * near edge of a STRONG/MEDIUM zone (touchCount ≥ 3) in the trade path;
   * 'fixed' = default 1×R. In-memory only — not yet persisted to DB. After
   * an API restart the locked numeric `partialTakeAt` is preserved (it's
   * a column on `setups`), but the source label is lost and the chart's
   * obstacle subtitle disappears until a fresh setup re-derives it.
   */
  tp1Source?: 'obstacle' | 'fixed';
  tp1Obstacle?: {
    classification: 'STRONG' | 'MEDIUM';
    touchCount: number;
    nearEdge: number;
  } | null;
  /**
   * Context-scoring engine output frozen at lock time. Optional so legacy
   * persisted setups (and tests that don't wire ContextScoringService)
   * still deserialise cleanly. See `ContextScoringService.score`.
   */
  contextScore?: number;
  contextTier?: 'STRONG_BULL' | 'BULL' | 'NEUTRAL' | 'BEAR' | 'STRONG_BEAR';
  contextCoverage?: number;
  contextFactors?: import('../types/setup-context.types').ContextFactorBreakdown[];
}

export interface LockInput {
  token: string;
  symbol: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  setupType: 'BREAKOUT' | 'REVERSAL';
  levelType: SetupContext['levelType'];
  levelValue: number;
  entry: number;
  stoploss: number;
  target: number;
  partialTakeAt: number;
  grade: 'A' | 'B' | 'C';
  atr14: number;
  indicators: SetupContext['indicators'];
  higherTimeframeTrend: SetupContext['higherTimeframeTrend'];
  regime: SetupContext['regime'];
  intradayRangeRatio: number;
  reason: string;
  recommendedStrike?: RecommendedStrike | null;
  /** Source of the TP1 placement — see LockedSetup.tp1Source for context. */
  tp1Source?: 'obstacle' | 'fixed';
  tp1Obstacle?: {
    classification: 'STRONG' | 'MEDIUM';
    touchCount: number;
    nearEdge: number;
  } | null;
  /** Context-scoring fields propagated from analyze() into the locked setup. */
  contextScore?: number;
  contextTier?: 'STRONG_BULL' | 'BULL' | 'NEUTRAL' | 'BEAR' | 'STRONG_BEAR';
  contextCoverage?: number;
  contextFactors?: import('../types/setup-context.types').ContextFactorBreakdown[];
}

const EOD_AGE_MS = 8 * 60 * 60 * 1000;
const HISTORY_CAP_PER_TOKEN = 20;
/**
 * Persist mfeR/maeR/barsSinceEntry to DB every N ticks while ACTIVE/
 * PARTIAL_BOOKED, in addition to every status transition. Keeps DB
 * write volume low while still capturing intra-setup excursion data.
 */
const PERSIST_TICK_INTERVAL = 5;

/**
 * Adaptive-invalidation thresholds. The structural retrace check only
 * fires once MFE has reached this fraction of an R — below that, the
 * setup hasn't really had its chance and we let the original SL do its
 * job. The time-MFE check declares a setup "stagnant" if it's been
 * ACTIVE for TIME_MFE_BARS bars without ever clocking
 * TIME_MFE_PROGRESS_R of MFE. TIMEFRAME_MS is the strategy bar width;
 * the strategy runs on 15m candles.
 */
const MFE_STRUCTURAL_TRIGGER_R = 0.5;
const TIME_MFE_BARS = 8;
const TIME_MFE_PROGRESS_R = 0.5;
const TIMEFRAME_MS = 15 * 60 * 1000;

const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MINUTE = 0;
const NSE_CLOSE_HOUR = 15;
const NSE_CLOSE_MINUTE = 30;
const MCX_CLOSE_HOUR = 23;
const MCX_CLOSE_MINUTE = 30;

@Injectable()
export class SetupTrackerService {
  private readonly logger = new Logger(SetupTrackerService.name);
  private readonly active = new Map<string, LockedSetup>();
  private readonly history = new Map<string, LockedSetup[]>();

  constructor(
    private readonly marketFeed: MarketFeedService,
    @Optional() private readonly setupRepo: SetupRepository | null = null,
  ) {}

  /**
   * Map the in-memory `SetupStatus` close enum onto the persisted
   * `closeReason` taxonomy. Persisted strings live in the spec for
   * forensics queries (filterable by closeReason).
   */
  private mapCloseReason(
    status: SetupStatus,
    invalidationKind:
      | 'structural'
      | 'counter-setup'
      | 'time-mfe'
      | null,
  ): string | null {
    if (status === 'TARGET_HIT') return 'TARGET_HIT';
    if (status === 'STOPPED') return 'SL_HIT';
    if (status === 'TRAIL_STOPPED') return 'TRAIL_STOP';
    if (status === 'EOD') return 'EOD';
    if (status === 'INVALIDATED') {
      switch (invalidationKind) {
        case 'structural':
          return 'INVALIDATED_STRUCTURAL';
        case 'counter-setup':
          return 'INVALIDATED_COUNTER';
        case 'time-mfe':
          return 'INVALIDATED_TIME_MFE';
        default:
          return 'MANUAL';
      }
    }
    return null;
  }

  /**
   * Map the in-memory `SetupStatus` to the persisted `status` enum the
   * spec defines (PENDING | ACTIVE | PARTIAL_BOOKED | CLOSED |
   * INVALIDATED). Open statuses round-trip; all close statuses except
   * INVALIDATED collapse to CLOSED.
   */
  private mapPersistedStatus(status: SetupStatus): string {
    if (
      status === 'PENDING' ||
      status === 'ACTIVE' ||
      status === 'PARTIAL_BOOKED' ||
      status === 'INVALIDATED'
    ) {
      return status;
    }
    return 'CLOSED';
  }

  /**
   * Coerce token (string in-memory) to int for the DB column. Tokens
   * coming from Angel One are always digit strings. If parse fails we
   * fall back to 0 — the row's `symbol` still tells us what it was.
   */
  private tokenToInt(token: string): number {
    const n = Number.parseInt(token, 10);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Best-effort persistence helper — wraps the call so any DB hiccup
   * never blocks the tracker. Logs at warn level.
   */
  private async safePersist(
    op: string,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    if (!this.setupRepo) return;
    try {
      await fn();
    } catch (err) {
      this.logger.warn(
        `Setup persistence ${op} failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  getActive(token: string): LockedSetup | null {
    return this.active.get(token) ?? null;
  }

  getHistory(token: string): LockedSetup[] {
    return this.history.get(token) ?? [];
  }

  lock(input: LockInput): LockedSetup | null {
    const existing = this.active.get(input.token);
    if (existing && this.isOpen(existing.status)) {
      return null;
    }
    const now = new Date();
    const setup: LockedSetup = {
      id: randomUUID(),
      token: input.token,
      symbol: input.symbol,
      exchange: input.exchange,
      side: input.side,
      setupType: input.setupType,
      levelType: input.levelType,
      levelValue: input.levelValue,
      entry: input.entry,
      stoploss: input.stoploss,
      target: input.target,
      partialTakeAt: input.partialTakeAt,
      trailingSl: null,
      grade: input.grade,
      atr14: input.atr14,
      status: 'PENDING',
      createdAt: now,
      triggeredAt: null,
      partialBookedAt: null,
      runnerExitAt: null,
      closedAt: null,
      closeReason: null,
      high: input.entry,
      low: input.entry,
      indicators: input.indicators,
      higherTimeframeTrend: input.higherTimeframeTrend,
      regime: input.regime,
      intradayRangeRatio: input.intradayRangeRatio,
      reason: input.reason,
      recommendedStrike: input.recommendedStrike ?? null,
      invalidationKind: null,
      invalidationReason: null,
      mfeR: 0,
      maeR: 0,
      triggerBarTimestamp: null,
      barsSinceEntry: 0,
      dbId: null,
      ticksSinceLastPersist: 0,
      tp1Source: input.tp1Source,
      tp1Obstacle: input.tp1Obstacle ?? null,
      contextScore: input.contextScore,
      contextTier: input.contextTier,
      contextCoverage: input.contextCoverage,
      contextFactors: input.contextFactors,
    };
    this.active.set(input.token, setup);
    this.logger.log(
      `Locked ${input.side} ${input.setupType} ${input.symbol} entry=${input.entry.toFixed(2)} sl=${input.stoploss.toFixed(2)} tgt=${input.target.toFixed(2)} grade=${input.grade}`,
    );

    // Best-effort persist — tracker stays usable even if the DB write
    // fails. We capture dbId synchronously so subsequent updates can
    // patch the row.
    if (this.setupRepo) {
      void this.setupRepo
        .create({
          token: this.tokenToInt(input.token),
          symbol: input.symbol,
          exchange: input.exchange,
          side: input.side,
          setupType: input.setupType,
          levelType: input.levelType,
          levelValue: input.levelValue,
          entry: input.entry,
          stoploss: input.stoploss,
          target: input.target,
          partialTakeAt: input.partialTakeAt ?? null,
          grade: input.grade,
          atr14: input.atr14 ?? null,
          regime: input.regime ?? null,
          intradayRangeRatio: input.intradayRangeRatio ?? null,
          higherTimeframeTrend: (input.higherTimeframeTrend ?? null) as
            | Prisma.InputJsonValue
            | null,
          recommendedStrike: (input.recommendedStrike ?? null) as
            | Prisma.InputJsonValue
            | null,
          reason: input.reason,
          status: 'PENDING',
          lockedAt: now,
        })
        .then((row) => {
          setup.dbId = row.id;
        })
        .catch((err) => {
          this.logger.warn(
            `Setup persistence create failed: ${
              err instanceof Error ? err.message : err
            }`,
          );
        });
    }

    return setup;
  }

  updateFromTick(token: string, spot: number, now: Date): LockedSetup | null {
    const setup = this.active.get(token);
    if (!setup) return null;
    if (!this.isOpen(setup.status)) return setup;

    if (spot > setup.high) setup.high = spot;
    if (spot < setup.low) setup.low = spot;

    // Age-based EOD check first — closes setups that have run past
    // their daily horizon regardless of spot.
    if (now.getTime() - setup.createdAt.getTime() >= EOD_AGE_MS) {
      this.close(setup, 'EOD', now);
      return setup;
    }
    if (this.sessionEnded(setup.exchange, now)) {
      this.close(setup, 'EOD', now);
      return setup;
    }

    if (setup.status === 'PENDING') {
      const triggered =
        setup.side === 'BUY' ? spot >= setup.entry : spot <= setup.entry;
      if (triggered) {
        setup.status = 'ACTIVE';
        setup.triggeredAt = now;
        setup.triggerBarTimestamp = now;
        this.logger.log(
          `Setup ${setup.id} (${setup.symbol}) triggered at ${spot.toFixed(2)} → ACTIVE`,
        );
        // Status transition → flush.
        this.persistTickUpdate(setup, /* force */ true);
      }
      return setup;
    }

    // ── Adaptive invalidation ──────────────────────────────────────
    // Run BEFORE the existing target/SL/partial-take logic so an
    // early-exit short-circuit can close the setup before the original
    // SL gets hit. Only kicks in once we're past PENDING — no entry
    // means no MFE concept.
    if (setup.status === 'ACTIVE' || setup.status === 'PARTIAL_BOOKED') {
      const slDist = Math.abs(setup.entry - setup.stoploss);
      const safeSlDist = Math.max(slDist, 1e-6);

      // (A) Structural — track MFE in R units and bail if spot
      // retraces back through entry after we've already seen meaningful
      // MFE. This is the "market briefly went our way then reversed"
      // case the user reported.
      const mfe =
        setup.side === 'BUY'
          ? (Math.max(setup.high, spot) - setup.entry) / safeSlDist
          : (setup.entry - Math.min(setup.low, spot)) / safeSlDist;
      if (mfe > setup.mfeR) setup.mfeR = mfe;

      // (D) Max-adverse-excursion tracking — symmetric counterpart to
      // mfeR. Captures how far against the setup spot has moved at any
      // point. Pure forensics — does not influence any close decision.
      const mae =
        setup.side === 'BUY'
          ? (setup.entry - Math.min(setup.low, spot)) / safeSlDist
          : (Math.max(setup.high, spot) - setup.entry) / safeSlDist;
      if (mae > setup.maeR) setup.maeR = mae;

      const retracedThroughEntry =
        setup.side === 'BUY' ? spot <= setup.entry : spot >= setup.entry;
      if (
        setup.mfeR >= MFE_STRUCTURAL_TRIGGER_R &&
        retracedThroughEntry
      ) {
        const reason = `Spot retraced through entry after ${setup.mfeR.toFixed(2)}×R MFE — momentum failed`;
        this.close(setup, 'INVALIDATED', now, 'structural', reason);
        return setup;
      }

      // (C) Time-MFE — setup has been ACTIVE for too many bars
      // without making meaningful progress. No follow-through ⇒ exit
      // before the original SL hits.
      const triggerMs =
        setup.triggerBarTimestamp?.getTime() ?? now.getTime();
      const elapsedMs = now.getTime() - triggerMs;
      const barsSinceEntry = Math.floor(elapsedMs / TIMEFRAME_MS);
      // Mirror to LockedSetup so close() can persist the final value.
      setup.barsSinceEntry = barsSinceEntry;
      if (
        barsSinceEntry >= TIME_MFE_BARS &&
        setup.mfeR < TIME_MFE_PROGRESS_R
      ) {
        const reason = `${barsSinceEntry} bars elapsed with only ${setup.mfeR.toFixed(2)}×R MFE — no follow-through`;
        this.close(setup, 'INVALIDATED', now, 'time-mfe', reason);
        return setup;
      }
    }

    // Order matters: TARGET wins over the partial-take check on the same
    // tick (best-case outcome — full target reached before booking 50%),
    // and PARTIAL_BOOKED happens before SL because once we're at 1×SL
    // profit the stop ratchets to break-even and the original SL is moot.
    if (setup.status === 'ACTIVE') {
      if (setup.side === 'BUY') {
        if (spot >= setup.target) {
          this.close(setup, 'TARGET_HIT', now);
          return setup;
        }
        if (spot >= setup.partialTakeAt) {
          this.bookPartial(setup, now);
          return setup;
        }
        if (spot <= setup.stoploss) {
          this.close(setup, 'STOPPED', now);
        }
      } else {
        if (spot <= setup.target) {
          this.close(setup, 'TARGET_HIT', now);
          return setup;
        }
        if (spot <= setup.partialTakeAt) {
          this.bookPartial(setup, now);
          return setup;
        }
        if (spot >= setup.stoploss) {
          this.close(setup, 'STOPPED', now);
        }
      }
      return setup;
    }

    // PARTIAL_BOOKED: target still wins, otherwise ratchet trailing-SL
    // and exit the runner if it crosses.
    if (setup.status === 'PARTIAL_BOOKED') {
      const slDist = Math.abs(setup.entry - setup.stoploss);
      if (setup.side === 'BUY') {
        if (spot >= setup.target) {
          this.close(setup, 'TARGET_HIT', now);
          return setup;
        }
        // Trail 1×SL behind spot, never letting trailingSl move backward.
        const candidate = spot - slDist;
        if (setup.trailingSl == null || candidate > setup.trailingSl) {
          setup.trailingSl = candidate;
        }
        if (setup.trailingSl != null && spot <= setup.trailingSl) {
          setup.runnerExitAt = now;
          this.close(setup, 'TRAIL_STOPPED', now);
        }
      } else {
        if (spot <= setup.target) {
          this.close(setup, 'TARGET_HIT', now);
          return setup;
        }
        const candidate = spot + slDist;
        if (setup.trailingSl == null || candidate < setup.trailingSl) {
          setup.trailingSl = candidate;
        }
        if (setup.trailingSl != null && spot >= setup.trailingSl) {
          setup.runnerExitAt = now;
          this.close(setup, 'TRAIL_STOPPED', now);
        }
      }
    }

    // Debounced persistence of MFE/MAE/barsSinceEntry — every Nth tick
    // while ACTIVE/PARTIAL_BOOKED. Status transitions and close paths
    // flush separately, so this only fires on intra-state ticks.
    if (
      this.isOpen(setup.status) &&
      setup.status !== 'PENDING'
    ) {
      setup.ticksSinceLastPersist += 1;
      if (setup.ticksSinceLastPersist >= PERSIST_TICK_INTERVAL) {
        this.persistTickUpdate(setup, /* force */ false);
      }
    }
    return setup;
  }

  private bookPartial(setup: LockedSetup, now: Date): void {
    setup.status = 'PARTIAL_BOOKED';
    setup.partialBookedAt = now;
    // Anchor trailing-SL at entry (break-even) — guarantees the runner
    // can't turn the booked half into a net loss.
    setup.trailingSl = setup.entry;
    this.logger.log(
      `Setup ${setup.id} (${setup.symbol}) 50% booked at ${setup.partialTakeAt.toFixed(2)} → PARTIAL_BOOKED, trailingSl=${setup.entry.toFixed(2)}`,
    );
    // Status transition → flush.
    this.persistTickUpdate(setup, /* force */ true);
  }

  /**
   * Push the current mutable LockedSetup snapshot (status, mfeR, maeR,
   * barsSinceEntry, trigger timestamps) to the persisted Setup row.
   * Best-effort — logs and swallows DB errors.
   *
   * `force` resets the tick counter unconditionally; non-force callers
   * are expected to pre-check the threshold themselves.
   */
  private persistTickUpdate(setup: LockedSetup, force: boolean): void {
    setup.ticksSinceLastPersist = 0;
    if (!setup.dbId || !this.setupRepo) return;
    const data: SetupUpdateInput = {
      status: this.mapPersistedStatus(setup.status),
      triggeredAt: setup.triggeredAt,
      triggerBarTimestamp: setup.triggerBarTimestamp,
      mfeR: setup.mfeR,
      maeR: setup.maeR,
      barsSinceEntry: setup.barsSinceEntry,
    };
    void this.safePersist('update', () =>
      this.setupRepo!.update(setup.dbId!, data),
    );
    // `force` is only here for symmetry with the caller intent —
    // the counter is already reset above. Kept as a parameter so
    // status-transition call sites read clearly at the call site.
    void force;
  }

  invalidate(
    token: string,
    reason?: string,
    kind: 'structural' | 'counter-setup' | 'time-mfe' | 'manual' | null = 'manual',
  ): void {
    const setup = this.active.get(token);
    if (!setup) return;
    if (!this.isOpen(setup.status)) return;
    // 'manual' is a logical-source tag for the LockedSetup contract we
    // expose: only the three adaptive-invalidation kinds are persisted
    // on the setup itself. A manual invalidate() leaves invalidationKind
    // null so consumers can distinguish "we bailed early" from "the
    // user / system flagged it stale".
    const persistedKind: 'structural' | 'counter-setup' | 'time-mfe' | null =
      kind === 'manual' || kind == null ? null : kind;
    this.close(setup, 'INVALIDATED', new Date(), persistedKind, reason ?? null);
    if (reason) {
      this.logger.log(`Setup ${setup.id} (${setup.symbol}) invalidated: ${reason}`);
    }
  }

  /**
   * Mark the active setup as invalidated because an OPPOSITE-side setup
   * just fired on the same token. Returns the closed setup if we
   * actually invalidated something, null when there's nothing active or
   * when the new side matches the existing side (no real conflict).
   *
   * Caller (signal-generator.service) is expected to invoke this BEFORE
   * its own lock() call — lock() short-circuits on an existing open
   * setup, so the conflict has to be resolved first.
   */
  flagCounterSetup(
    token: string,
    oppositeSide: 'BUY' | 'SELL',
    oppositeLevelType: string,
    oppositeReason: string,
  ): LockedSetup | null {
    const setup = this.active.get(token);
    if (!setup) return null;
    if (!this.isOpen(setup.status)) return null;
    // Only ACTIVE / PARTIAL_BOOKED count — a PENDING setup hasn't
    // committed to a direction yet, leave it alone.
    if (setup.status !== 'ACTIVE' && setup.status !== 'PARTIAL_BOOKED') {
      return null;
    }
    if (oppositeSide === setup.side) return null;
    const reason = `Counter ${oppositeSide} setup fired on ${oppositeLevelType}: ${oppositeReason}`;
    this.close(setup, 'INVALIDATED', new Date(), 'counter-setup', reason);
    return setup;
  }

  // Sweep is the safety-net: keeps PENDING/ACTIVE/PARTIAL_BOOKED setups
  // transitioning even when no analyze() call has come in for them lately.
  @Cron('*/30 * * * * *', { timeZone: 'Asia/Kolkata' })
  async sweep(): Promise<void> {
    if (this.active.size === 0) return;
    if (!this.marketFeed.isMarketOpen()) return;

    const now = new Date();
    for (const [token, setup] of this.active.entries()) {
      if (!this.isOpen(setup.status)) continue;
      const quote = this.marketFeed.getQuote(token);
      if (!quote) {
        // No live quote — can't evaluate against spot. Still check age.
        if (now.getTime() - setup.createdAt.getTime() >= EOD_AGE_MS) {
          this.close(setup, 'EOD', now);
        }
        continue;
      }
      this.updateFromTick(token, quote.ltp, now);
    }
  }

  // ─── internals ──────────────────────────────────────────────────

  private isOpen(status: SetupStatus): boolean {
    return (
      status === 'PENDING' ||
      status === 'ACTIVE' ||
      status === 'PARTIAL_BOOKED'
    );
  }

  private close(
    setup: LockedSetup,
    reason: SetupStatus,
    now: Date,
    invalidationKind:
      | 'structural'
      | 'counter-setup'
      | 'time-mfe'
      | null = null,
    invalidationReason: string | null = null,
  ): void {
    setup.status = reason;
    setup.closeReason = reason;
    setup.closedAt = now;
    if (invalidationKind) setup.invalidationKind = invalidationKind;
    if (invalidationReason) setup.invalidationReason = invalidationReason;

    // Refresh barsSinceEntry one last time so the persisted final value
    // matches the close moment (the time-mfe path already sets this,
    // but target/SL/EOD paths haven't).
    if (setup.triggerBarTimestamp) {
      setup.barsSinceEntry = Math.floor(
        (now.getTime() - setup.triggerBarTimestamp.getTime()) / TIMEFRAME_MS,
      );
    }

    this.active.delete(setup.token);
    const list = this.history.get(setup.token) ?? [];
    list.unshift(setup);
    if (list.length > HISTORY_CAP_PER_TOKEN) {
      list.length = HISTORY_CAP_PER_TOKEN;
    }
    this.history.set(setup.token, list);
    const tail = invalidationKind
      ? ` [${invalidationKind}: ${invalidationReason ?? ''}]`
      : '';
    this.logger.log(
      `Setup ${setup.id} (${setup.symbol}) closed: ${reason} high=${setup.high.toFixed(2)} low=${setup.low.toFixed(2)}${tail}`,
    );

    // Persist the close. Skips silently if create() never landed
    // (dbId === null) or if the repo isn't wired.
    if (setup.dbId && this.setupRepo) {
      const closeReasonStr = this.mapCloseReason(reason, invalidationKind);
      const data: SetupUpdateInput = {
        status: this.mapPersistedStatus(reason),
        closedAt: now,
        closeReason: closeReasonStr,
        invalidationKind,
        invalidationReason,
        mfeR: setup.mfeR,
        maeR: setup.maeR,
        barsSinceEntry: setup.barsSinceEntry,
        triggeredAt: setup.triggeredAt,
        triggerBarTimestamp: setup.triggerBarTimestamp,
      };
      void this.safePersist('close', () =>
        this.setupRepo!.update(setup.dbId!, data),
      );
    }
  }

  private sessionEnded(exchange: string, now: Date): boolean {
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const ist = new Date(now.getTime() + istOffsetMs);
    const weekday = ist.getUTCDay(); // 0=Sun, 6=Sat
    if (weekday === 0 || weekday === 6) return true;
    const hh = ist.getUTCHours();
    const mm = ist.getUTCMinutes();
    const totalMin = hh * 60 + mm;
    const openMin = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MINUTE;
    const closeMin =
      exchange === 'MCX'
        ? MCX_CLOSE_HOUR * 60 + MCX_CLOSE_MINUTE
        : NSE_CLOSE_HOUR * 60 + NSE_CLOSE_MINUTE;
    return totalMin < openMin || totalMin > closeMin;
  }
}
