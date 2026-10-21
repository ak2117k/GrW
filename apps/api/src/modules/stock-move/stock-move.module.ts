import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { STOCK_MOVE_READER, STOCK_MOVE_WATCH, StockMoveService } from './stock-move.service';

/**
 * Stock big-move model, read side (docs/superpowers/plans/2026-10-22-stock-move-contract.md,
 * stream W). The MBM service writes `stock_move_scores` nightly; this module only reads it, into an
 * in-memory book refreshed ≤ 30 min. Shadow by default: the scorecard counts it 0 points unless the
 * owner approves `scorecard.stockMove.points`.
 *
 * `@Global` so the scorecard, the night report and the sentinel packet can inject
 * {@link STOCK_MOVE_READER} / {@link STOCK_MOVE_WATCH} with `@Optional()` without importing it.
 */
@Global()
@Module({
  providers: [
    { provide: StockMoveService, useFactory: (prisma: PrismaService) => StockMoveService.fromPrisma(prisma), inject: [PrismaService] },
    { provide: STOCK_MOVE_READER, useExisting: StockMoveService },
    { provide: STOCK_MOVE_WATCH, useExisting: StockMoveService },
  ],
  exports: [StockMoveService, STOCK_MOVE_READER, STOCK_MOVE_WATCH],
})
export class StockMoveModule {}
