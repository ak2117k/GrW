import { parseAutoExitConfig } from '../../sentinel-executor/domain/auto-exit.config';
import { AUTO_EXIT_EXCHANGES, type QtyUnit } from '../../sentinel-executor/domain/auto-exit.types';
import { parseTriggerConfig } from '../../sentinel-executor/domain/trigger-config';
import type { OrderRequest } from '../../../common/interfaces/broker-adapter.interface';
import type { EntryPlan } from './gate';
import type { SignalProduct } from './signal-trader.config';

/** Prefix of every signal ENTRY ordertag. Not an exit prefix (ax/am/at), not auto-execution's 'ae'. */
export const SIGNAL_ORDER_TAG_PREFIX = 'sg';

/** Angel ordertag ≤ 20 alphanumerics: 'sg' + last 18 of the decision id. Stable per decision. */
export function signalOrderTag(decisionId: string): string {
  return `${SIGNAL_ORDER_TAG_PREFIX}${String(decisionId).replace(/[^A-Za-z0-9]/g, '').slice(-18)}`;
}

/** Tag on the synthetic sentinel_verdicts row that carries the signal SL (excluded from "last live look"). */
export const SIGNAL_ENTRY_VERDICT_TAG = 'SIGNAL_ENTRY';

type Env = Record<string, string | undefined>;

/**
 * Can the signal's SL actually be enforced by the existing exit path (price trigger → AI exit
 * executor), for this owner, contract and exchange? Required in LIVE: a live trade with an SL that
 * nothing will execute would break the per-trade loss cap. Pure over env.
 */
export function slEnforceability(env: Env, ownerUserId: string | null, exchange: string | null, tradingsymbol: string | null): { ok: boolean; detail: string; qtyUnit: QtyUnit | null } {
  const t = parseTriggerConfig(env);
  const a = parseAutoExitConfig(env);
  const ex = String(exchange ?? '').toUpperCase();
  const unit = (a.qtyUnits[ex] as QtyUnit | undefined) ?? null;
  const fail = (detail: string) => ({ ok: false, detail, qtyUnit: unit });
  if (!t.enabled) return fail('SENTINEL_TRIGGERS_ENABLED is not true — nothing would execute the SL');
  if (!a.enabled) return fail('the AI auto-exit is off — nothing would execute the SL');
  if (a.mode !== 'live') return fail(`the AI auto-exit is in ${a.mode} mode — the SL would not be executed`);
  if (!ownerUserId || !a.userIds.includes(ownerUserId)) return fail('the owner is not on AI_AUTO_EXIT_USER_IDS');
  if (!ex) return fail('no exchange');
  if (!AUTO_EXIT_EXCHANGES.includes(ex)) return fail(`${ex} is outside the auto-exit venues (${AUTO_EXIT_EXCHANGES.join('/')})`);
  if (!unit) return fail(`no order quantity unit configured for ${ex} (AI_AUTO_EXIT_QTY_UNITS)`);
  const sym = String(tradingsymbol ?? '').toUpperCase();
  if (sym && (a.hold ?? []).includes(sym)) return fail(`${sym} is on the owner's hold list — the SL exit would be skipped`);
  return { ok: true, detail: `price trigger → AI exit (live, ${ex} in ${unit})`, qtyUnit: unit };
}

/** The entry order: ALWAYS a LIMIT. Throws on anything that would make it otherwise. */
export function buildEntryOrder(plan: EntryPlan, product: SignalProduct, qtyUnit: QtyUnit | null): OrderRequest {
  if (!(plan.limitPrice > 0)) throw new Error('refusing to build an entry without a positive LIMIT price');
  if (!(plan.qty >= 1)) throw new Error('refusing to build an entry with no quantity');
  const quantity = qtyUnit === 'lots' ? plan.lots : plan.qty;
  return {
    symbol: plan.tradingsymbol,
    token: plan.token,
    exchange: plan.exchange,
    side: plan.side,
    orderType: 'LIMIT',
    quantity,
    price: plan.limitPrice,
    positionType: product,
  };
}

/** The exitTrigger the trade sentinel's price-trigger watch arms (StoredExitTriggerV1, PREMIUM = the contract's own price). */
export function slExitTrigger(plan: Pick<EntryPlan, 'side' | 'sl'>, seen: { price: number; at: string }) {
  return {
    v: 1 as const,
    instrument: 'PREMIUM' as const,
    op: plan.side === 'BUY' ? ('BELOW' as const) : ('ABOVE' as const),
    price: plan.sl,
    watch: null,
    seen,
  };
}

/** IST midnight that starts `now`'s IST day, as a UTC instant. */
export function istDayStart(now: Date): Date {
  const off = 5.5 * 3_600_000;
  const d = new Date(now.getTime() + off);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - off);
}
