import { Injectable } from '@nestjs/common';
import { OiWallService } from '../../signal-generator/services/oi-wall.service';
import type { OiWallCandidate, OiWallSource } from '../ports/open-positions.port';

/**
 * `OiWallSource` over the real `OiWallService`.
 *
 * READ THIS BEFORE CLAIMING SHADOW MODE IS AIRTIGHT. `OiWallService` reaches
 * `OptionsChainService`, which reaches the market feed, which reaches the Angel
 * One adapter — and that adapter has `placeOrder`. So this adapter is a real
 * edge from the composition root to broker-capable code.
 *
 * The property Task 11 proves is narrower than "no order-placing service is in
 * the injector": it is that no order-placing service is reachable BY FOLLOWING
 * IMPORTS FROM `sentinel-cycle.service.ts`. That still holds, and the port is
 * what makes it hold — the cycle sees `OiWallSource`, an interface with one
 * method returning two numbers, and this file (which does reach the broker) is
 * imported only by `trade-sentinel.module.ts`, which the cycle does not import.
 *
 * The composition root is the right place for that edge to exist, because it is
 * the one file where a human is deciding what is wired to what. It is the wrong
 * place to be vague about it, hence this comment.
 *
 * `OiWallService` is a SHARED instance from `SignalGeneratorModule`, not a local
 * re-provide: it de-duplicates its "no chain for this symbol" warnings through
 * an instance-level `warned` Set, and a second instance would restart that log
 * spam on the sentinel's own poll.
 */
@Injectable()
export class SentinelOiWallSource implements OiWallSource {
  constructor(private readonly oiWalls: OiWallService) {}

  /**
   * `OiWallService.walls` never throws and returns `[]` for a cash stock, a
   * failed chain fetch and an unwired options-chain service alike — the caller
   * (`OiWallSnapshotService`) already knows that and says so in its warning, so
   * nothing is flattened or reinterpreted here.
   *
   * `LevelCandidate` carries a `score` this port does not want; it is dropped
   * rather than passed through, so nothing downstream can mistake a rank for an
   * open-interest figure.
   */
  async walls(symbol: string, underlyingLtp: number): Promise<OiWallCandidate[]> {
    const candidates = await this.oiWalls.walls(symbol, underlyingLtp);
    return candidates.map((c) => ({ price: c.price, kind: c.kind }));
  }
}
