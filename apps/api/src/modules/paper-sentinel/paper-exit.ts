import { contractValueFactor } from '@td/shared';
import { buildGateFacts, bypassRecord, decideExit } from '../exit-discipline/decision';
import { withExitTuning, type ExitDisciplineConfig } from '../exit-discipline/config';
import { readPacketFacts } from '../exit-discipline/packet-facts';
import type { HistoryVerdict } from '../exit-discipline/persistence';
import type { GateRecordV1 } from '../exit-discipline/types';
import { triggerCheckFromPacket, type TriggerCheck } from '../exit-discipline/trigger-check';
import { cutLossFromPacket, type N15Reading } from '../exit-discipline/cut-loss-yardstick';
import { parseStoredTrigger } from '../sentinel-executor/domain/stored-trigger';
import { contractKindOf, validateTrigger, type TriggerLevel } from '../sentinel-executor/domain/trigger-rules';
import type { TriggerConfig } from '../sentinel-executor/domain/trigger-config';
import type { TriggerInstrument, TriggerOp } from '../sentinel-executor/domain/trigger.types';

/**
 * Paper sentinel, the exit half (spec 2026-10-28-paper-exit-shadow-design.md, stage 2). Pure.
 *
 * The live AI exits a position two ways, and both are replayed here on a paper trade's looks:
 *  - AI_EXIT: an EXIT_NOW verdict the exit gate lets through — exit-discipline's `decideExit` with the
 *    same facts, history and self-review tuning as `ExitGateService.decide` (PASS, or BYPASS which
 *    fails open and executes live). GATED / AWAITING_CONFIRMATION do not exit, exactly as live.
 *  - AI_TRIGGER: a HOLD / EXIT_ARMED verdict's exitTrigger, armed by the live `validateTrigger` rules
 *    (protective side, fresh price, distance, tighten-only) and fired when the level is crossed.
 *
 * The one stated difference: live triggers confirm on 2 hub ticks ≥ 1 s apart; the paper watch prices
 * every 30 s, so the first sweep beyond the level stands for that confirmation, at that sweep's LTP.
 *
 * Cash equity (owner 2026-10-29: "same logic as futures"): the live executor never arms a stock, so a
 * paper stock's trigger is the live rules on the stock's own price — see `armPaperTrigger`.
 */

/** ExitGateService.decide, minus the I/O it does around it (the caller supplies the same reads). */
export function paperExitGate(i: {
  look: { id: string; createdAt: Date; packet: unknown };
  history: HistoryVerdict[];
  ltpNow: number;
  productType: string | null;
  minutesToClose: number | null;
  sessionMinutes: number | undefined;
  maxLossPerTrade: number | null;
  dailyLossLatched: boolean;
  cfg: ExitDisciplineConfig;
  tuning: Parameters<typeof withExitTuning>[1];
  now: Date;
  /** The contract's exchange, for the MCX rupee factor of the fresh P&L. Absent ⇒ factor 1. */
  exchange?: string;
}): GateRecordV1 {
  const cfg = withExitTuning(i.cfg, i.tuning);
  if (!cfg.enabled) return bypassRecord('DISABLED', cfg, i.now);
  const facts = readPacketFacts(i.look.packet);
  if ('unreadable' in facts) return bypassRecord('FACTS_UNREADABLE', cfg, i.now, facts.unreadable);
  try {
    const gateFacts = buildGateFacts(facts, {
      ltpNow: i.ltpNow,
      productType: i.productType,
      underlyingSessionMinutes: i.sessionMinutes,
      minutesToClose: i.minutesToClose,
      maxLossPerTrade: i.maxLossPerTrade,
      dailyLossLatched: i.dailyLossLatched,
      history: i.history,
      now: i.now,
      valueFactor: contractValueFactor(i.exchange, facts.symbol),
    });
    return decideExit({ facts: gateFacts, current: { id: i.look.id, createdAt: i.look.createdAt }, history: i.history, cfg, now: i.now });
  } catch (err) {
    return bypassRecord('FACTS_UNREADABLE', cfg, i.now, err instanceof Error ? err.message : String(err));
  }
}

/** The outcomes on which the live executor sends the exit order. */
export const gateExits = (r: GateRecordV1): boolean => r.outcome === 'PASS' || r.outcome === 'BYPASS';

export interface PaperTrigger {
  lookId: string;
  instrument: TriggerInstrument;
  op: TriggerOp;
  price: number;
  armedAt: number;
  /** The price the trigger was armed against. */
  refPrice: number;
  /** Cash only: the instrument the AI named, when it was normalised to the stock's own price. */
  proposedInstrument?: TriggerInstrument;
  /**
   * The trigger check at arming (exit-discipline/trigger-check.ts), with the CUT_LOSS yardstick's fields. Its
   * `tight` is read by the next arming's ratchet exception; nothing fires on it.
   */
  check?: TriggerCheck;
  /** The AI's level, when the CUT_LOSS yardstick armed a wider one (`price`). */
  proposedPrice?: number;
  /** The armed level this trigger LOOSENED under the ratchet exception. */
  loosenedFrom?: number;
}

