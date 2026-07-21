// Re-export all shared types
export type {
  Quote,
  Candle,
  OIData,
  OptionsChainEntry,
  OptionData,
  OrderRequest,
  Position,
  PortfolioSummary,
  TradingSettings,
  AIInsight,
  NewsItem,
  TradeEvent,
  TradeEventType,
  RiskStatus,
} from '@td/shared';

import type { TradeSignal as SharedTradeSignal } from '@td/shared';

import type { Trade as SharedTrade } from '@td/shared';

export {
  Segment,
  Exchange,
  OrderType,
  OrderSide,
  PositionType,
  OptionType,
  SignalConfidence,
  TradeStatus,
  AutoTradeMode,
} from '@td/shared';

// M5: VIX regime label captured at trade entry.
export type VixRegime = 'LOW' | 'NORMAL' | 'ELEVATED' | 'HIGH' | 'UNKNOWN';

// M5: Structured exit-reason tag captured when a trade is closed.
export type ExitReasonTag =
  | 'HIT_TARGET'
  | 'STOPPED_OUT'
  | 'MOVED_STOP'
  | 'PANIC_EXIT'
  | 'TIME_EXIT'
  | 'REVERSAL_SEEN'
  | 'OTHER';

// M5: Extends the shared Trade type with the new context-capture and
// exit-reason fields. Kept here (rather than mutating @td/shared) so the
// frontend can adopt the new fields independently of the shared package's
// versioning.
export interface Trade extends SharedTrade {
  entryReason?: string | null;
  entryTags?: string[];
  spotAtEntry?: number | null;
  vixAtEntry?: number | null;
  vixRegimeAtEntry?: VixRegime | null;
  pcrAtEntry?: number | null;
  maxPainAtEntry?: number | null;
  adRatioAtEntry?: number | null;
  contextSnapshot?: Record<string, unknown> | null;
  exitReasonTag?: ExitReasonTag | null;
  exitNotes?: string | null;
}

// M5: Tag chip options shown on ExecuteTradeModal — the trader picks zero
// or more of these to characterise *why* they entered the trade. The
// free-text "Why this trade?" textarea handles anything not covered by
// these chips, so a "Custom" option would just duplicate that surface.
export const ENTRY_TAG_OPTIONS = [
  { value: 'OI_BUILDUP', label: 'OI buildup at S/R' },
  { value: 'VWAP_RECLAIM', label: 'VWAP reclaim' },
  { value: 'TREND_CONT', label: 'Trend continuation' },
  { value: 'REVERSAL', label: 'Reversal setup' },
  { value: 'RANGE_BREAK', label: 'Range break' },
  { value: 'EXPIRY_PIN', label: 'Expiry pin play' },
  { value: 'VOL_CRUSH', label: 'Volatility crush' },
  { value: 'NEWS_DRIVEN', label: 'News-driven' },
] as const;

// M5: Exit-reason picker options shown on ExitTradeModal. Values mirror
// the `ExitReasonTag` enum on the backend DTO — keep them in lockstep.
export const EXIT_REASON_OPTIONS: ReadonlyArray<{ value: ExitReasonTag; label: string }> = [
  { value: 'HIT_TARGET', label: 'Hit Target' },
  { value: 'STOPPED_OUT', label: 'Stopped Out' },
  { value: 'MOVED_STOP', label: 'Moved Stop (manual)' },
  { value: 'PANIC_EXIT', label: 'Panic / discretionary exit' },
  { value: 'TIME_EXIT', label: 'Time-based exit (e.g. close near EOD)' },
  { value: 'REVERSAL_SEEN', label: 'Saw reversal — exited early' },
  { value: 'OTHER', label: 'Other' },
] as const;

// Frontend-specific types

export type MarketStatus = 'open' | 'closed' | 'pre-market';

export interface WebSocketEvent<T = unknown> {
  event: string;
  data: T;
  timestamp: number;
}

export interface NavItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  badge?: string;
}

// Levels-context strategy: structured signal payload.
// Mirrors apps/api/src/modules/signal-generator/types/setup-context.types.ts —
// keep them in lockstep.
export type LevelType =
  | 'PDH' | 'PDL' | 'ORH' | 'ORL'
  | 'VWAP' | 'ROUND' | 'VOL_STRIKE'
  | 'STRONG_ZONE';

