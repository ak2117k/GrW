export type Bar = { high: number; low: number; close: number; timestamp: Date };

export interface EvalSignal {
  side: 'LONG' | 'SHORT';
  signalType: 'LEVELED' | 'DIRECTIONAL';
  entryLow: number | null; entryHigh: number | null; entryMode: string;
  stopLoss: number | null; slMode: string; targets: number[];
  entryPrice: number | null; horizon: 'INTRADAY' | 'SWING';
}

export interface EvalResult {
  status: 'PENDING' | 'ACTIVE' | 'TARGET_HIT' | 'SL_HIT' | 'EXPIRED';
  entryPrice?: number; entryFilledAt?: Date; exitPrice?: number; exitAt?: Date;
  hitTargetIndex?: number; resultPct?: number;
}

export function resultPct(entry: number, exit: number, side: 'LONG' | 'SHORT'): number {
  const raw = ((exit - entry) / entry) * 100;
  return side === 'LONG' ? raw : -raw;
}

function touched(bar: Bar, level: number, dir: 'up' | 'down'): boolean {
  return dir === 'up' ? bar.high >= level : bar.low <= level;
}

/** Entry fill price for a LEVELED signal on a bar that reaches the entry zone/trigger. */
function fillPrice(sig: EvalSignal): number {
  if (sig.entryPrice != null) return sig.entryPrice;
  if (sig.entryLow != null && sig.entryHigh != null) return (sig.entryLow + sig.entryHigh) / 2;
  return sig.entryLow ?? sig.entryHigh ?? 0;
}

export function evaluateLeveled(sig: EvalSignal, bars: Bar[]): EvalResult {
  const long = sig.side === 'LONG';
  let entry = sig.entryPrice;
  let entryFilledAt: Date | undefined;
  const zoneLow = sig.entryLow ?? sig.entryHigh;
  const zoneHigh = sig.entryHigh ?? sig.entryLow;

  for (const bar of bars) {
    // 1. Fill entry if not yet filled. Fills only when the bar's range actually
    //    reaches the entry zone (overlaps [zoneLow, zoneHigh]); a bar entirely
    //    above/below the zone never fills.
    if (entry == null) {
      const hit = zoneLow != null && zoneHigh != null &&
        bar.high >= zoneLow && bar.low <= zoneHigh;
      if (!hit) continue;
      entry = fillPrice(sig);
      entryFilledAt = bar.timestamp;
    }
    // 2. On the active bar, check SL first (conservative tie-break), then targets.
    const slHit = sig.slMode === 'NUMERIC' && sig.stopLoss != null &&
      (long ? bar.low <= sig.stopLoss : bar.high >= sig.stopLoss);
    if (slHit) {
      return { status: 'SL_HIT', entryPrice: entry, entryFilledAt, exitPrice: sig.stopLoss!,
        exitAt: bar.timestamp, resultPct: resultPct(entry, sig.stopLoss!, sig.side) };
    }
    for (let i = sig.targets.length - 1; i >= 0; i--) {
      const tgt = sig.targets[i];
      if (long ? bar.high >= tgt : bar.low <= tgt) {
        return { status: 'TARGET_HIT', entryPrice: entry, entryFilledAt, exitPrice: tgt,
          exitAt: bar.timestamp, hitTargetIndex: i, resultPct: resultPct(entry, tgt, sig.side) };
      }
    }
  }
  if (entry == null) return { status: 'EXPIRED' };
  return { status: 'ACTIVE', entryPrice: entry, entryFilledAt };
}

export function evaluateDirectional(sig: EvalSignal, bars: Bar[],
  thresholds: { winPct: number; lossPct: number }): EvalResult {
  if (sig.entryPrice == null) return { status: 'ACTIVE' };
  const long = sig.side === 'LONG';
  const winLvl = long ? sig.entryPrice * (1 + thresholds.winPct / 100) : sig.entryPrice * (1 - thresholds.winPct / 100);
  const lossLvl = long ? sig.entryPrice * (1 - thresholds.lossPct / 100) : sig.entryPrice * (1 + thresholds.lossPct / 100);
  for (const bar of bars) {
    // Loss checked first (conservative).
    if (touched(bar, lossLvl, long ? 'down' : 'up')) {
      return { status: 'SL_HIT', entryPrice: sig.entryPrice, exitPrice: lossLvl,
        exitAt: bar.timestamp, resultPct: resultPct(sig.entryPrice, lossLvl, sig.side) };
    }
    if (touched(bar, winLvl, long ? 'up' : 'down')) {
      return { status: 'TARGET_HIT', entryPrice: sig.entryPrice, exitPrice: winLvl,
        exitAt: bar.timestamp, resultPct: resultPct(sig.entryPrice, winLvl, sig.side) };
    }
  }
  return { status: 'ACTIVE', entryPrice: sig.entryPrice };
}
