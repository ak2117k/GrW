import { INVALIDATION_SCALE_TOLERANCE } from './config';
import { exposureOf } from './exposure';
import { readPacketFacts } from './packet-facts';
import type { Exposure, MinuteBar } from './types';

/**
 * CUT-LOSS TRIGGER YARDSTICK (2026-11-11). Pure.
 *
 * Prod 2026-11-11, three paper engine calls entered 09:50 IST (NIFTY 25400 CE, BANKNIFTY 60800 CE, SENSEX
 * 82500 CE): every one was sold by an AI UNDERLYING trigger the judge put "2 noise units below
 * money.anchors.best", N = ATR14 of ONE-MINUTE bars. BANKNIFTY's 2N was ~84 pts while its ordinary 5-minute
 * bars ranged 100–150; the thesis invalidation sat 270–1000 pts away and no planned premium stop was ever
 * reached. widenExitTrigger (hard-floor.ts) already pushes a protective level out to K one-minute N; the
 * judge simply sat ON that line, so K on one-minute N is the wrong yardstick for a level whose job is to
 * say "the trade is wrong".
 *
 * The rule — for a protective UNDERLYING trigger whose purpose is CUT_LOSS (net P&L not green and no green
 * floor armed, trigger-check.ts' purpose) — is a minimum distance from the fixed reference (the floor's
 * arm point, else the best point, else the underlying now, as widenExitTrigger) of
 *     max(K × N1, K15 × N15)
 * N1 = the packet's one-minute underlying N, K = FLOOR_HARD_EXIT_N (money.anchors.hardExitN), N15 = ATR14 of
 * the underlying's 15-minute session bars, K15 = TRIGGER_CUT_LOSS_N15 (default 1.5). Never beyond the thesis
 * invalidation: when that sits closer than the minimum, the level is the invalidation itself. A
 * PROTECT_PROFIT trigger keeps today's rule.
 *
 * The ratchet exception (`cutLossLoosen`): the tighten-only rule may let a new CUT_LOSS level LOOSEN the armed
 * one only when the armed level was tight (its check said so, or it sits inside the new minimum), the new
 * verdict says the thesis is INTACT, and the new level is no looser than the invalidation (else the widened
 * minimum). Prod 2026-11-11 BANKNIFTY: the judge widened to 60660 and then 59741 (thesis INTACT); both were
 * refused LOOSENS and the old 60708 fired 5 s later at 687 — the premium then went to 994.
 *
 * Acts on PAPER trades (paper-sentinel); RECORD ONLY on real triggers (sentinel-executor trigger watch).
 */

/** TRIGGER_CUT_LOSS_N15 default: the minimum CUT_LOSS distance in 15-minute noise units. */
export const CUT_LOSS_N15_DEFAULT = 1.5;
/** The 15-minute ATR period. */
export const N15_PERIOD = 14;
/** Below this many completed 15-minute session bars there is no N15 (the rule is K × N1, as before). */
export const N15_MIN_BARS = 5;
/** How far back the 15-minute read reaches (a weekend and a holiday). */
export const N15_LOOKBACK_DAYS = 5;

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r2 = (x: number) => Math.round(x * 100) / 100;
const IST_MS = 5.5 * 3_600_000;

/** TRIGGER_CUT_LOSS_N15: unset/blank/junk ⇒ 1.5; 0 or `off` ⇒ null (the rule is off, K × N1 only). Range (0, 6]. */
export function cutLossK15(env: Record<string, string | undefined> = process.env): number | null {
  const raw = String(env.TRIGGER_CUT_LOSS_N15 ?? '').trim().toLowerCase();
  if (raw === '') return CUT_LOSS_N15_DEFAULT;
  if (raw === 'off' || raw === '0') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 6 ? n : CUT_LOSS_N15_DEFAULT;
}

export type N15Reading = { n: number; bars: number; method: 'atr14-15m' | 'mean-tr-15m'; at: string };

