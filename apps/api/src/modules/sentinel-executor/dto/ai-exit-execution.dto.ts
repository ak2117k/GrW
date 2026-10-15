// apps/api/src/modules/sentinel-executor/dto/ai-exit-execution.dto.ts
import type { AiExitExecution } from '@prisma/client';
import { triggerIdOf, triggerOf, type ExitTrigger } from '../domain/manual-exit';

/** Wire contract of GET /api/sentinel-executor/executions (copied into the web, plan Task 12). */
export interface AiExitExecutionDto {
  id: string;
  verdictId: string;
  trackerId: string;
  symbol: string;
  exchange: string | null;
  side: 'BUY' | 'SELL' | null;
  quantity: number | null;
  productType: string | null;
  orderType: 'MARKET' | 'LIMIT' | null;
  limitPrice: number | null;
  mode: 'dry-run' | 'live';
  status: 'CLAIMED' | 'SKIPPED' | 'DRY_RUN' | 'PLACED' | 'FILLED' | 'REJECTED' | 'FAILED';
  reason: string | null;
  sessionSource: 'user-feed' | 'ephemeral' | null;
  brokerOrderId: string | null;
  brokerMessage: string | null;
  orderStatus: string | null;
  marketOrderId: string | null;
  verdictReason: string;
  /**
   * AI = a sentinel EXIT_NOW verdict; MANUAL = the owner's "Exit now" button (synthetic verdictId man_…);
   * PRICE_TRIGGER = a sentinel price trigger fired (synthetic verdictId trg_…).
   */
  trigger: ExitTrigger;
  /** The sentinel_exit_triggers row behind a PRICE_TRIGGER execution; null otherwise. */
  triggerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toAiExitExecutionDto(r: AiExitExecution): AiExitExecutionDto {
  return {
    id: r.id,
    verdictId: r.verdictId,
    trackerId: r.trackerId,
    symbol: r.symbol,
    exchange: r.exchange,
    side: r.side as AiExitExecutionDto['side'],
    quantity: r.quantity,
    productType: r.productType,
    orderType: r.orderType as AiExitExecutionDto['orderType'],
    limitPrice: r.limitPrice,
    mode: r.mode as AiExitExecutionDto['mode'],
    status: r.status as AiExitExecutionDto['status'],
    reason: r.reason,
    sessionSource: r.sessionSource as AiExitExecutionDto['sessionSource'],
    brokerOrderId: r.brokerOrderId,
    brokerMessage: r.brokerMessage,
    orderStatus: r.orderStatus,
    marketOrderId: r.marketOrderId,
    verdictReason: r.verdictReason,
    trigger: triggerOf(r.verdictId),
    triggerId: triggerIdOf(r.verdictId),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
