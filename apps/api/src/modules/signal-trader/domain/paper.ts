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
/**
 * Paper trades the paper watch (SL / target / square-off, and the paper sentinel's AI exits) manages:
 * the Telegram ones and the entry engine's (entry-engine ENGINE_ENTRY_STRATEGY, kept literal so this
 * module does not import entry-engine). The decision / judge / OI records stay Telegram-only.
 */
export const PAPER_WATCH_STRATEGIES: readonly string[] = [SIGNAL_PAPER_STRATEGY, 'ENGINE_ENTRY'];
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

/**
 * The trade stays open with its SL (and target) moved: a target hit with more left (target = the next
 * one), or the noise trail of a one-target call (target = null — no target any more, only the trail).
 * `sl` null = the trade keeps no SL (a learning trade whose step the breakeven guard held back).
 */
export interface PaperTrail {
  sl: number | null;
  target: number | null;
  reason: string;
}

/**
 * The trade's noise scale and the trail / step rules on it (owner 2026-10-29, horizon-aware):
 * - `n` — the noise unit. INTRADAY: the contract's 1-min noise N (exit shadow). Carried (BTST /
 *   POSITIONAL): the contract's DAILY ATR(14) — a multi-day trade must survive a normal day, not a
 *   normal minute (ACUTAAS 2026-10-29 was stopped at entry by an intraday wiggle, then ran).
 * - `peak` — the best price since entry; `trailN` — the noise trail's distance behind it, in units.
 * - `minStepN` — the BREAKEVEN GUARD: an SL step to level L (the entry, or an earlier target) is taken
 *   only once the best price is ≥ minStepN units beyond L. Absent / 0 = off (every step as before).
 */
export interface PaperNoise {
  n: number | null;
  peak: number | null;
  trailN: number;
  minStepN?: number;
  /** What `n` is, for the reasons ('1m N' / 'daily ATR'). */
  unit?: string;
}

/** INTRADAY breakeven guard, × the 1-min N (env PAPER_STEP_MIN_N; 0 = off). */
export const PAPER_STEP_MIN_N_DEFAULT = 3;
/** Carried breakeven guard, × the daily ATR (env PAPER_STEP_MIN_ATR; 0 = off). */
export const PAPER_STEP_MIN_ATR_DEFAULT = 1;
/** Carried noise trail distance behind the best price, × the daily ATR (env PAPER_CARRIED_TRAIL_ATR). */
export const PAPER_CARRIED_TRAIL_ATR_DEFAULT = 1;

export interface PaperTrailConfig {
  stepMinN: number;
  stepMinAtr: number;
  carriedTrailAtr: number;
}

/** The env-tunable guard / trail sizes; a missing or bad value falls back to its default. */
export function paperTrailConfig(env: Record<string, string | undefined>): PaperTrailConfig {
  const num = (key: string, d: number, min: number) => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return d;
    const v = Number(raw);
    return Number.isFinite(v) && v >= min && v <= 20 ? v : d;
  };
  return {
    stepMinN: num('PAPER_STEP_MIN_N', PAPER_STEP_MIN_N_DEFAULT, 0),
    stepMinAtr: num('PAPER_STEP_MIN_ATR', PAPER_STEP_MIN_ATR_DEFAULT, 0),
    carriedTrailAtr: num('PAPER_CARRIED_TRAIL_ATR', PAPER_CARRIED_TRAIL_ATR_DEFAULT, 0.1),
  };
}

/** A carried horizon: its noise scale is daily. */
export const isCarried = (h: SignalHorizon | undefined): boolean => h === 'BTST' || h === 'POSITIONAL';

const r2 = (n: number) => Math.round(n * 100) / 100;

const unitOf = (noise: PaperNoise | undefined): number | null => {
  const n = noise?.n;
  return n !== null && n !== undefined && Number.isFinite(n) && n > 0 ? n : null;
};

/** The best price seen: the peak since entry or this LTP, whichever is further in the trade's favour. */
function bestOf(buy: boolean, ltp: number, noise: PaperNoise | undefined): number {
  const p = noise?.peak;
  return p !== null && p !== undefined && Number.isFinite(p) && p > 0 ? (buy ? Math.max(p, ltp) : Math.min(p, ltp)) : ltp;
}

/** The breakeven guard is on: a known unit and minStepN > 0. */
const guarded = (noise: PaperNoise | undefined): boolean => unitOf(noise) !== null && (noise?.minStepN ?? 0) > 0;

