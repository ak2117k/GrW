import type { LevelType, SetupType } from '../types/setup-context.types';
import type { EvidenceLevel } from '../types/evidence-level.types';
import type { StrongZone } from '../types/zone.types';
import type { AnalyzeResult, LevelsSnapshot } from './signal-generator.service';

/**
 * The ONE trade plan the chart draws and the card reads.
 *
 * See docs/superpowers/specs/2026-08-07-trade-plan-design.md §3.1.
 *
 * Everything in this file is pure: no IO, no clock, no DI. It is a projection
 * of what /chart-context already fetched, which is the property that makes the
 * drawn lines and the card's trigger levels the same object — they cannot
 * disagree because there is only one computation.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared setup arithmetic
//
// This is the entry/SL/target math the LIVE setup path runs. It used to be a
// private method on LevelsContextStrategy; it lives here now and the strategy
// delegates to it, so a PENDING trigger and the trade it becomes are computed
// by the same lines of code rather than by two implementations free to drift.
// Nothing about the numbers changed in the move.
// ─────────────────────────────────────────────────────────────────────────────

/** Breakout trigger offset: entry sits this far past the level. */
export const BREAKOUT_BODY_ATR = 0.15;
/** SL sits this far on the wrong side of the level (direction-aware). */
export const SL_BUFFER_ATR = 0.25;
/** Minimum reward:risk a setup must clear to be tradeable. */
export const RR_FLOOR_STRICT = 2.0;
/** TP1 stands off an obstacle zone by this much ATR. */
const TP1_OBSTACLE_BUFFER_ATR = 0.1;
/** An obstacle-derived TP1 closer than this many R is not worth taking. */
const MIN_TP1_R = 0.4;

export interface CandidateLevel {
  type: LevelType;
  value: number;
}

/** The anchored fields every candidate list is collected from. */
export interface LevelSource {
  pdh: number;
  pdl: number;
  vwap: number;
  orh: number | null;
  orl: number | null;
  roundNumbers?: number[];
  topVolStrikes?: number[];
}

/**
 * The scannable level set, in the strategy's original iteration order.
 *
 * Order is load-bearing twice over: `analyze()` takes the FIRST level that
 * confirms, and target selection sorts by distance with a stable sort, so a
 * reordering here would silently change which level a setup fires on.
 */
export function collectLevelCandidates(book: LevelSource): CandidateLevel[] {
  const out: CandidateLevel[] = [
    { type: 'PDH', value: book.pdh },
    { type: 'PDL', value: book.pdl },
    { type: 'VWAP', value: book.vwap },
  ];
  if (book.orh !== null && book.orh !== undefined) out.push({ type: 'ORH', value: book.orh });
  if (book.orl !== null && book.orl !== undefined) out.push({ type: 'ORL', value: book.orl });
  for (const r of book.roundNumbers ?? []) out.push({ type: 'ROUND', value: r });
  for (const s of book.topVolStrikes ?? []) out.push({ type: 'VOL_STRIKE', value: s });
  return out.filter((l) => Number.isFinite(l.value) && l.value > 0);
}

export interface SetupPrices {
  entry: number;
  stoploss: number;
  target: number;
  partialTakeAt: number;
  tp1Source: 'obstacle' | 'fixed';
  tp1Obstacle: { classification: 'STRONG' | 'MEDIUM'; touchCount: number; nearEdge: number } | null;
}

/**
 * Entry / SL / target / TP1 for one candidate level.
 *
 * `triggerClose` is the close of the confirming bar and is required ONLY for
 * REVERSAL setups, whose entry is that close. A BREAKOUT's entry is derived
 * from the level and ATR alone, which is exactly why a breakout can be planned
 * forward before any bar has confirmed it.
 *
 * Returns null when the stop distance collapses to zero (degenerate ATR).
 */
