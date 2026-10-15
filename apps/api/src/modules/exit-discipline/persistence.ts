import type { ExitDisciplineConfig } from './config';
import type { PersistenceResult } from './types';

/** One prior live verdict on the tracker (newest first), with the HOLD-time facts the gate reads. */
export interface HistoryVerdict {
  id: string;
  verdict: string;
  createdAt: Date;
  underlying: number | null;
  support: number | null;
  resistance: number | null;
}

const secs = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / 1000);

/** Spec §7, pure. Only HOLD breaks a streak; EXIT_ARMED / ESCALATE do not. */
export function evaluatePersistence(i: {
  current: { id: string; createdAt: Date };
  history: HistoryVerdict[];
  bypass: boolean;
  cfg: ExitDisciplineConfig;
}): PersistenceResult {
  const before = i.history
    .filter((h) => h.id !== i.current.id && h.createdAt.getTime() < i.current.createdAt.getTime())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const prev = before[0] ?? null;
  const previous = prev ? { id: prev.id, verdict: prev.verdict, ageSec: secs(i.current.createdAt, prev.createdAt) } : null;

  let start: { id: string; at: Date } = { id: i.current.id, at: i.current.createdAt };
  for (const h of before) {
    if (h.verdict === 'HOLD') break;
    if (h.verdict === 'EXIT_NOW') start = { id: h.id, at: h.createdAt };
  }
  const streakStart = { id: start.id, ageSec: secs(i.current.createdAt, start.at) };

  if (i.bypass) return { confirmed: true, rule: 'BYPASS', previous, streakStart };
  if (previous && previous.verdict === 'EXIT_NOW' && previous.ageSec <= i.cfg.persistWindowSec) {
    return { confirmed: true, rule: 'CONSECUTIVE', previous, streakStart };
  }
  if (start.id !== i.current.id && streakStart.ageSec >= i.cfg.persistMinSec) {
    return { confirmed: true, rule: 'SUSTAINED', previous, streakStart };
  }
  return { confirmed: false, rule: null, previous, streakStart };
}
