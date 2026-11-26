import type { SignalView } from '../domain/signal.types';
import type { EntryPlan, GateCheck } from '../domain/gate';
import { fundsCheck, needsMargin, requiredFunds, type BrokerMargin, type FundsCheck, type FundsRequirement } from '../domain/funds';

/**
 * THE PRE-SEND CHECKS of a live entry, shared by the signal trader's `act()` and the desk manager's OPEN
 * (desk-manager spec §5.4 step 4): re-quote the contract right before the order, then the funds check
 * (broker margin for futures / option writing), with the optional MCX mini swap in between. No order is
 * built here and nothing is written; what to do with a failure (retry, paper, skip, refuse) is the caller's.
 *
 * Order of the returned `checks` is the order `act()` always recorded them in: pre_send_price, then
 * mini_fallback (when it applied), then funds.
 */
export interface PreSendInput {
  plan: EntryPlan;
  signal: Pick<SignalView, 'instrumentKind' | 'strike'>;
  cfg: { fundsBufferPct: number; futMarginPct: number };
  /** The fresh LTP of the plan's contract (null = no quote). */
  quote: () => Promise<number | null>;
  /** The broker margin-calculator answer for `plan` (asked only when the entry needs margin). Never throws. */
  margin: (plan: EntryPlan) => Promise<BrokerMargin>;
  /** The owner's usable funds (null = unknown). Never throws. */
  available: () => Promise<number | null>;
  /**
   * The MCX mini swap: null = not applicable; otherwise its check and, when the swap works, the plan on the mini.
   * `false` / absent = never swap (the desk manager: a short full lot is refused, never resized).
   */
  mini?: false | ((plan: EntryPlan, fresh: number, fundsOk: boolean | null, available: number | null) => Promise<{ check: GateCheck; plan: EntryPlan | null } | null>);
}

export type PreSendResult =
  | {
      stage: 'price';
      ok: false;
      fresh: number | null;
      /** false when the stop is already crossed (a dead call), true when only the band was missed. */
      stillProtective: boolean;
      recheck: GateCheck;
      checks: GateCheck[];
    }
  | {
      stage: 'funds';
      /** false only when funds are known and short (unknown funds are sent, as before). */
      ok: boolean;
      fresh: number;
      recheck: GateCheck;
      checks: GateCheck[];
      /** The plan to send (the mini's when the swap was taken). */
      plan: EntryPlan;
      need: FundsRequirement;
      available: number | null;
      funds: FundsCheck;
      mini: { check: GateCheck; plan: EntryPlan | null } | null;
    };

export async function preSendChecks(i: PreSendInput): Promise<PreSendResult> {
  let plan = i.plan;
  const fresh = await i.quote().catch(() => null);
  const inBand = fresh !== null && fresh >= plan.bandLow - 1e-9 && fresh <= plan.bandHigh + 1e-9;
  const stillProtective = fresh !== null && (plan.side === 'BUY' ? plan.sl < fresh : plan.sl > fresh);
  const recheck: GateCheck = {
    name: 'pre_send_price',
    ok: inBand && stillProtective,
    required: true,
    detail: fresh === null ? 'no fresh quote before sending' : `LTP ${fresh} vs band [${plan.bandLow}, ${plan.bandHigh}], SL ${plan.sl}`,
  };
  const checks: GateCheck[] = [recheck];
  if (!recheck.ok || fresh === null) return { stage: 'price', ok: false, fresh, stillProtective, recheck, checks };

  const broker = needsMargin(plan.side, i.signal.instrumentKind) ? await i.margin(plan) : null;
  let need = requiredFunds(plan, i.signal, i.cfg, broker);
  const available = await i.available();
  let funds = fundsCheck(available, need);
  const mini = i.mini ? await i.mini(plan, fresh, funds.ok, available) : null;
  if (mini) {
    checks.push(mini.check);
    if (mini.plan) {
      plan = mini.plan;
      need = requiredFunds(plan, i.signal, i.cfg, null);
      funds = fundsCheck(available, need);
    }
  }
  checks.push(funds);
  return { stage: 'funds', ok: funds.ok !== false, fresh, recheck, checks, plan, need, available, funds, mini };
}