export function computeSetupPrices(args: {
  setupType: SetupType;
  isLong: boolean;
  level: number;
  atr: number;
  candidates: CandidateLevel[];
  triggerClose?: number;
  zones?: StrongZone[];
}): SetupPrices | null {
  const { setupType, isLong, level, atr, candidates, triggerClose, zones = [] } = args;
  const buffer = SL_BUFFER_ATR * atr;

  let entry: number;
  if (setupType === 'BREAKOUT') {
    const trigger = BREAKOUT_BODY_ATR * atr;
    entry = isLong ? level + trigger : level - trigger;
  } else {
    if (triggerClose === undefined) return null;
    entry = triggerClose;
  }

  const stoploss = isLong ? level - buffer : level + buffer;
  const slDist = Math.abs(entry - stoploss);
  if (slDist <= 0) return null;
  const minTargetDist = 2 * slDist;

  const opposing = candidates
    .filter((c) => (isLong ? c.value > entry : c.value < entry))
    .sort((a, b) => Math.abs(a.value - entry) - Math.abs(b.value - entry));
  const target =
    opposing.length > 0 && Math.abs(opposing[0].value - entry) >= minTargetDist
      ? opposing[0].value
      : isLong
        ? entry + minTargetDist
        : entry - minTargetDist;

  const defaultTp1 = isLong ? entry + slDist : entry - slDist;

  // Obstacle-aware TP1. See docs/superpowers/specs/2026-05-05-tp1-at-obstacle-design.md §Algorithm.
  const obstacleBuffer = TP1_OBSTACLE_BUFFER_ATR * atr;

  const obstacleCandidates = zones
    .filter(
      (z) => (z.classification === 'STRONG' || z.classification === 'MEDIUM') && z.touchCount >= 3,
    )
    .map((z) => ({
      classification: z.classification as 'STRONG' | 'MEDIUM',
      touchCount: z.touchCount,
      nearEdge: isLong ? z.lower : z.upper,
    }))
    .filter((z) =>
      isLong ? z.nearEdge > entry && z.nearEdge < target : z.nearEdge < entry && z.nearEdge > target,
    );

  const closest = isLong
    ? obstacleCandidates.reduce<(typeof obstacleCandidates)[number] | null>(
        (best, z) => (best === null || z.nearEdge < best.nearEdge ? z : best),
        null,
      )
    : obstacleCandidates.reduce<(typeof obstacleCandidates)[number] | null>(
        (best, z) => (best === null || z.nearEdge > best.nearEdge ? z : best),
        null,
      );

  let partialTakeAt = defaultTp1;
  let tp1Source: 'obstacle' | 'fixed' = 'fixed';
  let tp1Obstacle:
    | { classification: 'STRONG' | 'MEDIUM'; touchCount: number; nearEdge: number }
    | null = null;

  if (closest) {
    const rawObstacleTp1 = isLong
      ? closest.nearEdge - obstacleBuffer
      : closest.nearEdge + obstacleBuffer;
    const clampedTp1 = isLong
      ? Math.min(rawObstacleTp1, target - 1e-6)
      : Math.max(rawObstacleTp1, target + 1e-6);
    const obstacleR = Math.abs(clampedTp1 - entry) / slDist;
    if (obstacleR >= MIN_TP1_R) {
      partialTakeAt = clampedTp1;
      tp1Source = 'obstacle';
      tp1Obstacle = {
        classification: closest.classification,
        touchCount: closest.touchCount,
        nearEdge: closest.nearEdge,
      };
    }
  }

  return { entry, stoploss, target, partialTakeAt, tp1Source, tp1Obstacle };
}

/** Reward:risk. Derived, never hand-set. */
export function rewardRisk(entry: number, stoploss: number, target: number): number {
  return Math.abs(target - entry) / Math.max(Math.abs(entry - stoploss), 1e-6);
}

// ─────────────────────────────────────────────────────────────────────────────
// TradePlan
// ─────────────────────────────────────────────────────────────────────────────