/** The best price is ≥ minStepN units beyond `level` (always true with the guard off). */
function roomBeyond(buy: boolean, best: number, level: number, noise: PaperNoise | undefined): boolean {
  if (!guarded(noise)) return true;
  const need = (noise?.minStepN as number) * (unitOf(noise) as number);
  return (buy ? best - level : level - best) >= need - 1e-9;
}

/**
 * The SL step over these candidate levels (the entry first, then the earlier targets; the regular step
 * is the last): the furthest one with the guard's room behind the best price, or null (the SL stays).
 */
function stepLevel(buy: boolean, best: number, levels: number[], noise: PaperNoise | undefined): number | null {
  for (let j = levels.length - 1; j >= 0; j--) if (roomBeyond(buy, best, levels[j], noise)) return levels[j];
  return null;
}

/** `a` is tighter than `b` (or there is no `b`) in the trade's direction. */
const tighter = (buy: boolean, a: number, b: number | null): boolean => b === null || !(b > 0) || (buy ? a > b : a < b);

/**
 * The noise trail level: trailN units behind the best price. Floored at the entry once the best price is
 * the guard's room beyond it (guard off: always — the original rule); before that it may sit below the
 * entry (a noise-sized stop; the caller still keeps the tighter of it and the current SL). Null when the
 * unit is unknown.
 */