/** Cash-equity exchanges: the contract IS the stock, so contract price and underlying are one price. */
export const CASH_EXCHANGES: readonly string[] = ['NSE', 'BSE'];
export const isCashExchange = (exchange: string): boolean => CASH_EXCHANGES.includes(String(exchange).toUpperCase());

export interface TriggerPrices {
  /** The paper contract's LTP and when it was read. */
  premium: { price: number; at: number } | null;
  /** The underlying's LTP (the tick reading's) and when it was read. */
  underlying: { price: number; at: number } | null;
}

/** A proposal waiting for a fresh price (the live armDeferMs). */
export interface PendingTrigger {
  lookId: string;
  exitTrigger: unknown;
  seenAt: number;
  /** The look's packet, stated invalidation, net P&L, thesis status and reason — the trigger check and the CUT_LOSS yardstick. */
  basis?: { packet: unknown; invalidationPoint: string | null; netPnl: number | null; thesisStatus?: string | null; reason?: string | null };
}

const ARM_DEFER_MS = 30_000;
const ARM_PRICE_MAX_AGE_MS = 15_000;

/**
 * TriggerWatchService.armOne for a paper trade. `wait` = no fresh price yet, still inside the defer window
 * (re-tried next sweep); `rejected` carries the live reason word.
 *
 * Cash (NSE/BSE): any proposal, UNDERLYING or PREMIUM, is a level on the stock's own price — armed as
 * PREMIUM (the paper watch's LTP, so the protective side is the position's sign: long ⇒ BELOW) under
 * the UNDERLYING distance limit, since a stock moves like an underlying, not like an option premium.
 * Everything else (fresh price, not crossed, tighten-only) is the live validateTrigger unchanged.
 */
export function armPaperTrigger(i: {
  pending: PendingTrigger;
  symbol: string;
  exchange: string;
  /** Signed: negative is a short. */
  qty: number;
  prices: TriggerPrices;
  armed: PaperTrigger | null;
  cfg: Pick<TriggerConfig, 'maxDistancePct' | 'tightenOnly'>;
  /** Where a paper trigger may arm: the live auto-exit's F&O exchanges, plus NSE/BSE when equity is on. */
  exchanges: readonly string[];
  now: number;
  /** The CUT_LOSS yardstick's inputs (the underlying's N15 and K15). Absent ⇒ the live rules unchanged. */
  cutLoss?: { n15: N15Reading | null; k15: number | null };
}):{ kind: 'armed'; trigger: PaperTrigger } | { kind: 'wait' } | { kind: 'rejected'; reason: string } {
  const stored = parseStoredTrigger(i.pending.exitTrigger);
  if (stored.kind === 'problem') return { kind: 'rejected', reason: `MALFORMED: ${stored.problem}` };
  const p = stored.trigger;
  const exchange = String(i.exchange).toUpperCase();
  if (!i.exchanges.includes(exchange)) return { kind: 'rejected', reason: `EXCHANGE_NOT_ALLOWED (${exchange})` };
  const cash = isCashExchange(exchange);
  const instrument: TriggerInstrument = cash ? 'PREMIUM' : p.instrument;
  const quote = instrument === 'PREMIUM' ? i.prices.premium : i.prices.underlying;
  const fresh = quote && quote.price > 0 && i.now - quote.at <= ARM_PRICE_MAX_AGE_MS ? quote : null;
  if (!fresh) return i.now - i.pending.seenAt < ARM_DEFER_MS ? { kind: 'wait' } : { kind: 'rejected', reason: 'NO_FRESH_PRICE' };
  const proposed: TriggerLevel = { instrument, op: p.op, price: p.price };
  const b = i.pending.basis;
  // CUT_LOSS yardstick (exit-discipline/cut-loss-yardstick.ts) — ACTS on paper: a protective UNDERLYING level
  // cutting a loss sits at least max(K·N1, K15·N15) from the fixed reference, never past the invalidation.
  // cutLossFromPacket never throws (null when the packet is unreadable ⇒ the proposal unchanged).
  const cut = b && i.cutLoss
    ? cutLossFromPacket({
      instrument, op: p.op, price: p.price, packet: b.packet, invalidationPoint: b.invalidationPoint, netPnl: b.netPnl,
      underlyingNow: instrument === 'UNDERLYING' ? fresh.price : null,
      n15: i.cutLoss.n15, k15: i.cutLoss.k15, thesisStatus: b.thesisStatus ?? null, reasonText: b.reason ?? null,
      // The check's `tight` describes the AI's level; once the yardstick widened it, the armed level is judged
      // by the minimum distance alone (cutLossLoosen's inside-the-minimum test).
      armed: i.armed
        ? { instrument: i.armed.instrument, op: i.armed.op, price: i.armed.price, tight: i.armed.proposedPrice !== undefined ? null : i.armed.check?.tight ?? null }
        : null,
      acted: true,
    })
    : null;
  const level: TriggerLevel = cut ? { ...proposed, price: cut.wouldArmAt } : proposed;
  const cfg = cash ? { ...i.cfg, maxDistancePct: { ...i.cfg.maxDistancePct, PREMIUM: i.cfg.maxDistancePct.UNDERLYING } } : i.cfg;
  const validate = (armed: PaperTrigger | null) => validateTrigger({
    proposal: level,
    qty: i.qty,
    kind: contractKindOf(i.symbol),
    current: { price: fresh.price, ageMs: Math.max(0, i.now - fresh.at) },
    armed: armed ? { instrument: armed.instrument, op: armed.op, price: armed.price } : null,
    cfg,
  });
  let v = validate(i.armed);
  // The ratchet exception: a tight armed CUT_LOSS level may be loosened by an INTACT-thesis verdict, up to the
  // invalidation (cutLossLoosen). LOOSENS is the last arming rule, so every other rule has already passed.
  const loosened = !v.ok && v.reason === 'LOOSENS' && cut?.wouldAllowLoosen === true;
  if (loosened) v = validate(null);
  if (!v.ok) return { kind: 'rejected', reason: v.reason };
  const trigger: PaperTrigger = { lookId: i.pending.lookId, ...level, armedAt: i.now, refPrice: fresh.price };
  if (cash && p.instrument !== instrument) trigger.proposedInstrument = p.instrument;
  if (cut && cut.wouldArmAt !== p.price) trigger.proposedPrice = p.price;
  if (loosened) trigger.loosenedFrom = i.armed!.price;
  // RECORD: the check describes the AI's own level (as before), with the yardstick's reading beside it.
  const check = b
    ? triggerCheckFromPacket({ op: proposed.op, instrument, triggerPrice: proposed.price, refPrice: fresh.price, packet: b.packet, invalidationPoint: b.invalidationPoint, netPnl: b.netPnl })
    : null;
  if (check) trigger.check = cut ? { ...check, ...cut } : check;
  return { kind: 'armed', trigger };
}