export interface TradeTrigger {
  side: 'BUY' | 'SELL';
  /** The price that arms this trade. Also the line drawn on the chart. */
  triggerPrice: number;
  /** Which level it is: 'PDH' | 'PDL' | 'ORH' | 'ORL' | 'ROUND' | 'MA' | 'AVWAP' | 'PIVOT'. */
  levelSource: string;
  entry: number;
  stoploss: number;
  target: number;
  /** Reward:risk, e.g. 2.0. Computed, never hand-set. */
  rr: number;
  /** 'active' = conditions met now. 'pending' = would trigger if reached. */
  state: 'active' | 'pending';
  /** One plain sentence. No JSON, no debug payloads. */
  reason: string;
}

export interface TradePlan {
  /** A setup formed right now, if any. */
  active: TradeTrigger | null;
  /** Nearest untriggered LONG above spot. */
  above: TradeTrigger | null;
  /** Nearest untriggered SHORT below spot. */
  below: TradeTrigger | null;
}

export interface BuildTradePlanInput {
  /** The whole /analyze result. `kind === 'setup'` is what populates `active`. */
  analysis: AnalyzeResult | null | undefined;
  /** Anchored level snapshot from that same result. */
  levels: LevelsSnapshot | null | undefined;
  /** Evidence-weighted levels. Colour for the reason sentence ONLY — see below. */
  evidence?: EvidenceLevel[] | null;
  /** Current spot. Decides which side of the plan each level falls on. */
  ltp: number | null | undefined;
  atr14: number | null | undefined;
  /**
   * The remaining scannable levels the live strategy sees but `LevelsSnapshot`
   * does not carry. Supplying them keeps the pending candidate set IDENTICAL to
   * the live one; omitting them narrows the set but never changes the maths.
   */
  roundNumbers?: number[];
  volStrikes?: number[];
  /** Active zones, for obstacle-aware TP1 parity with the live path. */
  zones?: StrongZone[];
}

const EMPTY_PLAN: TradePlan = { active: null, above: null, below: null };

/**
 * Build the plan. NEVER throws and NEVER fabricates: a side with no qualifying
 * level is `null`, which the card renders as "nothing set up on this side".
 *
 * Why evidence does not produce triggers: the live engine can only fire a setup
 * at an anchored/round/vol-strike level. A trigger drawn from an evidence level
 * would be a trade the engine will never actually take — a fabricated level by
 * another name. Evidence therefore only annotates the reason sentence.
 */
export function buildTradePlan(input: BuildTradePlanInput): TradePlan {
  try {
    return {
      active: buildActive(input),
      ...buildPending(input),
    };
  } catch {
    // A pure function that can't be trusted not to blow up the composite is
    // worse than one that admits it knows nothing. Spec §4.
    return EMPTY_PLAN;
  }
}

function buildActive(input: BuildTradePlanInput): TradeTrigger | null {
  const a = input.analysis;
  if (!a || a.kind !== 'setup') return null;
  const { entry, stoploss, target } = a;
  if (!isPrice(entry) || !isPrice(stoploss) || !isPrice(target)) return null;

  const rr = rewardRisk(entry, stoploss, target);
  return {
    side: a.side,
    // The level value itself isn't on AnalyzeResult; entry IS the price that
    // arms the trade, and it is what the chart already draws for a live setup.
    triggerPrice: entry,
    levelSource: a.levelType,
    entry,
    stoploss,
    target,
    rr,
    state: 'active',
    reason: sentence(
      `${a.side === 'BUY' ? 'Long' : 'Short'} ${describeSetup(a.setupType)} ${a.levelType} ` +
        `${fmt(entry)}: stop ${fmt(stoploss)}, target ${fmt(target)} (${fmtRr(rr)}), grade ${a.grade}.`,
    ),
  };
}

