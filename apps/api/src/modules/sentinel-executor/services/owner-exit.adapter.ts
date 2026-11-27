import { Logger } from '@nestjs/common';
import type { OwnerExitPort } from '../../exit-authority/services/escalation-runner.service';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import type { ManualExitService } from './manual-exit.service';

/** The system identity the exit authority acts under (ManualExitService treats ADMIN as the owner's own button). */
export const EXIT_AUTHORITY_ACTOR_EMAIL = 'exit-authority@grw';

/**
 * OWNER_EXIT for the trade agent exit authority (bound in SentinelExecutorModule; the authority's late-bound
 * forwarder finds it): an exit placed through the owner's manual-exit path, `ManualExitService.request` as
 * `{ userId, role: 'ADMIN', email: 'exit-authority@grw' }` with the authority's reason — trigger MANUAL, the same
 * claim / guards / one MARKET order as the owner's Exit button, idempotent per tracker.
 *
 * BACKSTOPS honour the executor's allow-list. A `BACKSTOP …` reason (the hard-loss and broker-deadline code exits)
 * is refused for a user the AI auto-exit does not act for (AI_AUTO_EXIT_ENABLED + AI_AUTO_EXIT_USER_IDS): today the
 * executor never sells those accounts' positions on a rule verdict, and the authority must not start to. The owner's
 * own Telegram Exit and the supreme's exit (today's desk-manager path, ADMIN) are not restricted, as today.
 * Resolves the attempt id; throws when refused (the runner logs it, tells the owner and retries).
 */
export class ManualOwnerExit implements OwnerExitPort {
  private readonly log = new Logger(ManualOwnerExit.name);

  constructor(
    private readonly manual: Pick<ManualExitService, 'request'>,
    private readonly env: () => Record<string, string | undefined> = () => process.env,
  ) {}

  async exitAsOwner(userId: string, trackerId: string, reason: string, now: Date = new Date()): Promise<string> {
    if (reason.startsWith('BACKSTOP')) {
      const cfg = parseAutoExitConfig(this.env());
      if (!cfg.enabled || !cfg.userIds.includes(userId)) {
        const why = `${reason.split(':')[0]} refused for ${userId}: not in the AI auto-exit (AI_AUTO_EXIT_ENABLED / AI_AUTO_EXIT_USER_IDS) — the executor does not sell this account's trades`;
        this.log.error(`[exit-authority] ${why} (tracker ${trackerId})`);
        throw new Error(why);
      }
    }
    const r = await this.manual.request({ userId, role: 'ADMIN', email: EXIT_AUTHORITY_ACTOR_EMAIL }, trackerId, { now, reason });
    return `${r.row.verdictId}${r.started ? '' : ' (already working)'}`;
  }
}
