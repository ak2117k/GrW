import type { OptionData, OptionsChainEntry } from '@td/shared/types';
import type { QuoteOutcome } from '../quote-batcher';
import { refKey } from '../hub.types';
import type { ChainContract, ChainGreeksSource, OptionGreekRow, OptionSide } from './chain.types';
import { expiryCloseAt } from './chain-dates';

export const RISK_FREE_RATE = 0.065;
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
/** GreeksCalculatorService.calculateIV clamps its solver to [0.001, 5.0]; a result at a bound did not converge. */
export const IV_SOLVER_FLOOR = 0.001;
export const IV_SOLVER_CEILING = 5.0;

export interface GreeksMath {
  calculateIV(price: number, spot: number, strike: number, t: number, rate: number, type: OptionSide): number;
  calculateGreeks(spot: number, strike: number, t: number, rate: number, iv: number, type: OptionSide): {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
  };
}

/** `n` strikes each side of the listed strike nearest `centre` (median strike when null); both sides of each. */
export function pickStrikes(contracts: readonly ChainContract[], centre: number | null, n: number): ChainContract[] {
  const listed = [...new Set(contracts.map((c) => c.strike))].sort((a, b) => a - b);
  if (listed.length === 0) return [];
  let idx = Math.floor((listed.length - 1) / 2);
  if (centre !== null && centre > 0) {
    let best = Infinity;
    listed.forEach((s, i) => {
      const d = Math.abs(s - centre);
      if (d < best) {
        best = d;
        idx = i;
      }
    });
  }
  const keep = new Set(listed.slice(Math.max(0, idx - n), idx + n + 1));
  return contracts.filter((c) => keep.has(c.strike));
}

/**
 * The no-arbitrage lower bound of a European option (discounted intrinsic). At or below it no IV exists,
 * and the solver stops early on vanishing vega (e.g. 0.0087 for a deep-ITM call priced under intrinsic)
 * without reaching its clamp, so the bound is checked before solving.
 */
function noArbFloor(spot: number, strike: number, t: number, type: OptionSide): number {
  const pv = strike * Math.exp(-RISK_FREE_RATE * t);
  return Math.max(0, type === 'CE' ? spot - pv : pv - spot);
}

export interface AssembleInput {
  contracts: readonly ChainContract[];
  quotes: ReadonlyMap<string, QuoteOutcome>;
  greeks: readonly OptionGreekRow[] | null;
  baseline: ReadonlyMap<string, number>;
  spot: number | null;
  expiry: string;
  exchange: string;
  now: number;
  math: GreeksMath;
}

/**
 * Contracts + one quote call + Greeks + the OI baseline → the shared chain shape, strikes ascending.
 * `greeks`: 'local' if any leg was computed locally, else 'broker' if any leg used a broker row, else 'none'.
 */
export function assembleEntries(i: AssembleInput): { entries: OptionsChainEntry[]; greeks: ChainGreeksSource; quotedLegs: number } {
  const t = Math.max(0, (expiryCloseAt(i.expiry, i.exchange).getTime() - i.now) / YEAR_MS);
  const rows = new Map((i.greeks ?? []).map((g) => [`${g.strike}:${g.optionType}`, g]));
  const byStrike = new Map<number, OptionsChainEntry>();
  let usedLocal = false;
  let usedBroker = false;
  let quotedLegs = 0;

  for (const c of i.contracts) {
    const entry = byStrike.get(c.strike) ?? { strikePrice: c.strike, expiryDate: i.expiry, ceData: null, peData: null };
    byStrike.set(c.strike, entry);
    const q = i.quotes.get(refKey(c.ref));
    if (q?.kind !== 'ok') continue;
    quotedLegs++;
    const tick = q.tick;
    const oi = tick.oi ?? 0;
    const base = i.baseline.get(c.instrumentId);
    const row = rows.get(`${c.strike}:${c.optionType}`);
    let g = { iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0 };
    if (row && (row.iv > 0 || row.delta !== 0)) {
      usedBroker = true;
      g = { iv: row.iv, delta: row.delta, gamma: row.gamma, theta: row.theta, vega: row.vega };
    } else if (i.spot !== null && i.spot > 0 && tick.ltp > 0 && t > 0 && tick.ltp > noArbFloor(i.spot, c.strike, t, c.optionType)) {
      const iv = i.math.calculateIV(tick.ltp, i.spot, c.strike, t, RISK_FREE_RATE, c.optionType);
      // A clamped (non-converged) IV is no IV: the leg keeps zero Greeks and does not count as local.
      if (iv > IV_SOLVER_FLOOR && iv < IV_SOLVER_CEILING) {
        usedLocal = true;
        const greeks = i.math.calculateGreeks(i.spot, c.strike, t, RISK_FREE_RATE, iv, c.optionType);
        g = { iv: Math.round(iv * 10000) / 100, ...greeks };
      }
    }
    const leg: OptionData = {
      ltp: tick.ltp,
      oi,
      oiChange: base === undefined || tick.oi === undefined ? null : oi - base,
      volume: tick.volume ?? 0,
      ...g,
      bidPrice: tick.depth?.bids[0]?.price ?? 0,
      askPrice: tick.depth?.asks[0]?.price ?? 0,
      token: c.ref.token,
      lotSize: c.lotSize,
    };
    if (c.optionType === 'CE') entry.ceData = leg;
    else entry.peData = leg;
  }

  const entries = [...byStrike.values()].sort((a, b) => a.strikePrice - b.strikePrice);
  return { entries, greeks: usedLocal ? 'local' : usedBroker ? 'broker' : 'none', quotedLegs };
}