/** One sweep against an armed trigger: fire on the first read beyond the level, expire at the live max age. */
export function stepPaperTrigger(
  t: PaperTrigger,
  prices: TriggerPrices,
  cfg: Pick<TriggerConfig, 'maxAgeMin'>,
  now: number,
): { kind: 'fire'; watched: number } | { kind: 'expired' } | { kind: 'none' } {
  if (now - t.armedAt > cfg.maxAgeMin * 60_000) return { kind: 'expired' };
  const q = t.instrument === 'PREMIUM' ? prices.premium : prices.underlying;
  if (!q || !(q.price > 0)) return { kind: 'none' };
  const beyond = t.op === 'BELOW' ? q.price < t.price : q.price > t.price;
  return beyond ? { kind: 'fire', watched: q.price } : { kind: 'none' };
}

/**
 * Intraday carry on paper (spec 2026-11-04 D12) — what a close decision does to an INTRADAY paper
 * trade. Pure; no broker call ever (this module reaches no order code).
 *  - CARRY: the paper trade's product becomes CARRYFORWARD, so the paper watch's intraday square-off
 *    (signal-trader/domain/paper.ts: last 5 minutes) no longer closes it — it is held overnight on its
 *    carried rules (SL, targets, the contract's expiry day), as a live conversion would be.
 *  - EXIT (and the cap's broker square-off, which paper has no cap for): left INTRADAY — the paper
 *    watch's square-off closes it at the LTP before the close, as the broker's MIS square-off would.
 *  - Anything else, or a trade that is no longer INTRADAY: nothing.
 */
export function paperCloseEffect(
  decision: string,
  product: string | null,
): { kind: 'convert'; positionType: 'CARRYFORWARD'; note: string } | { kind: 'leave'; note: string } {
  const intraday = String(product ?? '').trim().toUpperCase() === 'INTRADAY';
  if (!intraday) return { kind: 'leave', note: `paper product ${product ?? 'unknown'} is not INTRADAY — nothing to do` };
  if (decision === 'CARRY') {
    return { kind: 'convert', positionType: 'CARRYFORWARD', note: 'paper close decision CARRY: product INTRADAY → CARRYFORWARD (held overnight)' };
  }
  return { kind: 'leave', note: `paper close decision ${decision}: left INTRADAY — the paper square-off closes it before the close` };
}
