import { Injectable } from '@nestjs/common';
import type { CoreSquareOffCause, CoreSquareOffPort, CoreSquareOffResult } from '../risk-wall/ports';
import { PaperLedgerService } from './paper-ledger.service';
import { PaperMatcherService } from './paper-matcher.service';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * CORE_SQUARE_OFF's entry half (spec §4.7): cancels every pending core ENTRY order of the
 * user, each through the ledger (margin released) and out of the matcher (hub watch
 * released). EXIT orders are left alone: they are the square-off of open positions
 * (SP2 M4 ruling L14), and SP2 M4's CoreSquareOff composes this with the lifecycle's
 * exits. It goes through the ledger and
 * the matcher rather than the adapter because the adapter injects CoreKillSwitchService,
 * which injects this port (plan ruling 12): adapter → kill switch → square-off would be a
 * cycle. Any failed cancellation throws after trying every order, so the kill switch
 * cascade reports FAILED rather than a partial OK.
 */
@Injectable()
export class PaperOrderSquareOff implements CoreSquareOffPort {
  constructor(
    private readonly ledger: PaperLedgerService,
    private readonly matcher: PaperMatcherService,
  ) {}

  async squareOffAll(userId: string, cause: CoreSquareOffCause, reason: string): Promise<CoreSquareOffResult> {
    // SP2 M4 (ruling L14): EXIT orders are the square-off of open positions; cancelling them would undo it.
    const open = (await this.ledger.openOrdersForUser(userId)).filter((o) => o.purpose === 'ENTRY');
    const failures: string[] = [];
    let cancelled = 0;
    for (const o of open) {
      try {
        const c = await this.ledger.close(userId, o.id, 'CANCEL', `${cause}: ${reason}`);
        // A closed copy untracks and releases the P0 watch; an open one replaces the held copy.
        this.matcher.refresh(c);
        if (c.state === 'CANCELLED') cancelled += 1;
      } catch (err) {
        failures.push(`${o.id}: ${errorText(err)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`cancelled ${cancelled} of ${open.length} pending core entry orders; failed: ${failures.join('; ')}`);
    }
    return { cancelledOrders: cancelled, exitsRequested: 0, detail: `${cancelled} pending core entry order(s) cancelled` };
  }
}