function buildPending(input: BuildTradePlanInput): { above: TradeTrigger | null; below: TradeTrigger | null } {
  const { levels, ltp, atr14 } = input;
  if (!levels || !isPrice(ltp) || !isPrice(atr14)) return { above: null, below: null };

  const candidates = collectLevelCandidates({
    pdh: levels.pdh,
    pdl: levels.pdl,
    vwap: levels.vwap,
    orh: levels.orh,
    orl: levels.orl,
    roundNumbers: input.roundNumbers,
    topVolStrikes: input.volStrikes,
  });

  const evidence = input.evidence ?? [];
  const aboveLevels = candidates
    .filter((c) => c.value > ltp)
    .sort((a, b) => a.value - b.value);
  const belowLevels = candidates
    .filter((c) => c.value < ltp)
    .sort((a, b) => b.value - a.value);

  return {
    above: firstQualifying(aboveLevels, true, atr14, candidates, evidence, input.zones),
    below: firstQualifying(belowLevels, false, atr14, candidates, evidence, input.zones),
  };
}

/**
 * Nearest level on this side that would actually produce a setup. "Would
 * produce" is not a guess: it is the same breakout arithmetic and the same R:R
 * floor the live path applies, so a level that could only ever be rejected is
 * skipped rather than shown as a trade.
 */
function firstQualifying(
  ordered: CandidateLevel[],
  isLong: boolean,
  atr: number,
  candidates: CandidateLevel[],
  evidence: EvidenceLevel[],
  zones: StrongZone[] | undefined,
): TradeTrigger | null {
  for (const lvl of ordered) {
    const prices = computeSetupPrices({
      setupType: 'BREAKOUT',
      isLong,
      level: lvl.value,
      atr,
      candidates,
      zones,
    });
    if (!prices) continue;
    const rr = rewardRisk(prices.entry, prices.stoploss, prices.target);
    if (!Number.isFinite(rr) || rr < RR_FLOOR_STRICT) continue;

    const side = isLong ? 'BUY' : 'SELL';
    return {
      side,
      triggerPrice: lvl.value,
      levelSource: lvl.type,
      entry: prices.entry,
      stoploss: prices.stoploss,
      target: prices.target,
      rr,
      state: 'pending',
      reason: sentence(
        `A close ${isLong ? 'above' : 'below'} ${lvl.type} ${fmt(lvl.value)} arms a ${side}: ` +
          `entry ${fmt(prices.entry)}, stop ${fmt(prices.stoploss)}, target ${fmt(prices.target)} ` +
          `(${fmtRr(rr)}).${evidenceNote(lvl.value, atr, evidence)}`,
      ),
    };
  }
  return null;
}

/** " Backed by evidence scoring 82." — or nothing at all. */
function evidenceNote(level: number, atr: number, evidence: EvidenceLevel[]): string {
  if (!Array.isArray(evidence) || evidence.length === 0 || atr <= 0) return '';
  const tolerance = 0.15 * atr;
  let best: EvidenceLevel | null = null;
  for (const e of evidence) {
    if (!isPrice(e?.price) || Math.abs(e.price - level) > tolerance) continue;
    if (best === null || e.score > best.score) best = e;
  }
  if (!best) return '';
  return ` Backed by evidence scoring ${Math.round(best.score)}.`;
}

function describeSetup(setupType: SetupType): string {
  return setupType === 'BREAKOUT' ? 'breakout of' : 'reversal at';
}

function isPrice(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function fmt(v: number): string {
  return v.toFixed(2);
}

function fmtRr(rr: number): string {
  return `1:${rr.toFixed(1)}`;
}

/**
 * Last line of defence on spec §3.3: the raw `reject:confirmation {...}` debug
 * string must never reach the UI. Every sentence above is composed from numbers
 * and enum labels, so this can only ever be a no-op — which is the point. If a
 * future edit interpolates an engine string in here, it gets stripped rather
 * than shipped to a trader.
 */
function sentence(text: string): string {
  return text
    .replace(/\breject:\S*/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
