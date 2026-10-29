import type { EntryPlan } from './gate';
import { inr } from './funds';
import type { SignalProduct } from './signal-trader.config';
import type { SignalHorizon } from './signal.types';

/**
 * PAPER (no funds) — a signal every gate check and the AI judge said TAKE, but the owner's account
 * could not fund (funds check short, or the broker rejected the entry for funds/margin). With the
 * owner's `paperOnNoFunds` setting ON it becomes a paper trade through the app's standard paper path
 * (TradeExecutionService.executeTrade isPaper:true → Trade Journal "Paper" tab), so it can be
 * analysed next to the live ones. It never reaches the broker, never creates a live tracker and
 * never counts toward the signal caps (those count decision = 'TAKE' and live SignalOrders only).
 */
export const SIGNAL_PAPER_STRATEGY = 'TELEGRAM_SIGNAL_NO_FUNDS';
/** Trade.source of these paper trades (free text in the DB; the journal shows every paper trade). */
export const SIGNAL_PAPER_SOURCE = 'telegram-signal / no-funds';
export const SIGNAL_PAPER_SKIP_REASON = 'insufficient_funds';
const DECISION_TAG = 'decision:';

const HORIZON_TAG = 'horizon:';

/** `horizon` (BTST / POSITIONAL) is tagged so the exit watcher knows a carried trade's rules. */
export function paperTags(decisionId: string, horizon?: SignalHorizon, learn = false): string[] {
  const tags = ['telegram-signal', 'no-funds', `${DECISION_TAG}${decisionId}`];
  if (horizon && horizon !== 'INTRADAY') tags.push(`${HORIZON_TAG}${horizon}`);
  // 'learn' = the learning-mode track (no stop, no account caps; trade-engine LEARNING_PAPER_TAG).
  if (learn) tags.push('learn');
  return tags;
}

export function horizonFromTags(tags: readonly string[] | null | undefined): SignalHorizon {
  const t = (tags ?? []).find((x) => x.startsWith(HORIZON_TAG))?.slice(HORIZON_TAG.length);
  return t === 'BTST' || t === 'POSITIONAL' ? t : 'INTRADAY';
}

/**
 * The paper position type (owner 2026-10-27: swing picks are held overnight in paper). A BTST /
 * POSITIONAL call is carried — DELIVERY for cash, CARRYFORWARD for a future / option; an intraday
 * one keeps the configured product (squared off before the close).
 */
export function paperProduct(kind: string, horizon: SignalHorizon | undefined, base: SignalProduct): 'INTRADAY' | 'DELIVERY' | 'CARRYFORWARD' {
  if (horizon !== 'BTST' && horizon !== 'POSITIONAL') return base;
  return kind === 'EQ' ? 'DELIVERY' : 'CARRYFORWARD';
}

/** A POSITIONAL paper trade still open after this many calendar days is closed at the next close. */
export const PAPER_POSITIONAL_MAX_DAYS = 14;

const istYmd = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);

export function decisionTag(decisionId: string): string {
  return `${DECISION_TAG}${decisionId}`;
}

export function decisionIdFromTags(tags: readonly string[] | null | undefined): string | null {
  const t = (tags ?? []).find((x) => x.startsWith(DECISION_TAG));
  return t ? t.slice(DECISION_TAG.length) : null;
}

export function paperAlert(i: { required: number | null; available: number | null; what: string; channel: string; result: string; brokerReason?: string; paperMode?: boolean }): string {
  const need = i.required === null ? '₹?' : inr(i.required);
  const have = i.available === null ? '₹?' : inr(i.available);
  return [
    i.paperMode ? `PAPER (paper mode) — ${i.what} (${i.channel})` : `PAPER (insufficient funds): need ${need}, available ${have} — ${i.what} (${i.channel})`,
    ...(i.brokerReason ? [`broker: ${i.brokerReason.slice(0, 200)}`] : []),
    i.result,
  ].join('\n');
}

export type PaperExit =
  | { exit: false; trail?: PaperTrail }
  | { exit: true; price: number; tag: 'STOPPED_OUT' | 'MOVED_STOP' | 'HIT_TARGET' | 'TIME_EXIT'; reason: string };

/** A target was hit with more targets left: the trade stays open with its SL and target moved up. */
export interface PaperTrail {
  sl: number;
  target: number;
  reason: string;
}

/**
 * The plan's targets beyond the entry, in the trade's direction (nearest first), or [] when the plan
 * carries none usable. A target on the wrong side of the entry is dropped, not trusted.
 */
export function orderedTargets(side: string, entry: number, targets: unknown): number[] {
  if (!Array.isArray(targets) || !(entry > 0)) return [];
  const buy = String(side).toUpperCase() === 'BUY';
  const ok = targets.map(Number).filter((t) => Number.isFinite(t) && t > 0 && (buy ? t > entry : t < entry));
  return [...new Set(ok)].sort((a, b) => (buy ? a - b : b - a));
}

/**
 * When a tagged paper trade exits (pure). SL first (checked before the target on the same look);
 * the SL fills at the observed LTP (never better than the SL — a gap through it costs the gap),
 * the target at the target price (a resting LIMIT would). An INTRADAY trade is squared off at the
 * LTP inside the last `eodMinutes` of the session.
 *
 * TARGET TRAILING (owner 2026-10-29): with the plan's targets given, a hit target that is not the
 * last does not exit — the SL steps up (T1 → entry, T2 → T1, …) and the row's target becomes the
 * next one (`trail`, applied by the caller). Only the LAST target closes as HIT_TARGET; a stepped
 * SL hit closes as MOVED_STOP. A sweep that jumps several targets steps straight to the highest one
 * reached. Without targets (or with one), T1 exits exactly as before.
 */
