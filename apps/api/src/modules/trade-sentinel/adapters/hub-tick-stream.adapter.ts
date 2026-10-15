import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { lookupHubPrices } from '../../market-hub/hub-prices';
import { refKey } from '../../market-hub/hub.types';
import type { StreamTick, TickStream } from '../ports/tick-stream.port';

/** TickStream over the market hub's onPrice (consumer 'positions', the owner's hub). */
@Injectable()
export class HubTickStream implements TickStream {
  constructor(@Optional() private readonly moduleRef?: ModuleRef) {}

  subscribe(userId: string, fn: (t: StreamTick) => void): (() => void) | null {
    const hub = lookupHubPrices(this.moduleRef)?.hubFor(userId, 'positions') ?? null;
    if (!hub) return null;
    return hub.onPrice((p) => {
      if (p.source === 'db' || !Number.isFinite(p.ltp) || p.ltp <= 0) return;
      fn({ key: refKey(p.ref), ltp: p.ltp, at: p.at });
    });
  }
}