/** The IST session window (minutes after midnight) a 15-minute bar must START inside; null = keep every bar. */
function sessionWindow(exchange: string | null | undefined): [number, number] | null {
  const ex = String(exchange ?? '').toUpperCase();
  if (['NSE', 'NFO', 'BSE', 'BFO'].includes(ex)) return [555, 930];
  if (ex.startsWith('MCX')) return [540, 1435];
  return null;
}

/**
 * N15 from 15-minute bars (bucket start ts; candles_1m rolled up). Only bars that START inside the
 * exchange's session (no NSE pre-open 09:00 bucket) and have CLOSED by `nowMs`. True range uses the
 * previous bar's close only within one IST day — the overnight gap is not a 15-minute swing. ATR14 of
 * the last 14; with 5–13 bars the mean of what there is ('mean-tr-15m'); fewer ⇒ null.
 */
export function n15FromBars(input: MinuteBar[], exchange: string | null | undefined, nowMs: number): N15Reading | null {
  const win = sessionWindow(exchange);
  const bars = input
    .filter((b) => [b.ts, b.open, b.high, b.low, b.close].every(fin) && b.low > 0 && b.high >= b.low)
    .filter((b) => b.ts + 15 * 60_000 <= nowMs)
    .filter((b) => {
      if (!win) return true;
      const ist = new Date(b.ts + IST_MS);
      const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
      return m >= win[0] && m < win[1];
    })
    .sort((a, b) => a.ts - b.ts);
  if (bars.length < N15_MIN_BARS) return null;
  const day = (ts: number) => Math.floor((ts + IST_MS) / 86_400_000);
  const tr = bars.map((b, i) => {
    const prev = i > 0 && day(bars[i - 1].ts) === day(b.ts) ? bars[i - 1].close : null;
    return prev === null ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  });
  const last = tr.slice(-N15_PERIOD);
  const n = last.reduce((s, x) => s + x, 0) / last.length;
  if (!(n > 0)) return null;
  return {
    n: r2(n),
    bars: last.length,
    method: last.length >= N15_PERIOD ? 'atr14-15m' : 'mean-tr-15m',
    at: new Date(bars[bars.length - 1].ts + 15 * 60_000).toISOString(),
  };
}

export type TriggerPurpose = 'CUT_LOSS' | 'PROTECT_PROFIT';

/** trigger-check.ts' purpose: green net P&L or an armed green floor ⇒ PROTECT_PROFIT, else CUT_LOSS. */
export const purposeOf = (netPnl: number | null, greenFloorArmed: boolean): TriggerPurpose =>
  (fin(netPnl) && netPnl > 0) || greenFloorArmed ? 'PROTECT_PROFIT' : 'CUT_LOSS';

export interface CutLossLevelInput {
  instrument: 'UNDERLYING' | 'PREMIUM';
  op: 'BELOW' | 'ABOVE';
  /** The proposed level (after widenExitTrigger). */
  price: number;
  exposure: Exposure | null;
  purpose: TriggerPurpose;
  floorArmUnderlying: number | null;
  bestUnderlying: number | null;
  underlyingNow: number | null;
  n1: number | null;
  /** FLOOR_HARD_EXIT_N. */
  k: number | null;
  n15: number | null;
  /** TRIGGER_CUT_LOSS_N15; null = off. */
  k15: number | null;
  /** The thesis invalidation on the underlying's scale (see `invalidationCap`); null when unknown. */
  invalidation: number | null;
}

export type CutLossSkip = 'NOT_UNDERLYING' | 'NO_EXPOSURE' | 'NOT_PROTECTIVE' | 'PROTECT_PROFIT' | 'NO_REFERENCE' | 'NO_NOISE_UNIT';

