import { isDerivativeSegment, type Segment, type Side } from '../charges';
import type { TripwireResult } from './tripwire.service';

/**
 * RE-JUDGE SUPPRESSION — a cost control on the two LEVEL-triggered sensors.
 *
 * `giveback-off-peak` and `volume-anomaly` are pure "is it true right now"
 * sensors: once a trade has given back 40 % (or GIVEBACK_N noise units), or the
 * last closed 15m bar was a 2x volume bar, they keep firing on EVERY pass until
 * the condition clears. Every judgement that finishes was therefore followed by
 * another one on an identical question. Prod 2026-10-17: 65 % of verdicts were
 * giveback-off-peak, 23 % volume-anomaly, with 1,320 verdicts producing 7 exits.
 *
 * The rule: a repeat of one of these two fires, on a position the judge has
 * already been asked about for that same fire, is dropped UNLESS something the
 * verdict could depend on changed — the cooldown elapsed, the quantity changed,
 * the contract's price moved by `priceMovePct` (for cash equity `priceMoveNEq`
 * noise units, else `priceMovePctEq`), the giveback found a new peak or
 * deepened by a noise-unit fraction, or a new volume bar closed.
 *
 * From 2026-10-22 `news-hit` (a headline id not yet shown to the judge) and
 * `level-break` (a different level) are gated the same way, and the flat
 * cooldown is replaced by the latest verdict's own `reviewIn` when one is known;
 * an armed-floor breach, an exitTrigger cross or a hard-risk window appearing
 * since the last judgement is always material (see repeatIsMaterial).
 *
 * What it can NEVER suppress: any wake that carries another sensor's fire
 * (exit-confirm, event-near, oi-wall-shift, a factor flip, carried fires) — the
 * decision then passes through whole, the gated fires included as context. Heartbeats are untouched. Hard exits are not on
 * this path at all: they live in the exit-discipline gate and the executor.
 *
 * Baselines are in-process memory (recorded only after a judgement on that fire
 * was RECORDED). A restart forgets them, which costs at most one extra call per
 * position — the safe direction.
 */

export const GIVEBACK_OFF_PEAK = 'giveback-off-peak';
export const VOLUME_ANOMALY = 'volume-anomaly';
/**
 * Material-change gating (2026-10-22, owner-approved): the legacy news sensor is
 * level-triggered too (it fires on every pass while ANY headline is < 30 min old —
 * prod 2026-10-19..21: 802 news-hit wakes), and level-break keeps firing while the
 * underlying sits beyond the same level. A repeat of either is material only when
 * something new arrived — a headline id the judge has not been shown, or a
 * DIFFERENT broken level — or on any of the generic rules in repeatIsMaterial.
 */
export const NEWS_HIT = 'news-hit';
export const LEVEL_BREAK = 'level-break';
export const SUPPRESSIBLE_FIRES: ReadonlySet<string> = new Set([GIVEBACK_OFF_PEAK, VOLUME_ANOMALY, NEWS_HIT, LEVEL_BREAK]);

export const REJUDGE_CONFIG = 'REJUDGE_CONFIG';

