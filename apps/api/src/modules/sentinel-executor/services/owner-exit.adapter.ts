import { Logger } from '@nestjs/common';
import { BackstopRehearsal, type OwnerExitOptions, type OwnerExitPort } from '../../exit-authority/services/escalation-runner.service';
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
 * `opts.ownerInitiated` is passed through explicitly (owner ruling 2026-11-27 "keep me alerting"): only the owner's
 * Telegram Exit / bx tap sets it, so only that exit may cancel the owner's resting orders under live. Backstops and
 * supreme exits leave it unset: an order on the contract ends OPEN_ORDER_EXISTS and the owner is alerted.
 *
 * BACKSTOPS honour the executor's allow-list and mode. A `BACKSTOP …` reason (the hard-loss and broker-deadline code
 * exits) is refused for a user the AI auto-exit does not act for (AI_AUTO_EXIT_ENABLED + AI_AUTO_EXIT_USER_IDS): today
 * the executor never sells those accounts' positions on a rule verdict, and the authority must not start to. Under
 * AI_AUTO_EXIT_MODE=dry-run a backstop is rehearsed (BackstopRehearsal: the runner records it and tells the owner
 * "would exit"), never sold, like the executor's own dry-run. The owner's own Telegram Exit and the supreme's exit
 * (today's desk-manager path, ADMIN) are not restricted, as today.
 * Resolves the attempt id; throws when refused (the runner logs it, tells the owner and retries).
 */
export class ManualOwnerExit implements OwnerExitPort {
  private readonly log = new Logger(ManualOwnerExit.name);

  constructor(
    private readonly manual: Pick<ManualExitService, 'request'>,
    private readonly env: () => Record<string, string | undefined> = () => process.env,
  ) {}

  async exitAsOwner(userId: string, trackerId: string, reason: string, opts: OwnerExitOptions & { now?: Date } = {}): Promise<string> {
    const now = opts.now ?? new Date();
    if (reason.startsWith('BACKSTOP')) {
      const cfg = parseAutoExitConfig(this.env());
      const kind = reason.split(':')[0];
      if (!cfg.enabled || !cfg.userIds.includes(userId)) {
        const why = `${kind} refused for ${userId}: not in the AI auto-exit (AI_AUTO_EXIT_ENABLED / AI_AUTO_EXIT_USER_IDS) — the executor does not sell this account's trades`;
        this.log.error(`[exit-authority] ${why} (tracker ${trackerId})`);
        throw new Error(why);
      }
      if (cfg.mode !== 'live') {
        this.log.warn(`[exit-authority] ${kind} DRY-RUN for ${userId} (tracker ${trackerId}): AI_AUTO_EXIT_MODE=${cfg.mode} — would exit, nothing sent`);
        throw new BackstopRehearsal(`AI_AUTO_EXIT_MODE=${cfg.mode}: would exit, nothing sent`);
      }
    }
    const r = await this.manual.request(
      { userId, role: 'ADMIN', email: EXIT_AUTHORITY_ACTOR_EMAIL },
      trackerId,
      { now, reason, ownerInitiated: opts.ownerInitiated === true },
    );
    return `${r.row.verdictId}${r.started ? '' : ' (already working)'}`;
  }
}