// Strong-Zone Reversal strategy (2026-05-03 design spec): zone detector +
// reversal trigger. Mirrors the backend `StrongZone` and
// `ZoneScoreBreakdown` types in
// apps/api/src/modules/signal-generator/types/zone.types.ts — keep in lockstep.
export interface ZoneScoreBreakdown {
  touchCount: number;        // 0-100 score for this dimension
  reversalScore: number;     // 0-100
  volumeScore: number;       // 0-100
  recencyScore: number;      // 0-100
  confluenceBonus: number;   // 0-100
  wickDensity: number;       // 0-100
}

export interface StrongZone {
  id: string;                // stable id (token + zone center hash)
  token: string;             // instrument token
  symbol: string;
  exchange: string;
  type: 'support' | 'resistance';
  upper: number;             // zone top price
  lower: number;             // zone bottom price (== upper if isLine)
  isLine: boolean;           // true = single horizontal line, false = band
  strength: number;          // 0-100 normalized
  classification: 'STRONG' | 'MEDIUM' | 'WEAK';
  touchCount: number;
  lastTouchTimestamp: number; // unix ms
  scoreBreakdown: ZoneScoreBreakdown;
  computedAt: number;
  expiresAt: number;          // when to recompute
  /**
   * Set when the backend detector observed an impulsive close beyond the
   * zone's wall edge. `type` reflects the post-flip polarity; `wasType`
   * carries the pre-flip polarity; `preFlipTouchCount` carries the
   * touchCount before the half-credit recomputation. All optional.
   */
  flippedAt?: number;
  wasType?: 'support' | 'resistance';
  preFlipTouchCount?: number;
}
export type SetupType = 'BREAKOUT' | 'REVERSAL';
export type SetupGrade = 'A' | 'B' | 'C';
export type TimeOfDayWindow = 'morning-trend' | 'afternoon-trend';

// Adaptive-invalidation kinds emitted by the backend's three new
// auto-teardown mechanisms. Kept in lockstep with `SetupAnalysis` in
// AnalysisPanel.tsx so the wire contract is single-sourced.
export type InvalidationKind = 'structural' | 'counter-setup' | 'time-mfe';

// ─── Context scoring ────────────────────────────────────────
// Mirrors apps/api/src/modules/signal-generator/types/setup-context.types.ts
// (Tier / CombinedTier / ContextFactorBreakdown). Keep in lockstep with the
// backend — those types are the wire contract.

/** Subset of Tier valid for the combined contextTier — never NEUTRAL_STUB. */
export type CombinedTier =
  | 'STRONG_BULL'
  | 'BULL'
  | 'NEUTRAL'
  | 'BEAR'
  | 'STRONG_BEAR';

/** Per-factor tier label. NEUTRAL_STUB only appears on stub factors. */
export type Tier = CombinedTier | 'NEUTRAL_STUB';

export interface ContextFactorBreakdown {
  name: string;
  weight: number;
  tier: Tier;
  value: number;
  contribution: number;
  isStub: boolean;
  detail?: Record<string, unknown>;
}

export interface SetupContext {
  levelType: LevelType;
  setupType: SetupType;
  levelValue: number;
  grade: SetupGrade;
  entry: number;
  stoploss: number;
  target: number;
  triggerCandle: { time: number; ohlc: [number, number, number, number] };
  levelBookSnapshot: {
    pdh: number; pdl: number;
    orh: number | null; orl: number | null;
    vwap: number; todayHigh: number; todayLow: number;
  };
  atr14: number;
  volumeRatio: number;
  timeOfDayWindow: TimeOfDayWindow;
  expiryDayWarning?: boolean;
  // Adaptive-invalidation surface. Populated only when the locked setup
  // was auto-torn-down mid-trade by structural / counter-setup / time-MFE
  // mechanisms. Nested under setupContext (rather than at the TradeSignal
  // root) because (a) the data is conceptually part of the setup
  // lifecycle, (b) only level-context signals carry locked setups today,
  // and (c) co-locating with the setup fields keeps the discriminant
  // (`setupType`) and the invalidation reason on the same object — the
  // SignalCard already gates the whole setup-context block on
  // `setupContext.setupType` truthiness.
  invalidationKind?: InvalidationKind | null;
  invalidationReason?: string | null;
  tp1Source?: 'obstacle' | 'fixed';
  tp1Obstacle?: {
    classification: 'STRONG' | 'MEDIUM';
    touchCount: number;
    nearEdge: number;
  } | null;
  // ──────────────────────────────────────────────────────────────────
  // Context scoring (Mama's 10-factor framework). All four optional —
  // older signals returned by the API will not have them, so the UI
  // must guard with truthy checks before rendering the Context section.
  // ──────────────────────────────────────────────────────────────────
  /** Aggregated alignment score, -100 (counter) to +100 (supportive). */
  contextScore?: number;
  /** Tier label derived from contextScore. Never `NEUTRAL_STUB`. */
  contextTier?: CombinedTier;
  /** Real-factor weight coverage, 0.0 to 1.0. */
  contextCoverage?: number;
  /** Per-factor breakdown (name, weight, tier, value, contribution, isStub). */
  contextFactors?: ContextFactorBreakdown[];
}

