import type { Side } from '../charges';
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
 * the contract's price moved by `priceMovePct`, the giveback found a new peak or
 * deepened by a noise-unit fraction, or a new volume bar closed.
 *
 * What it can NEVER suppress: any wake that carries another sensor's fire
 * (level-break, exit-confirm, news-hit, event-near, oi-wall-shift, a factor
 * flip, carried fires) — the decision then passes through whole, these two
 * fires included as context. Heartbeats are untouched. Hard exits are not on
 * this path at all: they live in the exit-discipline gate and the executor.
 *
 * Baselines are in-process memory (recorded only after a judgement on that fire
 * was RECORDED). A restart forgets them, which costs at most one extra call per
 * position — the safe direction.
 */

export const GIVEBACK_OFF_PEAK = 'giveback-off-peak';
export const VOLUME_ANOMALY = 'volume-anomaly';
export const SUPPRESSIBLE_FIRES: ReadonlySet<string> = new Set([GIVEBACK_OFF_PEAK, VOLUME_ANOMALY]);

export const REJUDGE_CONFIG = 'REJUDGE_CONFIG';

export interface RejudgeConfig {
  /** SENTINEL_REJUDGE_SUPPRESSION — default true; rollback is `false`. */
  enabled: boolean;
  /** SENTINEL_REJUDGE_COOLDOWN_MIN (default 10): an unchanged repeat is re-judged after this long anyway. */
  cooldownMs: number;
  /** SENTINEL_REJUDGE_PRICE_MOVE_PCT (default 0.02): contract-price move, either way, that is always material. */
  priceMovePct: number;
  /** SENTINEL_REJUDGE_GIVEBACK_DEEPEN_N (default 0.5): pullback deepening, in noise units, that is material. */
  givebackDeepenN: number;
  /** SENTINEL_REJUDGE_GIVEBACK_DEEPEN_FRAC (default 0.1): without a noise unit, deepening as a fraction of the peak excursion. */
  givebackDeepenFrac: number;
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
    givebackDeepenN: positive(env.SENTINEL_REJUDGE_GIVEBACK_DEEPEN_N, 0.5),
    givebackDeepenFrac: positive(env.SENTINEL_REJUDGE_GIVEBACK_DEEPEN_FRAC, 0.1),
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
}

export function rejudgeSnapshot(
  t: {
    side: Side;
    entryPrice: number;
    ltp: number;
    qty: number;
    holdingHigh: number | null;
    holdingLow: number | null;
    volumeRatio: number | null;
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
  };
}

/**
 * Whether a repeat of `fire` against `last` (the state when the judge was last
 * asked about it) is worth another call. Fails OPEN: anything unreadable is material.
 */
export function repeatIsMaterial(
  fire: string,
  last: RejudgeSnapshot | undefined,
  now: RejudgeSnapshot,
  cfg: RejudgeConfig,
): boolean {
  if (!last) return true;
  if (now.at - last.at >= cfg.cooldownMs) return true;
  if (last.qty !== now.qty) return true;
  if (!Number.isFinite(last.ltp) || last.ltp <= 0 || !Number.isFinite(now.ltp)) return true;
  if (Math.abs(now.ltp - last.ltp) / last.ltp >= cfg.priceMovePct) return true;

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
): { decision: TripwireResult; suppressed: string[] } {
  const untouched = { decision, suppressed: [] as string[] };
  if (!cfg.enabled || decision.fires.length === 0) return untouched;
  if (decision.fires.some((f) => !SUPPRESSIBLE_FIRES.has(f.name))) return untouched;
  if (decision.fires.some((f) => repeatIsMaterial(f.name, baselines[f.name], now, cfg))) return untouched;
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
