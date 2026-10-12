import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PaperOrderSquareOff } from '../execution/paper-order-square-off';
import type { CoreSquareOffCause, CoreSquareOffPort, CoreSquareOffResult } from '../risk-wall/ports';
import { CORE_POSITION_EXITS, type CorePositionExits } from './lifecycle-ports';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * CORE_SQUARE_OFF (spec §5.3, §5.4): cancel the user's pending core ENTRY orders, then exit
 * every active core position (kill switch = priority 1, daily loss = priority 2). Both halves
 * always run; any failure is thrown after both, so the kill-switch cascade reports FAILED,
 * never a partial OK. The lifecycle is resolved at call time (ruling L14).
 */
@Injectable()
export class CoreSquareOff implements CoreSquareOffPort {
  constructor(
    private readonly entries: PaperOrderSquareOff,
    private readonly moduleRef: ModuleRef,
  ) {}

  async squareOffAll(userId: string, cause: CoreSquareOffCause, reason: string): Promise<CoreSquareOffResult> {
    const failures: string[] = [];
    let cancelledOrders = 0;
    try {
      cancelledOrders = (await this.entries.squareOffAll(userId, cause, reason)).cancelledOrders;
    } catch (err) {
      failures.push(`entry orders: ${errorText(err)}`);
    }
    let exitsRequested = 0;
    try {
      exitsRequested = (await this.exits().exitAll(userId, cause, reason)).exitsRequested;
    } catch (err) {
      failures.push(`positions: ${errorText(err)}`);
    }
    if (failures.length > 0) {
      throw new Error(`core square-off incomplete (${cancelledOrders} entry order(s) cancelled, ${exitsRequested} exit(s) requested): ${failures.join('; ')}`);
    }
    return { cancelledOrders, exitsRequested, detail: `${cancelledOrders} pending core entry order(s) cancelled; ${exitsRequested} core position exit(s) requested` };
  }

  private exits(): CorePositionExits {
    return this.moduleRef.get<CorePositionExits>(CORE_POSITION_EXITS, { strict: false });
  }
}
