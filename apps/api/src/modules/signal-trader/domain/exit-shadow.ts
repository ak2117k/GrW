import { noiseAwareFloor } from '../../exit-discipline/floor';
import { noiseGiveback } from '../../exit-discipline/giveback';

/**
 * Paper exit shadow, stage 1 (docs/superpowers/specs/2026-10-28-paper-exit-shadow-design.md). Pure.
 *
 * A paper trade in learning mode has no stop: it exits at T1 or the square-off, which is the "held"
 * baseline. Beside it, the live exit rules are stepped on every paper-watch LTP and the FIRST time each
 * would have exited is recorded — never acted on:
 *   STOP     — the plan's reference stop (channel / engine) crossed;
 *   FLOOR    — exit-discipline's breakeven-then-trail noise floor (the live green floor) breached;
 *   GIVEBACK — exit-discipline's giveback: ≥ armN·N in favour, then ≥ givebackN·N given back off the peak.
 * FLOOR and GIVEBACK need a noise unit N (contract 1-min ATR); without one they are not stepped.
 * Breakeven is the entry price (charges not added — the same on both sides of the comparison).
 */
export type ShadowRule = 'STOP' | 'FLOOR' | 'GIVEBACK';
export const SHADOW_RULES: readonly ShadowRule[] = ['STOP', 'FLOOR', 'GIVEBACK'];

export interface ShadowHit {
  at: string;
  price: number;
  reason: string;
}

/** The running state (persisted as the TRACK row so a restart keeps the peak and the floor latches). */
export interface ShadowState {
  /** Best price seen since entry (highest for a buy, lowest for a sell). */
  peak: number | null;
  floorArmed: boolean;
  floorLevel: number | null;
  hits: Partial<Record<ShadowRule, ShadowHit>>;
}

export interface ShadowParams {
  armN: number;
  trailN: number;
  givebackN: number;
}

export const emptyShadow = (): ShadowState => ({ peak: null, floorArmed: false, floorLevel: null, hits: {} });

const r2 = (n: number) => Math.round(n * 100) / 100;

export function stepShadow(
  prev: ShadowState,
  i: { side: string; entry: number; ltp: number | null; refSl: number | null; n: number | null; params: ShadowParams; now: Date },
): { state: ShadowState; hits: Array<{ rule: ShadowRule; hit: ShadowHit }> } {
  const ltp = i.ltp;
  if (ltp === null || !(ltp > 0) || !(i.entry > 0)) return { state: prev, hits: [] };
  const buy = String(i.side).toUpperCase() === 'BUY';
  const posSide = buy ? 'LONG' : 'SHORT';
  const at = i.now.toISOString();
  const state: ShadowState = { ...prev, hits: { ...prev.hits } };
  state.peak = state.peak === null ? ltp : buy ? Math.max(state.peak, ltp) : Math.min(state.peak, ltp);
  const out: Array<{ rule: ShadowRule; hit: ShadowHit }> = [];
  const record = (rule: ShadowRule, reason: string) => {
    if (state.hits[rule]) return;
    const hit = { at, price: ltp, reason };
    state.hits[rule] = hit;
    out.push({ rule, hit });
  };

  if (i.refSl !== null && i.refSl > 0 && (buy ? ltp <= i.refSl : ltp >= i.refSl)) {
    record('STOP', `stop ${i.refSl} crossed (LTP ${ltp})`);
  }

  const n = i.n !== null && Number.isFinite(i.n) && i.n > 0 ? i.n : null;
  if (n !== null) {
    const f = noiseAwareFloor({
      side: posSide,
      breakeven: i.entry,
      peak: state.peak,
      n,
      armN: i.params.armN,
      trailN: i.params.trailN,
      prevArmedLevel: state.floorArmed ? state.floorLevel : null,
      latchedArmed: state.floorArmed,
    });
    if (f.armed) {
      state.floorArmed = true;
      state.floorLevel = f.level;
      if (buy ? ltp <= f.level : ltp >= f.level) record('FLOOR', `trail floor ${f.level} breached (peak ${r2(state.peak)}, N ${r2(n)})`);
    }
    const g = noiseGiveback({ side: posSide, entryPrice: i.entry, ltp, peak: state.peak, n, armN: i.params.armN, givebackN: i.params.givebackN });
    if (g?.fire) record('GIVEBACK', `gave back ${r2(g.pullback)} of a ${r2(g.excursion)} run (N ${r2(n)})`);
  }
  return { state, hits: out };
}

/** Gross ₹ of exiting at `exit`: the same formula for the held trade and every rule. */
export function grossPnl(side: string, entry: number, exit: number, qty: number): number {
  const sign = String(side).toUpperCase() === 'BUY' ? 1 : -1;
  return r2(sign * (exit - entry) * qty);
}

/** "stop 10:42 −₹1.2k · trail 11:05 +₹300 · held +₹800" — the line on the closed paper trade. */
export function shadowLine(hits: Partial<Record<string, { at: string; rulePnl: number }>>, held: number): string {
  const label: Record<string, string> = { STOP: 'stop', FLOOR: 'trail', GIVEBACK: 'giveback', AI_EXIT: 'AI', AI_TRIGGER: 'AI trigger' };
  const inr = (v: number) => `${v < 0 ? '−' : '+'}₹${Math.abs(v) >= 1000 ? `${r2(Math.abs(v) / 1000)}k` : Math.round(Math.abs(v))}`;
  const ist = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3_600_000).toISOString().slice(11, 16);
  const parts = Object.entries(hits)
    .filter((e): e is [string, { at: string; rulePnl: number }] => !!e[1])
    .sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at))
    .map(([rule, h]) => `${label[rule] ?? rule} ${ist(h.at)} ${inr(h.rulePnl)}`);
  return [...parts, `held ${inr(held)}`].join(' · ');
}