export interface TradeSignal extends SharedTradeSignal {
  setupContext?: SetupContext | null;
  /**
   * Per-lot rupee amounts. Backend computes these as
   * `expectedProfit * instrument.lotSize` and `expectedLoss * instrument.lotSize`.
   * Optional so a stale build that hasn't been redeployed still renders the
   * pre-existing per-share fallback. Equity instruments (`lotSize=1`) end up
   * with the same number as per-share — that's correct, not a bug.
   */
  lotSize?: number;
  expectedProfitPerLot?: number | null;
  expectedLossPerLot?: number | null;
  /**
   * Provenance tag for setups generated by a Chartink scanner webhook
   * hit (rather than the cron-driven signal-scan worker). Optional /
   * nullable so cron-fired setups still serialize cleanly. The
   * SignalCard renders a small badge linking back to /chartink when
   * present.
   */
  chartinkSource?: ChartinkSourceRef | null;
}

// ─── Chartink ────────────────────────────────────────────────

export interface ChartinkScanner {
  id: string;
  scanUrl: string;
  scanName: string;
  alertName: string | null;
  firstSeenAt: string;
  lastFiredAt: string | null;
  fireCount: number;
}

export interface ChartinkAlertSetup {
  id: string;
  alertId: string;
  symbol: string;
  token: string | null;
  hitPrice: number;
  kind: 'setup' | 'no-setup' | 'unresolved' | 'error';
  setupId: string | null;
  rejectReason: string | null;
  processedAt: string;
  score?: number | null;
  lotCount?: 0 | 1 | 2 | 3 | null;
  scoreBreakdown?: Array<{
    name: string;
    points: number;
    pointsPossible: number;
    passed: boolean;
    detail?: Record<string, unknown>;
  }> | null;
}

export interface ChartinkAlert {
  id: string;
  scannerId: string;
  triggeredAt: string;
  receivedAt: string;
  rawPayload: unknown;
  scanner?: { scanName: string; scanUrl: string };
  setups?: ChartinkAlertSetup[];
}

export interface ChartinkSourceRef {
  scannerName: string;
  scannerUrl: string;
  alertId: string;
}

// --- Telegram signal scorecard (admin-only) --------------------------------
export interface TelegramChannel {
  id: string;
  tgChannelId: string;
  username: string | null;
  title: string;
  isActive: boolean;
  addedAt: string;
}
export interface ChannelScorecard {
  channelId: string;
  title: string;
  total: number;
  wins: number;
  losses: number;
  expired: number;
  untrackable: number;
  winRate: number | null;
  avgResultPct: number | null;
}
export interface TelegramSignalRow {
  id: string;
  symbol: string;
  instrument: string;
  side: string;
  signalType: string;
  status: string;
  resultPct: number | null;
  createdAt: string;
  message?: { rawText: string; postedAt: string };
}

// Evidence-weighted S/R (mirrors apps/api .../types/evidence-level.types.ts).
export type EvidenceKind =
  | 'VOLUME' | 'HISTORY' | 'OI_CALL' | 'OI_PUT' | 'ROUND'
  | 'POC' | 'VALUE_AREA' | 'MA' | 'AVWAP' | 'GAP' | 'FIB' | 'MAX_PAIN' | 'OI_CHANGE';
export interface EvidenceLevel {
  price: number;
  side: 'resistance' | 'support';
  score: number;
  kinds: EvidenceKind[];
  soft: boolean;
  distancePct: number;
}