/** A `type` so it is assignable to Prisma JSON. */
export type CutLossLevel = {
  applies: boolean;
  skip: CutLossSkip | null;
  /** The level to arm (== the proposal unless widened). */
  price: number;
  /** The proposal, when widened. */
  widenedFrom: number | null;
  ref: number | null;
  refSource: 'FLOOR_ARM' | 'BEST' | 'NOW' | null;
  /** K × N1 and K15 × N15, points (null when unknown). */
  gapN1: number | null;
  gapN15: number | null;
  /** max of the two, points. */
  minDistance: number | null;
  /** ref ∓ minDistance — the closest a CUT_LOSS level may sit, before the invalidation cap. */
  minLevel: number | null;
  invalidation: number | null;
  /** The minimum reached past the invalidation, so the level is the invalidation. */
  cappedByInvalidation: boolean;
};

export function cutLossLevel(i: CutLossLevelInput): CutLossLevel {
  const base: CutLossLevel = {
    applies: false, skip: null, price: i.price, widenedFrom: null, ref: null, refSource: null,
    gapN1: null, gapN15: null, minDistance: null, minLevel: null, invalidation: fin(i.invalidation) ? i.invalidation : null, cappedByInvalidation: false,
  };
  const skip = (s: CutLossSkip): CutLossLevel => ({ ...base, skip: s });
  if (i.instrument !== 'UNDERLYING') return skip('NOT_UNDERLYING');
  if (i.exposure === null) return skip('NO_EXPOSURE');
  const bull = i.exposure === 'BULLISH';
  if ((bull ? 'BELOW' : 'ABOVE') !== i.op) return skip('NOT_PROTECTIVE');
  if (i.purpose !== 'CUT_LOSS') return skip('PROTECT_PROFIT');
  const refs: Array<[number | null, CutLossLevel['refSource']]> = [[i.floorArmUnderlying, 'FLOOR_ARM'], [i.bestUnderlying, 'BEST'], [i.underlyingNow, 'NOW']];
  const hit = refs.find(([x]) => fin(x) && (x as number) > 0);
  if (!hit) return skip('NO_REFERENCE');
  const ref = hit[0] as number;
  const gapN1 = fin(i.n1) && i.n1 > 0 && fin(i.k) && i.k > 0 ? r2(i.k * i.n1) : null;
  const gapN15 = fin(i.n15) && i.n15 > 0 && fin(i.k15) && i.k15 > 0 ? r2(i.k15 * i.n15) : null;
  const gaps = [gapN1, gapN15].filter(fin);
  if (gaps.length === 0) return { ...skip('NO_NOISE_UNIT'), ref, refSource: hit[1] };
  const minDistance = Math.max(...gaps);
  const minLevel = r2(bull ? ref - minDistance : ref + minDistance);
  // The invalidation counts only on the adverse side of the reference.
  const inv = base.invalidation !== null && (bull ? base.invalidation < ref : base.invalidation > ref) ? base.invalidation : null;
  const capped = inv !== null && (bull ? minLevel < inv : minLevel > inv);
  const limit = capped ? (inv as number) : minLevel;
  const tooClose = bull ? i.price > limit : i.price < limit;
  return {
    ...base, applies: true, price: tooClose ? limit : i.price, widenedFrom: tooClose ? i.price : null,
    ref, refSource: hit[1], gapN1, gapN15, minDistance: r2(minDistance), minLevel, invalidation: inv, cappedByInvalidation: capped && tooClose,
  };
}

export interface CutLossLoosenInput {
  armed: { instrument: string; op: string; price: number; tight: boolean | null };
  /** The new level (after `cutLossLevel`). */
  proposal: { instrument: string; op: string; price: number };
  level: CutLossLevel;
  /** The new verdict's thesisStatus (INTACT / WEAKENING / BROKEN …). */
  thesisStatus: string | null;
  /** The new verdict's reason text — read only when thesisStatus is absent. */
  reasonText?: string | null;
}

export type CutLossLoosen = { allow: boolean; why: string };

/**
 * May this new CUT_LOSS level LOOSEN the armed trigger? Everything else keeps tighten-only. A level that does
 * not loosen is not this function's business (allow: false, why NOT_LOOSER).
 */
