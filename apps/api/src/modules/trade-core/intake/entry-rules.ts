import { createHash } from 'crypto';
import { istDate } from '../execution/ledger-math';
import { round2 } from '../lifecycle/exit-plan';
import type { EntryBlock, FiltersBlock, MinScore, SizingBlock, StrategyBlocks } from '../strategies/blocks/block-types';
import type { ChartinkHit } from './alert-handoff';

/** Pure entry rules for the Chartink intake (spec §4.1; rulings J4, J5, J8). */
type ChartinkEntry = Extract<EntryBlock, { kind: 'chartink' }>;

const IST_OFFSET_MIN = 330;
const hhmmMinutes = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

export function istMinutes(at: Date): number {
  return Math.floor((at.getTime() / 60_000 + IST_OFFSET_MIN) % 1440);
}

/** The window of a MinScore that applies at `at` (IST, [from, to)), if any. */
function minScoreWindow(m: MinScore, at: Date): MinScore['windows'][number] | undefined {
  const t = istMinutes(at);
  return m.windows.find((x) => t >= hhmmMinutes(x.fromHhmm) && t < hhmmMinutes(x.toHhmm));
}

/** M1 semantics: inside a window [from, to) the window's score replaces base; null = no score gate. */
export function minScoreAt(m: MinScore | null, at: Date): number | null {
  if (!m) return null;
  const w = minScoreWindow(m, at);
  return w ? w.score : m.base;
}

export function scanMatches(e: ChartinkEntry, scanName: string | null): boolean {
  if (e.match === 'ANY') return true;
  if (scanName === null || e.scanName === null) return false;
  const have = scanName.trim().toLowerCase();
  const want = e.scanName.trim().toLowerCase();
  return e.match === 'EXACT' ? have === want : have.includes(want);
}

export type EntryMatch =
  | { kind: 'NOT_MINE' }
  | { kind: 'SKIP'; reason: 'MIN_SCORE' | 'VEHICLE_UNSUPPORTED'; detail: string }
  | { kind: 'CANDIDATE' };

const NOT_MINE: EntryMatch = { kind: 'NOT_MINE' };

/** Is this hit a setup of this strategy, and does it pass the entry block? Order: source, scan, side, vehicle, score. */
export function matchEntry(blocks: StrategyBlocks, hit: ChartinkHit, at: Date): EntryMatch {
  const e = blocks.entry;
  if (e.kind !== 'chartink') return NOT_MINE;
  if (!scanMatches(e, hit.scanName)) return NOT_MINE;
  if (e.side !== 'BOTH' && e.side !== hit.side) return NOT_MINE;
  if (blocks.vehicle.kind === 'OPTIONS_BUY') {
    return { kind: 'SKIP', reason: 'VEHICLE_UNSUPPORTED', detail: 'OPTIONS_BUY entries need the strike and expiry picker, which is not built yet (M5 O4)' };
  }
  const need = minScoreAt(e.minScore, at);
  if (need !== null && !(hit.score >= need)) {
    const w = e.minScore ? minScoreWindow(e.minScore, at) : undefined;
    return { kind: 'SKIP', reason: 'MIN_SCORE', detail: `score ${hit.score} below ${need}${w ? ` (${w.fromHhmm}-${w.toHhmm} IST window)` : ''}` };
  }
  return { kind: 'CANDIDATE' };
}

/** % the live price has moved past the alert price in the trade direction (negative = moved against it). */
export function staleMovePct(side: 'BUY' | 'SELL', alertPrice: number, live: number): number {
  if (!(alertPrice > 0)) return 0;
  const move = ((live - alertPrice) / alertPrice) * 100;
  return side === 'BUY' ? move : -move;
}

/**
 * The silo rule: skip when the move is strictly more than maxMovePct. An alert or live price that is not a
 * positive number cannot be judged and fails (entries fail closed).
 */
export function staleEntryFails(f: FiltersBlock['staleEntry'], side: 'BUY' | 'SELL', alertPrice: number, live: number): boolean {
  if (f === null) return false;
  if (!(alertPrice > 0) || !(live > 0)) return true;
  return staleMovePct(side, alertPrice, live) > f.maxMovePct;
}

/** The silo rule: the same token was opened by this strategy at most `minutes` ago. */
export function cooldownActive(f: FiltersBlock['cooldown'], lastOpenedAt: Date | null, now: Date): boolean {
  return f !== null && lastOpenedAt !== null && now.getTime() - lastOpenedAt.getTime() <= f.minutes * 60_000;
}

/** The silo rule: today's last closed trade lost (net ≤ 0) → block; an unknown result fails closed. */
export function lastLossVerdict(f: FiltersBlock['lastLoss'], last: number | 'UNKNOWN' | null): 'PASS' | 'BLOCK' | 'UNKNOWN' {
  if (f === null || last === null) return 'PASS';
  if (last === 'UNKNOWN') return 'UNKNOWN';
  return last <= 0 ? 'BLOCK' : 'PASS';
}

export function stopPriceFor(side: 'BUY' | 'SELL', ref: number, stopPct: number): number {
  return round2(side === 'BUY' ? ref * (1 - stopPct / 100) : ref * (1 + stopPct / 100));
}

/** J8: units from the sizing block, in whole lots; the Risk Wall may only reduce it. */
export function sizeQty(s: SizingBlock, ref: number, stop: number, lotSize: number): number {
  if (!(ref > 0) || !(lotSize >= 1)) return 0;
  const dist = Math.abs(ref - stop);
  const units = s.kind === 'riskRupees' ? (dist > 0 ? s.amount / dist : 0) : s.amount / ref;
  const lots = Math.floor(units / lotSize);
  return lots > 0 ? lots * lotSize : 0;
}

/** J4: one id per (user, strategy, alert, instrument); re-processing a hit yields the same id. */
export function intentIdFor(userId: string, strategyId: string, alertId: string, token: string): string {
  return `ci_${createHash('sha256').update(`${userId}|${strategyId}|${alertId}|${token}`).digest('hex').slice(0, 32)}`;
}

/** SP3 corpus dedup key, the legacy form (SP3 spec §5.1). */
export function setupGroupKey(alertId: string, symbol: string, at: Date): string {
  return `${alertId}|${symbol}|${istDate(at)}`;
}