export function paperExitDecision(i: {
  side: string;
  ltp: number | null;
  sl: number | null;
  target: number | null;
  product: string;
  minutesToClose: number | null;
  eodMinutes?: number;
  /** Carried trades only: the call's horizon, when it was entered, now, and the contract's expiry. */
  horizon?: SignalHorizon;
  entryTime?: Date | null;
  now?: Date;
  expiry?: Date | null;
  /** Target trailing: the entry and the plan's targets (see `orderedTargets`). */
  entry?: number | null;
  targets?: number[];
}): PaperExit {
  const ltp = i.ltp;
  if (ltp === null || !(ltp > 0)) return { exit: false };
  const buy = String(i.side).toUpperCase() === 'BUY';
  const beyond = (level: number) => (buy ? ltp >= level : ltp <= level);
  if (i.sl !== null && i.sl > 0 && (buy ? ltp <= i.sl : ltp >= i.sl)) {
    // An SL at or past the entry can only be one the trail moved there (a plan SL is always on the loss side).
    const moved = i.entry != null && i.entry > 0 && (buy ? i.sl >= i.entry : i.sl <= i.entry);
    return moved
      ? { exit: true, price: ltp, tag: 'MOVED_STOP', reason: `paper trailed SL ${i.sl} hit (LTP ${ltp})` }
      : { exit: true, price: ltp, tag: 'STOPPED_OUT', reason: `paper SL ${i.sl} hit (LTP ${ltp})` };
  }
  if (i.target !== null && i.target > 0 && beyond(i.target)) {
    const ts = i.targets ?? [];
    const at = ts.findIndex((t) => Math.abs(t - (i.target as number)) < 1e-6);
    const entry = i.entry ?? null;
    if (at >= 0 && at < ts.length - 1 && entry !== null && entry > 0) {
      // The highest target this LTP has reached.
      let k = at;
      while (k + 1 < ts.length && beyond(ts[k + 1])) k += 1;
      const last = ts.length - 1;
      if (k === last) {
        return { exit: true, price: ts[last], tag: 'HIT_TARGET', reason: `paper last target T${last + 1} ${ts[last]} hit (LTP ${ltp})` };
      }
      const stepped = k === 0 ? entry : ts[k - 1];
      // Never loosens: an SL already tighter stays.
      const sl = i.sl !== null && i.sl > 0 ? (buy ? Math.max(i.sl, stepped) : Math.min(i.sl, stepped)) : stepped;
      return {
        exit: false,
        trail: { sl, target: ts[k + 1], reason: `paper T${k + 1} ${ts[k]} hit (LTP ${ltp}): SL → ${sl}${k === 0 ? ' (entry)' : ` (T${k})`}, next target T${k + 2} ${ts[k + 1]}` },
      };
    }
    return { exit: true, price: i.target, tag: 'HIT_TARGET', reason: `paper target ${i.target} hit (LTP ${ltp})` };
  }
  const eod = i.eodMinutes ?? 5;
  const closing = i.minutesToClose !== null && i.minutesToClose <= eod;
  if (String(i.product).toUpperCase() === 'INTRADAY') {
    if (closing) return { exit: true, price: ltp, tag: 'TIME_EXIT', reason: `paper intraday square-off ${i.minutesToClose} min before close (LTP ${ltp})` };
    return { exit: false };
  }
  // Carried (BTST / POSITIONAL): held overnight; a contract never past its expiry day.
  const now = i.now ?? new Date();
  const today = istYmd(now);
  if (i.expiry && istYmd(i.expiry) <= today && closing) {
    return { exit: true, price: ltp, tag: 'TIME_EXIT', reason: `paper carried trade closed on the contract's expiry day (LTP ${ltp})` };
  }
  if (i.horizon === 'BTST' && i.entryTime && istYmd(i.entryTime) < today) {
    return { exit: true, price: ltp, tag: 'TIME_EXIT', reason: `paper BTST exit in the next session (LTP ${ltp})` };
  }
  if (i.entryTime && closing && now.getTime() - i.entryTime.getTime() >= PAPER_POSITIONAL_MAX_DAYS * 86_400_000) {
    return { exit: true, price: ltp, tag: 'TIME_EXIT', reason: `paper positional trade closed after ${PAPER_POSITIONAL_MAX_DAYS} days without SL / T1 (LTP ${ltp})` };
  }
  return { exit: false };
}

/** The entry reason written on the paper Trade row (the journal shows it). */
export function paperEntryReason(i: { decisionId: string; channel: string; what: string; plan: EntryPlan; why: string }): string {
  const t = i.plan.targets;
  return [
    `${SIGNAL_PAPER_SOURCE} (decision ${i.decisionId}) — ${i.why}.`,
    `Signal (${i.channel}): ${i.what}.`,
    `Plan: LIMIT ${i.plan.limitPrice} x${i.plan.qty} SL ${i.plan.sl} targets ${t.length ? t.join(' / ') : 'none'} (paper exits at SL or the last target; each earlier target trails the SL — T1 to entry, then to the previous target).`,
  ].join(' ');
}
