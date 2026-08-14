import { Injectable, Logger } from '@nestjs/common';
import { WatchStatus } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { EngineOwnershipProbe } from '../services/roster.service';
import { normaliseSymbol } from '../symbols';

/**
 * The watch status that means "this engine has a LIVE position it will close
 * itself". `WATCHING` is an alert that has not been executed — no position
 * exists, so nothing is owned. Every other status is terminal.
 *
 * Getting this wrong in the WATCHING direction would mark a position
 * `OBSERVE_ONLY` on the strength of an unrelated alert; getting it wrong in the
 * terminal direction would keep claiming ownership of a closed trade forever.
 */
const OWNED_STATUS = WatchStatus.TRADED;

/**
 * Which trades another engine is already managing.
 *
 * Four tables, one question. `watch-monitor`, `ungated-track`,
 * `adaptive-stop-track` and `sell-futures-track` each keep their own watch
 * table, each executes into the same Angel One account, and each closes what it
 * opened. A position one of them holds must therefore be OBSERVED by the
 * sentinel and never claimed — one owner per trade.
 *
 * PRISMA ONLY, NO ENGINE SERVICES. Injecting `WatchMonitorService` would put
 * that engine's executor (and through it the Angel One adapter) in the
 * sentinel's object graph, which is the property Stage 0 is built on. The same
 * argument as `OpenPositionsPort`, and the read is four `findMany`s.
 *
 * TENANCY, HONESTLY. `symbolsOwnedByOtherEngines` takes a `userId` and this
 * implementation IGNORES it, because none of the four watch tables HAS a
 * `userId` column — they predate the multi-tenant migration and all run against
 * the single operator account. The consequence is stated rather than hidden: on
 * a multi-user deployment this is over-broad, so user B's position in a symbol
 * user A's watch engine holds is marked `OBSERVE_ONLY`. That errs toward
 * observing rather than claiming, which is the safe direction (see
 * `symbols.ts`); the parameter is kept in the signature so the fix is a change
 * to these `where` clauses and nothing else once those tables gain a tenant.
 */
@Injectable()
export class EngineOwnershipAdapter implements EngineOwnershipProbe {
  private readonly logger = new Logger(EngineOwnershipAdapter.name);

  constructor(private readonly prisma: PrismaService) {}

  async symbolsOwnedByOtherEngines(userId: string): Promise<Set<string>> {
    const where = { status: OWNED_STATUS };
    const select = { symbol: true };

    try {
      const [watch, ungated, adaptive, sellFutures] = await Promise.all([
        this.prisma.watchEntry.findMany({ where, select }),
        this.prisma.ungatedWatchEntry.findMany({ where, select }),
        this.prisma.adaptiveStopWatchEntry.findMany({ where, select }),
        // This engine trades the FUTURES contract of an equity signal, so both
        // spellings can appear on the broker book and both must be claimed.
        this.prisma.sellFuturesWatchEntry.findMany({
          where,
          select: { symbol: true, futTradingsymbol: true },
        }),
      ]);

      const owned = new Set<string>();
      const add = (symbol: string | null | undefined) => {
        if (!symbol) return;
        // Normalised HERE, at the only place that fills this set, so the
        // roster's lookup cannot be comparing two different spellings.
        owned.add(normaliseSymbol(symbol));
      };

      for (const row of [...watch, ...ungated, ...adaptive]) add(row.symbol);
      for (const row of sellFutures) {
        add(row.symbol);
        add(row.futTradingsymbol);
      }
      return owned;
    } catch (err) {
      // FAIL CLOSED IS NOT AVAILABLE HERE and the alternative must be loud.
      // Rethrowing would take the whole roster down (`runForUser` rejects on a
      // roster failure), blinding the sentinel to every position over a read
      // that is only an attribution. Returning an empty set instead means every
      // position looks unowned, so the sentinel labels them `SENTINEL` —
      // harmless in shadow mode, and the reason this is logged at `error`
      // rather than swallowed: in Stage 1 an executor keys off that label.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `engine-ownership probe failed for user ${userId}: ${message}. Treating every position ` +
          'as UNOWNED for this cycle — verdicts recorded now may claim trades another engine ' +
          'manages. Stage 1 must not execute on an ownership label produced by a failed probe.',
      );
      return new Set<string>();
    }
  }
}
