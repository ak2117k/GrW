import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import type { SessionClock } from '../../market-hub/session-clock';
import { CORE_SESSION_CLOCK } from '../risk-wall/ports';
import { CoreKillSwitchService } from '../risk-wall/services/core-kill-switch.service';
import type { CoreFunds, CoreOrder, CoreOrderPatch, CoreOrderRequest, CorePositionView, ExecutionAdapter } from './execution.types';
import { requestProblems } from './fill-model';
import { isOpenState } from './order-state';
import { PaperLedgerService } from './paper-ledger.service';
import { PaperMatcherService } from './paper-matcher.service';

/** The token M4/M5 inject; SP7 binds a live adapter to it. */
export const CORE_EXECUTION_ADAPTER = Symbol('CORE_EXECUTION_ADAPTER');

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The paper ExecutionAdapter (spec §4.2) for CASH_INTRADAY, MTF and OPTIONS_BUY. A
 * malformed request is a 400 with nothing written; everything else is a persisted order
 * (REJECTED with its reason, or OPEN and tracked by the matcher). Entries are refused
 * while the user's core kill switch is on or unreadable (plan ruling 7). The ledger's
 * HTTP errors (404 not the caller's, 409 a key taken by another user or a triggered stop,
 * 422 a change the order cannot take) pass through unchanged. Every cancel and modify is
 * handed to the matcher, so a closed order stops being matched and its hub watch is
 * released, and a modified one is matched at its new limit or trigger. The matcher owns
 * the no-price reject (ruling P16): no timeout here. Nothing calls this in production
 * before M5.
 */
@Injectable()
export class PaperExecutionAdapter implements ExecutionAdapter {
  private readonly logger = new Logger(PaperExecutionAdapter.name);

  constructor(
    private readonly ledger: PaperLedgerService,
    private readonly matcher: PaperMatcherService,
    private readonly killSwitch: CoreKillSwitchService,
    @Inject(CORE_SESSION_CLOCK) private readonly clock: Pick<SessionClock, 'isOpen'>,
  ) {}

  async placeOrder(req: CoreOrderRequest): Promise<CoreOrder> {
    const problems = requestProblems(req);
    if (problems.length > 0) throw new BadRequestException(`malformed core order request: ${problems.join('; ')}`);
    const now = new Date();
    const killSwitchActive = req.purpose === 'ENTRY' ? await this.killSwitchOn(req, now) : false;
    const sessionOpen = this.clock.isOpen(req.instrument.exchange.toUpperCase(), now);
    const r = await this.ledger.place(req, { sessionOpen, killSwitchActive }, now);
    if (r.created && r.settings && isOpenState(r.order.state)) this.matcher.track(r.order, r.settings.noPriceRejectMs, now.getTime());
    return r.order;
  }

  async cancel(userId: string, orderId: string): Promise<CoreOrder> {
    const o = await this.ledger.close(userId, orderId, 'CANCEL', 'cancelled by the caller');
    // A closed order is untracked and its P0 watch released; an open copy is replaced.
    this.matcher.refresh(o);
    return o;
  }

  async modify(userId: string, orderId: string, patch: CoreOrderPatch): Promise<CoreOrder> {
    const o = await this.ledger.modify(userId, orderId, patch);
    // The matcher holds a copy of the order: give it the new qty, limit or trigger.
    this.matcher.refresh(o);
    return o;
  }

  getOrder(userId: string, orderId: string): Promise<CoreOrder> {
    return this.ledger.getOrder(userId, orderId);
  }

  getPositions(userId: string): Promise<CorePositionView[]> {
    return this.ledger.positions(userId);
  }

  getFunds(userId: string): Promise<CoreFunds> {
    return this.ledger.funds(userId);
  }

  /** Fail closed (plan ruling 7): a switch that cannot be read counts as on, and is logged. */
  private async killSwitchOn(req: CoreOrderRequest, now: Date): Promise<boolean> {
    try {
      return await this.killSwitch.isActive(req.userId, now);
    } catch (err) {
      this.logger.error(`core kill switch unreadable for ${req.userId}; entry ${req.idempotencyKey} is refused: ${errorText(err)}`);
      return true;
    }
  }
}