export function cutLossLoosen(i: CutLossLoosenInput): CutLossLoosen {
  const no = (why: string): CutLossLoosen => ({ allow: false, why });
  const { armed: a, proposal: p, level } = i;
  if (a.instrument !== 'UNDERLYING' || p.instrument !== 'UNDERLYING' || a.op !== p.op) return no('NOT_SAME_UNDERLYING_SIDE');
  const below = p.op === 'BELOW';
  if (!(below ? p.price < a.price : p.price > a.price)) return no('NOT_LOOSER');
  if (!level.applies) return no(`NOT_CUT_LOSS (${level.skip})`);
  const status = String(i.thesisStatus ?? '').trim().toUpperCase();
  const intact = status !== '' ? status === 'INTACT' : /thesis\s+(?:is\s+|remains\s+|still\s+)?intact/i.test(String(i.reasonText ?? ''));
  if (!intact) return no(`THESIS_${status || 'UNSTATED'}`);
  const insideMin = level.minLevel !== null && (below ? a.price > level.minLevel : a.price < level.minLevel);
  if (a.tight !== true && !insideMin) return no('ARMED_NOT_TIGHT');
  const bound = level.invalidation ?? level.minLevel;
  if (bound === null) return no('NO_BOUND');
  if (below ? p.price < bound - 1e-9 : p.price > bound + 1e-9) return no('BEYOND_BOUND');
  return { allow: true, why: a.tight === true ? 'ARMED_TIGHT' : 'ARMED_INSIDE_MIN' };
}

const NUMBER = /\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/**
 * The invalidation that caps the widening, on the underlying's scale and on the adverse side of `ref`:
 * the packet thesis's invalidation first; else the FURTHEST adverse on-scale number in the verdict's
 * invalidationPoint text other than the trigger level itself. (trigger-check's parse takes the text's
 * FIRST number, which for "below 60708 — two noise units below …" is the trigger, not the thesis.)
 */
export function invalidationCap(i: {
  thesisInvalidation: number | null;
  text: string | null | undefined;
  triggerPrice: number;
  ref: number | null;
  exposure: Exposure | null;
}): { value: number | null; source: 'PACKET_THESIS' | 'VERDICT_TEXT' | null } {
  if (!fin(i.ref) || i.ref <= 0 || i.exposure === null) return { value: null, source: null };
  const ref = i.ref;
  const bull = i.exposure === 'BULLISH';
  const adverse = (x: number) => (bull ? x < ref : x > ref) && Math.abs(x - ref) / ref <= INVALIDATION_SCALE_TOLERANCE;
  if (fin(i.thesisInvalidation) && adverse(i.thesisInvalidation)) return { value: i.thesisInvalidation, source: 'PACKET_THESIS' };
  if (typeof i.text !== 'string') return { value: null, source: null };
  const nums = [...i.text.matchAll(NUMBER)].map((m) => Number(m[0].replace(/,/g, '')))
    .filter((x) => fin(x) && x > 0 && adverse(x) && Math.abs(x - i.triggerPrice) > 1e-6);
  if (nums.length === 0) return { value: null, source: null };
  return { value: bull ? Math.min(...nums) : Math.max(...nums), source: 'VERDICT_TEXT' };
}

/** What the packet stored at arming says, for `cutLossLevel`. Null when unreadable. */
export function cutLossBasisFromPacket(packet: unknown, netPnl: number | null | undefined): {
  exposure: Exposure; purpose: TriggerPurpose; floorArmUnderlying: number | null; bestUnderlying: number | null;
  underlyingNow: number | null; n1: number | null; k: number | null; thesisInvalidation: number | null;
} | null {
  try {
    const f = readPacketFacts(packet);
    if ('unreadable' in f) return null;
    const money = (packet as { money?: { anchors?: { hardExitN?: unknown } } }).money;
    const k = money?.anchors?.hardExitN;
    const net = fin(netPnl) ? netPnl : f.netPnl;
    return {
      exposure: exposureOf(f.symbol, f.side),
      purpose: purposeOf(net, f.floor.armed),
      floorArmUnderlying: f.anchors?.armUnderlying ?? null,
      bestUnderlying: f.anchors?.bestUnderlying ?? null,
      underlyingNow: f.underlying,
      n1: f.noise?.underlying?.n ?? null,
      k: fin(k) && k > 0 ? k : null,
      thesisInvalidation: f.invalidation,
    };
  } catch {
    return null;
  }
}