export interface RejudgeConfig {
  /** SENTINEL_REJUDGE_SUPPRESSION — default true; rollback is `false`. */
  enabled: boolean;
  /** SENTINEL_REJUDGE_COOLDOWN_MIN (default 10): an unchanged repeat is re-judged after this long anyway. */
  cooldownMs: number;
  /** SENTINEL_REJUDGE_PRICE_MOVE_PCT (default 0.02): contract-price move, either way, that is always material. */
  priceMovePct: number;
  /**
   * SENTINEL_REJUDGE_PRICE_MOVE_N_EQ (default 3): the same for a CASH equity
   * position, in the stock's own noise units (spec 2026-10-29 T3: half the
   * 6 N adverse-move bypass, the 1:2 ratio F&O has at 2 % : 4 %). 2 % is a
   * routine wobble for an option premium but a big session move for a stock,
   * so the F&O number would hold an equity's repeat fires back until the
   * cooldown almost every time. Applied only when the snapshot says the
   * segment is cash and carries a noise unit.
   */
  priceMoveNEq: number;
  /**
   * SENTINEL_REJUDGE_PRICE_MOVE_PCT_EQ (default 0.004): the cash-equity
   * fallback when no noise unit was measured — half the 0.8 % adverse-move
   * fallback, the same 1:2 ratio.
   */
  priceMovePctEq: number;
  /** SENTINEL_REJUDGE_GIVEBACK_DEEPEN_N (default 0.5): pullback deepening, in noise units, that is material. */
  givebackDeepenN: number;
  /** SENTINEL_REJUDGE_GIVEBACK_DEEPEN_FRAC (default 0.1): without a noise unit, deepening as a fraction of the peak excursion. */
  givebackDeepenFrac: number;
  /**
   * SENTINEL_REJUDGE_ROUTINE_TIER (default true): a repeat let through ONLY
   * because the cooldown elapsed — nothing the verdict depends on moved — is
   * asked at the ROUTINE tier. It is the heartbeat's question ("is this still
   * the same trade?") with the same fire attached as context, not a new claim,
   * so the FIRE tier's reason (a sensor asserting something new) does not apply.
   * Any material change, any other sensor, a carried fire or an exit-confirm
   * re-look keeps the FIRE tier. Rollback: `false`.
   */
  routineOnCooldown: boolean;
}

type Env = Record<string, string | undefined>;

