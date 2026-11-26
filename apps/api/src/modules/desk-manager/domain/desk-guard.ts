import type { DeskManagerConfig } from '../desk-manager.config';
import type { DayPnlPath, GuardState } from './desk.types';

const rs = (n: number) => `₹${Math.round(n)}`;

/**
 * The desk guard rule (spec §5.5) — pure, code-only, the AI cannot override it. Blocks new automatic live
 * entries when the day's P&L path breaches a limit or a pause is in force for this underlying.
 * A limit ≤ 0 is OFF (a 0 drawdown limit would otherwise block every entry all day).
 * Every reason names the numbers that tripped it (no silent blocks).
 */
export function evaluateGuard(
  path: DayPnlPath,
  cfg: DeskManagerConfig['guard'],
  pause: { until: Date | null; scope: string | null },
  underlying: string | null,
  now: Date,
): GuardState {
  const reasons: string[] = [];
  if (cfg.drawdownRupees > 0 && path.drawdownFromPeak >= cfg.drawdownRupees) {
    reasons.push(`drawdown ${rs(path.drawdownFromPeak)} ≥ ${rs(cfg.drawdownRupees)}`);
  }
  if (cfg.dayLossRupees > 0 && -path.total >= cfg.dayLossRupees) {
    reasons.push(`day loss ${rs(-path.total)} ≥ ${rs(cfg.dayLossRupees)}`);
  }
  if (cfg.lossStreak > 0 && path.lossStreak >= cfg.lossStreak) {
    reasons.push(`${path.lossStreak} losers in a row ≥ ${cfg.lossStreak}`);
  }
  const inForce = pause.until !== null && pause.until.getTime() > now.getTime() && !!pause.scope;
  const scope = inForce ? (pause.scope === 'all' ? 'all' : String(pause.scope).trim().toUpperCase()) : null;
  if (inForce && (scope === 'all' || underlying === null || String(underlying).trim().toUpperCase() === scope)) {
    reasons.push(`paused (${scope}) until ${pause.until!.toISOString()}`);
  }
  return { blocked: reasons.length > 0, reasons, path, pausedUntil: inForce ? pause.until : null, pauseScope: scope };
}
