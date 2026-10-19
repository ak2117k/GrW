// apps/api/src/modules/sentinel-executor/domain/guards.ts
import { AUTO_EXIT_EXCHANGES, type AutoExitConfig } from './auto-exit.types';
import type { ExitTrigger } from './manual-exit';

export interface GuardInput {
  config: AutoExitConfig;
  now: Date;
  verdict: { userId: string; createdAt: Date };
  tracker: { id?: string; symbol?: string; userId: string; status: string; kind: string; exchange: string } | null;
  isOpen: (exchange: string, at: Date) => boolean;
  countedToday: number;
  inFlight: boolean;
  /**
   * 'AI' (default): a sentinel EXIT_NOW verdict, and 'PRICE_TRIGGER' (a
   * pre-agreed sentinel level crossed): every guard. 'MANUAL': the owner's own
   * "Exit now" — the AI switches (enabled, allow-list, verdict age, daily cap)
   * do not apply (the caller authorised the user), every position guard does.
   */
  trigger?: ExitTrigger;
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

const no = (reason: string): GuardResult => ({ ok: false, reason });

/**
 * Spec §5.3, in order. Pure: every input that needs I/O is resolved by the caller.
 * The first failing guard names the SKIPPED reason; nothing is sent on any failure.
 */
/** The owner is holding this position against the AI (AI_AUTO_EXIT_HOLD, by symbol or tracker id). */
function isHeld(hold: string[] | undefined, t: { id?: string; symbol?: string }): boolean {
  if (!hold || hold.length === 0) return false;
  const keys = [t.symbol, t.id].map((k) => String(k ?? '').trim().toUpperCase()).filter(Boolean);
  return keys.some((k) => hold.includes(k));
}

export function evaluateGuards(i: GuardInput): GuardResult {
  const ai = i.trigger !== 'MANUAL';
  if (ai) {
    if (!i.config.enabled) return no('DISABLED');
    if (!i.config.userIds.includes(i.verdict.userId)) return no('NOT_ALLOWED_USER');
    if (i.now.getTime() - i.verdict.createdAt.getTime() > i.config.maxVerdictAgeSec * 1000) {
      return no('STALE_VERDICT');
    }
  }
  const t = i.tracker;
  if (!t) return no('TRACKER_MISSING');
  if (t.userId !== i.verdict.userId) return no('TRACKER_USER_MISMATCH');
  if (t.status !== 'OPEN') return no('TRACKER_CLOSED');
  if (t.kind !== 'POSITION') return no('NOT_POSITION');
  if (ai && isHeld(i.config.hold, t)) return no('OWNER_HOLD');
  const exchange = String(t.exchange ?? '').toUpperCase();
  if (!AUTO_EXIT_EXCHANGES.includes(exchange)) return no('EXCHANGE_NOT_FNO');
  if (!i.isOpen(exchange, i.now)) return no('EXCHANGE_CLOSED');
  if (i.inFlight) return no('EXIT_IN_FLIGHT');
  if (ai && i.countedToday >= i.config.dailyCap) return no('DAILY_CAP');
  return { ok: true };
}