function positive(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseRejudgeConfig(env: Env): RejudgeConfig {
  return {
    enabled: (env.SENTINEL_REJUDGE_SUPPRESSION ?? '').trim().toLowerCase() !== 'false',
    cooldownMs: positive(env.SENTINEL_REJUDGE_COOLDOWN_MIN, 10) * 60_000,
    priceMovePct: positive(env.SENTINEL_REJUDGE_PRICE_MOVE_PCT, 0.02),
    priceMoveNEq: positive(env.SENTINEL_REJUDGE_PRICE_MOVE_N_EQ, 3),
    priceMovePctEq: positive(env.SENTINEL_REJUDGE_PRICE_MOVE_PCT_EQ, 0.004),
    givebackDeepenN: positive(env.SENTINEL_REJUDGE_GIVEBACK_DEEPEN_N, 0.5),
    givebackDeepenFrac: positive(env.SENTINEL_REJUDGE_GIVEBACK_DEEPEN_FRAC, 0.1),
    routineOnCooldown: (env.SENTINEL_REJUDGE_ROUTINE_TIER ?? '').trim().toLowerCase() !== 'false',
  };
}

/** The facts a repeat is compared on. */
export interface RejudgeSnapshot {
  /** Cycle clock, epoch ms. */
  at: number;
  ltp: number;
  qty: number;
  /** Favourable extreme (holdingHigh long / holdingLow short); null when unknown. */
  peak: number | null;
  /** How far ltp is off that peak, in price; null when unknown. */
  pullback: number | null;
  /** Peak favourable excursion from entry, in price; null when unknown. */
  excursion: number | null;
  volumeRatio: number | null;
  /** The contract's noise unit when exit discipline measured one. */
  noiseN: number | null;
  /**
   * The position's segment, when the caller knew it. Cash equity selects the
   * equity price step (see priceMoveIsMaterial); absent (older callers, tests)
   * or F&O keeps `priceMovePct`.
   */
  segment?: Segment;
  /** level-break: the level the underlying is beyond (support for a long, resistance for a short); null when none / unknown. */
  level?: number | null;
  /** news-hit: fresh own-instrument headline ids the judge has NOT been shown yet; null when the feed gave no ids. */
  newsUnjudged?: number | null;
  /** news-hit fallback when no ids are known: the 30-minute headline count. */
  newsCount?: number | null;
  /** The armed floor (noise or fixed) is breached by ltp. Edge-material: false → true. */
  floorBreached?: boolean;
  /** The price is beyond the latest verdict's exitTrigger. Edge-material: false → true. */
  triggerCrossed?: boolean;
  /** A hard-risk window the cycle can see (intraday / expiry-day close). Edge-material: false → true. */
  hardRisk?: boolean;
  /**
   * Green-to-red (judge-gate.ts, 2026-10-29): the peak was net-green and the position is now at or
   * below breakeven. Edge-material: false → true, so the giveback repeat that crosses breakeven is
   * asked once — and, once a judgement on it is recorded, the baseline carries `true` and the
   * still-red repeats are back to the ordinary material-change rules.
   */
  greenToRed?: boolean;
}

/** Flags whose false → true transition since the last judgement is always new. */
const EDGE_FLAGS = ['floorBreached', 'triggerCrossed', 'hardRisk', 'greenToRed'] as const;

export function rejudgeSnapshot(
  t: {
    side: Side;
    entryPrice: number;
    ltp: number;
    qty: number;
    holdingHigh: number | null;
    holdingLow: number | null;
    volumeRatio: number | null;
    segment?: Segment;
  },
  noiseN: number | null,
  at: number,
): RejudgeSnapshot {
  const dir = t.side === 'LONG' ? 1 : -1;
  const rawPeak = t.side === 'LONG' ? t.holdingHigh : t.holdingLow;
  const peak = rawPeak !== null && Number.isFinite(rawPeak) ? rawPeak : null;
  return {
    at,
    ltp: t.ltp,
    qty: t.qty,
    peak,
    pullback: peak !== null && Number.isFinite(t.ltp) ? (peak - t.ltp) * dir : null,
    excursion: peak !== null && Number.isFinite(t.entryPrice) ? (peak - t.entryPrice) * dir : null,
    volumeRatio: t.volumeRatio !== null && Number.isFinite(t.volumeRatio) ? t.volumeRatio : null,
    noiseN: noiseN !== null && Number.isFinite(noiseN) && noiseN > 0 ? noiseN : null,
    // Spread only when known, so a caller that never passed one builds exactly
    // the snapshot it always did.
    ...(t.segment !== undefined ? { segment: t.segment } : {}),
  };
}

/**
 * The always-material price step, by segment: cash equity moves far less than a
 * premium. F&O / unknown: |move| >= `priceMovePct` of the last price — the rule
 * before cash was watched. Cash: >= `priceMoveNEq` noise units when either
 * snapshot carries one, else >= `priceMovePctEq`. `last.ltp` must be > 0.
 */
export function priceMoveIsMaterial(
  cfg: Pick<RejudgeConfig, 'priceMovePct' | 'priceMoveNEq' | 'priceMovePctEq'>,
  last: Pick<RejudgeSnapshot, 'ltp' | 'noiseN' | 'segment'>,
  now: Pick<RejudgeSnapshot, 'ltp' | 'noiseN' | 'segment'>,
): boolean {
  const move = Math.abs(now.ltp - last.ltp);
  const segment = now.segment ?? last.segment;
  if (segment === undefined || isDerivativeSegment(segment)) return move / last.ltp >= cfg.priceMovePct;
  const n = now.noiseN ?? last.noiseN;
  if (n !== null && n > 0) return move >= cfg.priceMoveNEq * n - 1e-9;
  return move / last.ltp >= cfg.priceMovePctEq;
}

/**
 * Whether a repeat of `fire` against `last` (the state when the judge was last
 * asked about it) is worth another call. Fails OPEN: anything unreadable is material.
 *
 * `reviewDue` (material-change gating): whether the `reviewIn` the latest live
 * verdict asked for has elapsed. When given it REPLACES the flat cooldown — the
 * judge, not a constant, says when an unchanged picture deserves another look.
 * Omitted (no verdict, or no usable reviewIn) the cooldown applies as before.
 */
export function repeatIsMaterial(
  fire: string,
  last: RejudgeSnapshot | undefined,
  now: RejudgeSnapshot,
  cfg: RejudgeConfig,
  reviewDue?: boolean,
): boolean {
  if (!last) return true;
  if (reviewDue !== undefined ? reviewDue : now.at - last.at >= cfg.cooldownMs) return true;
  if (last.qty !== now.qty) return true;
  if (!Number.isFinite(last.ltp) || last.ltp <= 0 || !Number.isFinite(now.ltp)) return true;
  // The P&L step: the contract price IS the per-unit P&L, so a priceMovePct move
  // is a P&L move of that fraction of the position's notional, either way. The
  // step is the segment's (see priceMoveIsMaterial).
  if (priceMoveIsMaterial(cfg, last, now)) return true;
  for (const k of EDGE_FLAGS) if (now[k] === true && last[k] !== true) return true;

  if (fire === NEWS_HIT) {
    // Ids known: new iff a fresh headline has never been put in front of the judge.
    if (now.newsUnjudged !== undefined && now.newsUnjudged !== null) return now.newsUnjudged > 0;
    // No ids: a higher 30-minute count means at least one new headline.
    if (now.newsCount == null || last.newsCount == null) return true;
    return now.newsCount > last.newsCount;
  }

  if (fire === LEVEL_BREAK) {
    if (now.level == null || last.level == null) return true;
    return now.level !== last.level;
  }

  if (fire === GIVEBACK_OFF_PEAK) {
    if (last.peak === null || now.peak === null || last.pullback === null || now.pullback === null) return true;
    if (now.peak !== last.peak) return true; // a new extreme: a different giveback episode
    const n = now.noiseN ?? last.noiseN;
    const step =
      n !== null
        ? n * cfg.givebackDeepenN
        : Math.max(0, last.excursion ?? 0) * cfg.givebackDeepenFrac;
    if (!(step > 0)) return true;
    return now.pullback - last.pullback >= step - 1e-9;
  }

  if (fire === VOLUME_ANOMALY) {
    // The ratio is over the last CLOSED 15m bar, so it changes only when a new
    // bar closes (or the median moves with it): a change is new evidence.
    if (last.volumeRatio === null || now.volumeRatio === null) return true;
    return Math.abs(now.volumeRatio - last.volumeRatio) > 1e-9;
  }

  return true;
}

/**
 * Drop a wake made ONLY of unchanged repeats of the suppressible sensors. Any
 * other fire, any material repeat, or a heartbeat ⇒ the decision is returned
 * as-is (same object).
 */
export function suppressRepeatJudgements(
  decision: TripwireResult,
  baselines: Readonly<Record<string, RejudgeSnapshot>>,
  now: RejudgeSnapshot,
  cfg: RejudgeConfig,
  reviewDue?: boolean,
): { decision: TripwireResult; suppressed: string[] } {
  const untouched = { decision, suppressed: [] as string[] };
  if (!cfg.enabled || decision.fires.length === 0) return untouched;
  if (decision.fires.some((f) => !SUPPRESSIBLE_FIRES.has(f.name))) return untouched;
  if (decision.fires.some((f) => repeatIsMaterial(f.name, baselines[f.name], now, cfg, reviewDue))) {
    // Material only because the cooldown / the verdict's review time elapsed? Then
    // it is a re-check, not a new claim: same fires as context, ROUTINE tier.
    const noCooldown = { ...cfg, cooldownMs: Number.POSITIVE_INFINITY };
    const noReview = reviewDue === undefined ? undefined : false;
    const cooldownOnly =
      cfg.routineOnCooldown &&
      decision.fires.every(
        (f) => baselines[f.name] !== undefined && !repeatIsMaterial(f.name, baselines[f.name], now, noCooldown, noReview),
      );
    return cooldownOnly ? { decision: { ...decision, trigger: 'HEARTBEAT' }, suppressed: [] } : untouched;
  }
  return {
    decision: {
      ...decision,
      fires: [],
      shouldEvaluate: decision.heartbeat,
      trigger: decision.heartbeat ? 'HEARTBEAT' : null,
    },
    suppressed: decision.fires.map((f) => f.name),
  };
}
