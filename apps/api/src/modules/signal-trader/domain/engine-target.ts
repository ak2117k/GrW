import { ceilToTick, floorToTick } from './gate';
import { longUnderlying } from './engine-sl';
import type { InstrumentKind, Side } from './signal.types';

/**
 * Engine-derived targets when the channel gives none ("CMP 250 BUY", "SL 230" and nothing else). Pure.
 *
 * Mirrors the engine SL (domain/engine-sl): levels on the UNDERLYING, carried to the contract.
 *  1. The level book's lines AHEAD of the spot in the trade's direction (resistance for a long
 *     underlying view, support for a short one), nearest first, as a move on the underlying —
 *       EQ / FUT: the same move applied to the contract's price;
 *       CE/PE:    the move × |delta| applied to the premium.
 *     A level closer than 1 × the stop distance is skipped (an intraday line hugging the price
 *     would make T1 a coin-flip scalp, not a target).
 *  2. Any slot still empty: a multiple of the stop distance — T1 1.5 R, T2 2.5 R.
 *  3. No usable level and no stop → no targets (the trade exits at the close / horizon rules).
 */
export type EngineTargetMethod = 'level' | 'level_fut' | 'level_delta' | 'r_multiple';

export interface EngineTargetInput {
  kind: InstrumentKind;
  side: Side;
  /** The contract's price the entry is planned at. */
  price: number;
  tick: number;
  /** Underlying price the levels are compared with (null = unknown). For EQ = the stock price. */
  spot: number | null;
  /** Every level-book line, on the underlying's scale. */
  levels: number[];
  /** Option delta (sign ignored); null = no greeks. */
  delta: number | null;
  /** The stop the plan uses (channel's or engine's), on the contract's scale; null = none. */
  sl: number | null;
}

export interface EngineTargets {
  targets: number[];
  methods: EngineTargetMethod[];
  detail: string;
}

export const ENGINE_TARGET_R = [1.5, 2.5] as const;
/** A level target must pay at least this many R. */
export const MIN_LEVEL_R = 1;
const SLOTS = ENGINE_TARGET_R.length;

const r2 = (n: number) => Math.round(n * 100) / 100;
const pos = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function deriveEngineTargets(i: EngineTargetInput): EngineTargets {
  if (!pos(i.price)) return { targets: [], methods: [], detail: 'no entry price to derive targets from' };
  const tick = i.tick > 0 ? i.tick : 0.05;
  // The contract's favourable direction: up for a BUY (premium, future or share), down for a SELL.
  const dir = i.side === 'BUY' ? 1 : -1;
  // Rounded toward the entry: a target is never promised further than the level carries it.
  const round = (p: number) => (dir === 1 ? floorToTick(p, tick) : ceilToTick(p, tick));
  const risk = pos(i.sl) && (dir === 1 ? i.sl < i.price : i.sl > i.price) ? Math.abs(i.price - i.sl) : null;
  const option = i.kind === 'CE' || i.kind === 'PE';
  const d = i.delta === null || !Number.isFinite(i.delta) ? null : Math.abs(i.delta);

  const targets: number[] = [];
  const methods: EngineTargetMethod[] = [];
  const notes: string[] = [];
  const beyondLast = (t: number) => t > 0 && dir * (t - i.price) > 0 && (targets.length === 0 || dir * (t - targets[targets.length - 1]) > 0);

  let levelNote: string;
  if (!pos(i.spot)) levelNote = 'no underlying price';
  else if (option && !(d !== null && d > 0 && d <= 1)) levelNote = 'no delta';
  else {
    const spot = i.spot;
    const long = longUnderlying(i.kind, i.side);
    const ahead = [...new Set(i.levels.filter((v) => pos(v) && (long ? v > spot : v < spot)))].sort((a, b) => (long ? a - b : b - a));
    const method: EngineTargetMethod = i.kind === 'EQ' ? 'level' : option ? 'level_delta' : 'level_fut';
    let tooClose = 0;
    for (const level of ahead) {
      if (targets.length === SLOTS) break;
      const move = Math.abs(level - spot) * (option ? (d as number) : 1);
      const t = round(i.price + dir * move);
      if (!beyondLast(t)) continue;
      if (risk !== null && Math.abs(t - i.price) < MIN_LEVEL_R * risk) {
        tooClose++;
        continue;
      }
      targets.push(t);
      methods.push(method);
      notes.push(`T${targets.length} ${t} = ${long ? 'resistance' : 'support'} ${r2(level)} (spot ${r2(spot)}${option ? `, delta ${r2(d as number)}` : ''})`);
    }
    levelNote = ahead.length === 0 ? `no level ${long ? 'above' : 'below'} spot ${r2(spot)}` : tooClose > 0 && targets.length < SLOTS ? `${tooClose} level(s) closer than ${MIN_LEVEL_R} R skipped` : '';
  }

  if (targets.length < SLOTS && risk !== null) {
    for (let k = targets.length; k < SLOTS; k++) {
      let t = round(i.price + dir * ENGINE_TARGET_R[k] * risk);
      if (!beyondLast(t)) t = round(targets[targets.length - 1] + dir * risk);
      if (!beyondLast(t)) break;
      targets.push(t);
      methods.push('r_multiple');
      notes.push(`T${targets.length} ${t} = ${r2(Math.abs(t - i.price) / risk)} R (risk ${r2(risk)})`);
    }
  }

  if (targets.length === 0) {
    const why = [levelNote, risk === null ? 'no stop to size an R target' : ''].filter(Boolean).join('; ');
    return { targets: [], methods: [], detail: `no targets: ${why || 'nothing usable'}` };
  }
  const fallbackWhy = methods.includes('r_multiple') && levelNote ? ` — ${levelNote}` : '';
  return { targets, methods, detail: `${notes.join('; ')}${fallbackWhy}` };
}