/** The record fields carried on a trigger check (sentinel_exit_triggers.check / paper look exitTrigger.check). */
export type CutLossRecord = {
  /** The level the CUT_LOSS yardstick arms (paper) / would have armed (real). */
  wouldArmAt: number;
  n15: number | null;
  n15Bars: number | null;
  k15: number | null;
  /** Ratchet exception against the trigger armed at the time; null when none was armed or it did not loosen. */
  wouldAllowLoosen: boolean | null;
  loosenWhy: string | null;
  /** true: paper, the level was armed; false: real, record only. */
  acted: boolean;
  cutLoss: CutLossLevel;
};

/** Prior-to-this-module K default (FLOOR_HARD_EXIT_N) when the packet does not carry money.anchors.hardExitN. */
export const DEFAULT_HARD_EXIT_N = 2;

/**
 * One call for both paths: the CUT_LOSS level for a proposal from the arming verdict's packet, and — when
 * a trigger is armed and the new level loosens it — the ratchet exception. Never throws (null basis ⇒ null).
 */
export function cutLossFromPacket(i: {
  instrument: 'UNDERLYING' | 'PREMIUM';
  op: 'BELOW' | 'ABOVE';
  price: number;
  packet: unknown;
  invalidationPoint: string | null | undefined;
  netPnl: number | null | undefined;
  /** The underlying price the trigger is armed against (falls back to the packet's). */
  underlyingNow: number | null;
  n15: N15Reading | null;
  k15: number | null;
  thesisStatus: string | null;
  reasonText?: string | null;
  armed: { instrument: string; op: string; price: number; tight: boolean | null } | null;
  acted: boolean;
}): CutLossRecord | null {
  try {
    const b = cutLossBasisFromPacket(i.packet, i.netPnl);
    if (!b) return null;
    // "Now" is the underlying the judge saw (the packet's), as widenExitTrigger; the arming price only when the
    // packet has none — a reference that follows the arming price would slide the level along with the market.
    const now = fin(b.underlyingNow) && b.underlyingNow > 0 ? b.underlyingNow : fin(i.underlyingNow) ? i.underlyingNow : null;
    const ref = [b.floorArmUnderlying, b.bestUnderlying, now].find((x) => fin(x) && x > 0) ?? null;
    const inv = invalidationCap({ thesisInvalidation: b.thesisInvalidation, text: i.invalidationPoint, triggerPrice: i.price, ref, exposure: b.exposure });
    const level = cutLossLevel({
      instrument: i.instrument, op: i.op, price: i.price, exposure: b.exposure, purpose: b.purpose,
      floorArmUnderlying: b.floorArmUnderlying, bestUnderlying: b.bestUnderlying,
      underlyingNow: now,
      n1: b.n1, k: b.k ?? DEFAULT_HARD_EXIT_N, n15: i.n15?.n ?? null, k15: i.k15, invalidation: inv.value,
    });
    const loosen = i.armed
      ? cutLossLoosen({ armed: i.armed, proposal: { instrument: i.instrument, op: i.op, price: level.price }, level, thesisStatus: i.thesisStatus, reasonText: i.reasonText })
      : null;
    const loosening = loosen !== null && loosen.why !== 'NOT_LOOSER' && loosen.why !== 'NOT_SAME_UNDERLYING_SIDE';
    return {
      wouldArmAt: level.price,
      n15: i.n15?.n ?? null,
      n15Bars: i.n15?.bars ?? null,
      k15: i.k15,
      wouldAllowLoosen: loosening ? loosen!.allow : null,
      loosenWhy: loosening ? loosen!.why : null,
      acted: i.acted,
      cutLoss: level,
    };
  } catch {
    return null;
  }
}
