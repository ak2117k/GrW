import { buildGateFacts, bypassRecord, decideExit } from '../exit-discipline/decision';
import { withExitTuning, type ExitDisciplineConfig } from '../exit-discipline/config';
import { readPacketFacts } from '../exit-discipline/packet-facts';
import type { HistoryVerdict } from '../exit-discipline/persistence';
import type { GateRecordV1 } from '../exit-discipline/types';
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
}

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
}

const ARM_DEFER_MS = 30_000;
const ARM_PRICE_MAX_AGE_MS = 15_000;

/**
 * TriggerWatchService.armOne for a paper trade. `wait` = no fresh price yet, still inside the defer window
 * (re-tried next sweep); `rejected` carries the live reason word.
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
  fnoExchanges: readonly string[];
  now: number;
}): { kind: 'armed'; trigger: PaperTrigger } | { kind: 'wait' } | { kind: 'rejected'; reason: string } {
  const stored = parseStoredTrigger(i.pending.exitTrigger);
  if (stored.kind === 'problem') return { kind: 'rejected', reason: `MALFORMED: ${stored.problem}` };
  const p = stored.trigger;
  if (!i.fnoExchanges.includes(String(i.exchange).toUpperCase())) return { kind: 'rejected', reason: 'EXCHANGE_NOT_FNO' };
  const quote = p.instrument === 'PREMIUM' ? i.prices.premium : i.prices.underlying;
  const fresh = quote && quote.price > 0 && i.now - quote.at <= ARM_PRICE_MAX_AGE_MS ? quote : null;
  if (!fresh) return i.now - i.pending.seenAt < ARM_DEFER_MS ? { kind: 'wait' } : { kind: 'rejected', reason: 'NO_FRESH_PRICE' };
  const level: TriggerLevel = { instrument: p.instrument, op: p.op, price: p.price };
  const v = validateTrigger({
    proposal: level,
    qty: i.qty,
    kind: contractKindOf(i.symbol),
    current: { price: fresh.price, ageMs: Math.max(0, i.now - fresh.at) },
    armed: i.armed ? { instrument: i.armed.instrument, op: i.armed.op, price: i.armed.price } : null,
    cfg: i.cfg,
  });
  if (!v.ok) return { kind: 'rejected', reason: v.reason };
  return { kind: 'armed', trigger: { lookId: i.pending.lookId, ...level, armedAt: i.now, refPrice: fresh.price } };
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
