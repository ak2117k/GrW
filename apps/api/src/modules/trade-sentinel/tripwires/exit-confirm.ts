import type { TripwireResult } from '../services/tripwire.service';
import type { TripwireFire } from './types';

const IST = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * Exit discipline §7 needs a SECOND verdict to confirm an EXIT_NOW. While the
 * latest live verdict on an open position is EXIT_NOW, ask again after
 * `relookMs` — at most `maxRelooks` times in a row (cost cap).
 */
export function exitConfirmFire(i: { recent: Array<{ verdict: string; createdAt: Date }>; now: Date; relookMs: number; maxRelooks: number }): TripwireFire | null {
  let run = 0;
  for (const r of i.recent) { if (r.verdict !== 'EXIT_NOW') break; run += 1; }
  if (run === 0 || run > i.maxRelooks) return null;
  const last = i.recent[0];
  if (i.now.getTime() - last.createdAt.getTime() < i.relookMs) return null;
  return {
    name: 'exit-confirm',
    detail: `your last verdict was EXIT_NOW at ${IST.format(last.createdAt)} IST (${run} in a row since the last HOLD) and the ` +
      'position is still open — an exit executes only when a justification holds and a second EXIT_NOW confirms it; judge it again',
  };
}

export function withExitConfirm(d: TripwireResult, fire: TripwireFire | null): TripwireResult {
  if (!fire || d.fires.some((f) => f.name === fire.name)) return d;
  return { ...d, fires: [...d.fires, fire], heartbeat: false, shouldEvaluate: true, trigger: 'FIRE' };
}