function noiseTrailLevel(buy: boolean, entry: number, ltp: number, noise: PaperNoise | undefined): number | null {
  const n = unitOf(noise);
  if (!noise || n === null || !(noise.trailN > 0)) return null;
  const best = bestOf(buy, ltp, noise);
  const raw = buy ? best - noise.trailN * n : best + noise.trailN * n;
  const floorAtEntry = roomBeyond(buy, best, entry, noise);
  return r2(floorAtEntry ? (buy ? Math.max(entry, raw) : Math.min(entry, raw)) : raw);
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
 * reached. Without targets, T1 exits exactly as before.
 *
 * ONE-TARGET CALLS (owner 2026-10-29): the only target does not exit either — the target is dropped
 * and a NOISE TRAIL takes over (trailN units behind the best price, never below the entry once the
 * guard allows the breakeven), ratcheting every sweep; its hit closes as MOVED_STOP. With the unit not
 * yet measured the target exits as before.
 *
 * BREAKEVEN GUARD (owner 2026-10-29, `noise.minStepN`): a step to a level the best price is not yet
 * minStepN units beyond is held back — the SL stays at the plan SL (or the previous step) while the
 * target still advances, and the step is caught up on a later sweep once the price has the room. The
 * unit is horizon-aware (the caller's job): the 1-min N intraday, the daily ATR for a carried trade.
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
  /** The plan's own SL: an SL hit tighter than it (moved by a trail) closes as MOVED_STOP even below the entry. */
  planSl?: number | null;
  /** The trail / guard inputs. Absent ⇒ the only target exits, and every step is taken as before. */
  noise?: PaperNoise;
}): PaperExit {
  const ltp = i.ltp;
  if (ltp === null || !(ltp > 0)) return { exit: false };
  const buy = String(i.side).toUpperCase() === 'BUY';
  const beyond = (level: number) => (buy ? ltp >= level : ltp <= level);
  if (i.sl !== null && i.sl > 0 && (buy ? ltp <= i.sl : ltp >= i.sl)) {
    // An SL at or past the entry can only be one the trail moved there (a plan SL is always on the loss side);
    // one tighter than the plan's own SL was moved too (a noise trail the guard still holds below the entry).
    const atEntry = i.entry != null && i.entry > 0 && (buy ? i.sl >= i.entry : i.sl <= i.entry);
    const pastPlan = i.planSl != null && i.planSl > 0 && Math.abs(i.sl - i.planSl) > 1e-6 && (buy ? i.sl > i.planSl : i.sl < i.planSl);
    return atEntry || pastPlan
      ? { exit: true, price: ltp, tag: 'MOVED_STOP', reason: `paper trailed SL ${i.sl} hit (LTP ${ltp})` }
      : { exit: true, price: ltp, tag: 'STOPPED_OUT', reason: `paper SL ${i.sl} hit (LTP ${ltp})` };
  }
  const entry = i.entry ?? null;
  const ts = i.targets ?? [];
  const sl0 = i.sl !== null && i.sl > 0 ? i.sl : null;
  const unitText = () => `${i.noise?.unit ?? 'N'} ${r2(unitOf(i.noise) ?? 0)}`;
  // Noise-trail mode (a one-target call past its target): no target; ratchet the SL with the best price.
  // The SL may still sit below the entry while the guard holds the breakeven back, hence the plan check.
  const trailMode =
    i.target === null && entry !== null && entry > 0 && ((ts.length === 1 && guarded(i.noise)) || (sl0 !== null && (buy ? sl0 >= entry : sl0 <= entry)));
  if (trailMode) {
    const level = noiseTrailLevel(buy, entry as number, ltp, i.noise);
    if (level !== null && tighter(buy, level, sl0)) {
      return { exit: false, trail: { sl: level, target: null, reason: `paper noise trail SL ${sl0 ?? 'none'} → ${level} (LTP ${ltp}, ${unitText()})` } };
    }
  }
  if (i.target !== null && i.target > 0 && beyond(i.target)) {
    const at = ts.findIndex((t) => Math.abs(t - (i.target as number)) < 1e-6);
    // A one-target call: drop the target and hand over to the noise trail (when the unit is known).
    if (ts.length === 1 && at === 0 && entry !== null && entry > 0) {
      const level = noiseTrailLevel(buy, entry, ltp, i.noise);
      if (level !== null) {
        const sl = tighter(buy, level, sl0) ? level : sl0;
        return {
          exit: false,
          trail: { sl, target: null, reason: `paper only target ${ts[0]} hit (LTP ${ltp}): noise trail from here, SL → ${sl ?? 'none'} (${i.noise?.trailN}× ${unitText()})` },
        };
      }
    }
    if (at >= 0 && at < ts.length - 1 && entry !== null && entry > 0) {
      // The highest target this LTP has reached.
      let k = at;
      while (k + 1 < ts.length && beyond(ts[k + 1])) k += 1;
      const last = ts.length - 1;
      if (k === last) {
        return { exit: true, price: ts[last], tag: 'HIT_TARGET', reason: `paper last target T${last + 1} ${ts[last]} hit (LTP ${ltp})` };
      }
      // The step (T1 → entry, T2 → T1, …) — or, under the guard, the furthest earlier level with room; none = SL stays.
      const intended = k === 0 ? entry : ts[k - 1];
      const stepped = stepLevel(buy, bestOf(buy, ltp, i.noise), [entry, ...ts.slice(0, k)], i.noise);
      // Never loosens: an SL already tighter stays.
      const sl = stepped !== null && tighter(buy, stepped, sl0) ? stepped : sl0;
      const name = (lv: number) => (lv === entry ? ' (entry)' : ` (T${ts.indexOf(lv) + 1})`);
      const how =
        stepped === null
          ? `SL stays ${sl ?? 'none'} (the step to ${intended} is within ${i.noise?.minStepN}× ${unitText()} of the price — held back)`
          : `SL → ${sl}${sl === stepped ? name(stepped) : ''}${stepped !== intended ? ` (the step to ${intended} held back by the noise guard)` : ''}`;
      return { exit: false, trail: { sl, target: ts[k + 1], reason: `paper T${k + 1} ${ts[k]} hit (LTP ${ltp}): ${how}, next target T${k + 2} ${ts[k + 1]}` } };
    }
    return { exit: true, price: i.target, tag: 'HIT_TARGET', reason: `paper target ${i.target} hit (LTP ${ltp})` };
  }
  // Breakeven catch-up: a step the guard held back is taken once the best price has the room (target unchanged).
  if (guarded(i.noise) && i.target !== null && entry !== null && entry > 0) {
    const j = ts.findIndex((t) => Math.abs(t - (i.target as number)) < 1e-6);
    if (j >= 1) {
      const stepped = stepLevel(buy, bestOf(buy, ltp, i.noise), [entry, ...ts.slice(0, j - 1)], i.noise);
      if (stepped !== null && tighter(buy, stepped, sl0)) {
        return {
          exit: false,
          trail: { sl: stepped, target: i.target, reason: `paper held-back step taken (LTP ${ltp}, ≥ ${i.noise?.minStepN}× ${unitText()} beyond it): SL ${sl0 ?? 'none'} → ${stepped}` },
        };
      }
    }
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
