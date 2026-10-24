import { ceilToTick, floorToTick } from './gate';
import type { InstrumentKind, Side } from './signal.types';

/**
 * Engine-derived SL when the channel hides it ("SL PAID", "SL in premium", none). Pure.
 *
 * Order of preference:
 *  1. The underlying's level book: the nearest PROTECTIVE level beyond the entry (support for a long
 *     underlying view, resistance for a short one) plus a buffer, as a move on the underlying —
 *       EQ:   the level itself (the stock is its own underlying);
 *       FUT:  the same move applied to the future's price (basis-neutral);
 *       CE/PE: the move × |delta| applied to the premium (delta from the chain snapshot's greeks).
 *  2. Fallback: options — a premium % stop (SIGNAL_ENGINE_SL_OPTION_PCT, default 25 %);
 *     futures — 1 × the contract's daily ATR(14).
 *  3. Nothing usable → no SL (the gate SKIPs `sl_present`).
 *
 * The result is never accepted here: sizing (sizeEntry) still enforces risk ≤ SIGNAL_MAX_LOSS_PER_TRADE
 * after the lot cap (resize DOWN allowed, never up), and the judge is told the SL is engine-derived.
 */
export type EngineSlMethod = 'level' | 'level_fut' | 'level_delta' | 'premium_pct' | 'atr';

export interface EngineSlInput {
  kind: InstrumentKind;
  side: Side;
  /** The contract's price the entry is planned at (LTP, or the trigger price for a pending trigger). */
  price: number;
  tick: number;
  /** Underlying price the levels were read at (null = unknown). For EQ = the stock price. */
  spot: number | null;
  support: number | null;
  resistance: number | null;
  /** Option delta (sign ignored); null = no greeks. */
  delta: number | null;
  /** Daily ATR(14) of the contract itself (futures fallback). */
  atr: number | null;
  optionPct: number;
  bufferPct: number;
}

export type EngineSl = { sl: number; method: EngineSlMethod; detail: string } | { sl: null; method: null; detail: string };

const r2 = (n: number) => Math.round(n * 100) / 100;
const pos = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Does the position profit when the UNDERLYING rises? BUY CE / SELL PE / BUY FUT / BUY EQ. */
export function longUnderlying(kind: InstrumentKind, side: Side): boolean {
  if (kind === 'PE') return side === 'SELL';
  return side === 'BUY';
}

/** The protective level beyond the spot (with the buffer) and the underlying move to it, or null. */
function underlyingStop(i: EngineSlInput): { level: number; stop: number; move: number } | null {
  if (!pos(i.spot)) return null;
  const long = longUnderlying(i.kind, i.side);
  const level = long ? i.support : i.resistance;
  if (!pos(level)) return null;
  if (long ? level >= i.spot : level <= i.spot) return null; // not beyond the entry
  const b = i.bufferPct / 100;
  const stop = long ? level * (1 - b) : level * (1 + b);
  const move = Math.abs(i.spot - stop);
  return move > 0 ? { level, stop, move } : null;
}

/** Round to the tick on the protective side and check the stop is a real one. */
function finish(i: EngineSlInput, raw: number, method: EngineSlMethod, detail: string): EngineSl | null {
  if (!Number.isFinite(raw)) return null;
  const tick = i.tick > 0 ? i.tick : 0.05;
  const sl = i.side === 'BUY' ? floorToTick(raw, tick) : ceilToTick(raw, tick);
  if (!(sl > 0)) return null;
  if (i.side === 'BUY' ? sl >= i.price : sl <= i.price) return null;
  return { sl, method, detail };
}

export function deriveEngineSl(i: EngineSlInput): EngineSl {
  if (!pos(i.price)) return { sl: null, method: null, detail: 'no entry price to derive an SL from' };
  const u = underlyingStop(i);
  const lvl = u ? `${longUnderlying(i.kind, i.side) ? 'support' : 'resistance'} ${r2(u.level)} ± ${i.bufferPct}% → ${r2(u.stop)} (spot ${i.spot})` : null;

  if (i.kind === 'EQ') {
    if (u) {
      const hit = finish(i, u.stop, 'level', `level book ${lvl}`);
      if (hit) return hit;
    }
    return { sl: null, method: null, detail: 'no protective level in the level book' };
  }

  if (i.kind === 'FUT') {
    if (u) {
      const raw = i.side === 'BUY' ? i.price - u.move : i.price + u.move;
      const hit = finish(i, raw, 'level_fut', `level book ${lvl}: underlying move ${r2(u.move)} applied to the future ${i.price}`);
      if (hit) return hit;
    }
    if (pos(i.atr)) {
      const raw = i.side === 'BUY' ? i.price - i.atr : i.price + i.atr;
      const hit = finish(i, raw, 'atr', `1 × daily ATR ${r2(i.atr)} from ${i.price}${u ? '' : ' (no protective level)'}`);
      if (hit) return hit;
    }
    return { sl: null, method: null, detail: 'futures: no protective level and no ATR' };
  }

  // CE / PE
  const d = i.delta === null || !Number.isFinite(i.delta) ? null : Math.abs(i.delta);
  if (u && d !== null && d > 0 && d <= 1) {
    const premMove = u.move * d;
    const raw = i.side === 'BUY' ? i.price - premMove : i.price + premMove;
    const hit = finish(i, raw, 'level_delta', `level book ${lvl}: underlying move ${r2(u.move)} × delta ${r2(d)} = premium ${r2(premMove)}`);
    if (hit) return hit;
  }
  const pct = i.optionPct / 100;
  const raw = i.side === 'BUY' ? i.price * (1 - pct) : i.price * (1 + pct);
  const why = !u ? 'no protective level' : d === null ? 'no delta in the chain snapshot' : 'level/delta stop unusable';
  const hit = finish(i, raw, 'premium_pct', `${i.optionPct}% premium stop from ${i.price} (${why})`);
  return hit ?? { sl: null, method: null, detail: 'option: no usable premium stop' };
}
