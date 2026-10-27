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
export function paperTags(decisionId: string, horizon?: SignalHorizon): string[] {
  const tags = ['telegram-signal', 'no-funds', `${DECISION_TAG}${decisionId}`];
  if (horizon && horizon !== 'INTRADAY') tags.push(`${HORIZON_TAG}${horizon}`);
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
  | { exit: false }
  | { exit: true; price: number; tag: 'STOPPED_OUT' | 'HIT_TARGET' | 'TIME_EXIT'; reason: string };

/**
 * When a tagged paper trade exits (pure). SL first (checked before the target on the same look);
 * the SL fills at the observed LTP (never better than the SL — a gap through it costs the gap),
 * the target at the target price (a resting LIMIT would). The Trade row carries ONE target: T1, the
 * same "first target before SL" the CHANNEL_SIGNAL self-review scores. An INTRADAY trade is squared
 * off at the LTP inside the last `eodMinutes` of the session.
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
}): PaperExit {
  const ltp = i.ltp;
  if (ltp === null || !(ltp > 0)) return { exit: false };
  const buy = String(i.side).toUpperCase() === 'BUY';
  if (i.sl !== null && i.sl > 0 && (buy ? ltp <= i.sl : ltp >= i.sl)) {
    return { exit: true, price: ltp, tag: 'STOPPED_OUT', reason: `paper SL ${i.sl} hit (LTP ${ltp})` };
  }
  if (i.target !== null && i.target > 0 && (buy ? ltp >= i.target : ltp <= i.target)) {
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
    `Plan: LIMIT ${i.plan.limitPrice} x${i.plan.qty} SL ${i.plan.sl} targets ${t.length ? t.join(' / ') : 'none'} (paper exits at SL or T1).`,
  ].join(' ');
}
