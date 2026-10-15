/** Exit discipline E7: the daily scorecard (one `[exit-score]` line per user per IST day). Pure. */
import type { OutcomeKind } from './types';

export interface ScoredDecision { kind: OutcomeKind; missedPnl: number; savedPnl: number; netAtEnd: number }
export interface Scorecard {
  day: string;
  executed: { n: number; missed: number; saved: number };
  dryRun: { n: number; missed: number; saved: number };
  gate: { blocked: number; gated: number; awaiting: number; helped: number; cost: number; net: number };
}
const rnd = (x: number) => Math.round(x);

export function scorecard(day: string, rows: ScoredDecision[]): Scorecard {
  const sum = (k: OutcomeKind) => {
    const r = rows.filter((x) => x.kind === k);
    return { n: r.length, missed: rnd(r.reduce((s, x) => s + x.missedPnl, 0)), saved: rnd(r.reduce((s, x) => s + x.savedPnl, 0)) };
  };
  const blocked = rows.filter((x) => x.kind === 'GATED' || x.kind === 'AWAITING');
  // The gate is credited with what holding returned (netAtEnd > 0) and charged with what it lost.
  const helped = rnd(blocked.reduce((s, x) => s + Math.max(0, x.netAtEnd), 0));
  const cost = rnd(blocked.reduce((s, x) => s + Math.max(0, -x.netAtEnd), 0));
  return {
    day, executed: sum('EXECUTED'), dryRun: sum('DRY_RUN'),
    gate: {
      blocked: blocked.length, gated: rows.filter((x) => x.kind === 'GATED').length,
      awaiting: rows.filter((x) => x.kind === 'AWAITING').length, helped, cost, net: helped - cost,
    },
  };
}

export function scorecardLine(s: Scorecard): string {
  return `[exit-score] ${s.day} executed=${s.executed.n} missed=₹${s.executed.missed} saved=₹${s.executed.saved} | ` +
    `gate blocked=${s.gate.blocked} (gated ${s.gate.gated}, awaiting ${s.gate.awaiting}) helped=₹${s.gate.helped} cost=₹${s.gate.cost} net=₹${s.gate.net} | ` +
    `dry-run=${s.dryRun.n}`;
}
