// apps/api/src/modules/sentinel-executor/dto/ai-exit-execution.dto.ts
import type { AiExitExecution, AiExitOutcome } from '@prisma/client';
import { gateSummary } from '../../exit-discipline/decision';
import type { GateOutcome, GateRecordV1, OutcomeKind } from '../../exit-discipline/types';
import { triggerIdOf, triggerOf, type ExitTrigger } from '../domain/manual-exit';

/** E7: what the exit gate decided for this row (AI rows only). */
export interface AiExitGateDto { outcome: GateOutcome; justification: string | null; summary: string }
/** E5: execution quality. costPerUnit > 0 = the fill was worse than the decision price. */
export interface AiExitQualityDto {
  decisionLtp: number | null; orderLtp: number | null; fillPrice: number | null; fillAt: string | null;
  slippage: number | null; costPerUnit: number | null; latencyMs: number | null;
}
/** Spec §8: what the price did after the decision. */
export interface AiExitOutcomeDto {
  kind: OutcomeKind; status: 'PENDING' | 'DONE' | 'NO_DATA';
  missedPnl: number | null; savedPnl: number | null; netAtEnd: number | null; windowEnd: string;
}

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
  /** Exit discipline (E7 / E5 / §8); null when not recorded (older rows, MANUAL, not scored yet). */
  gate: AiExitGateDto | null;
  quality: AiExitQualityDto | null;
  outcome: AiExitOutcomeDto | null;
  createdAt: string;
  updatedAt: string;
}

const GATE_OUTCOMES: readonly string[] = ['PASS', 'GATED_THESIS_INTACT', 'AWAITING_CONFIRMATION', 'BYPASS'];

/** The stored gate JSON as a DTO; anything that is not a GateRecordV1 is null (never a throw). */
function gateDto(raw: unknown): AiExitGateDto | null {
  const g = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<GateRecordV1>) : null;
  if (!g || g.v !== 1 || !GATE_OUTCOMES.includes(String(g.outcome)) || !Array.isArray(g.clauses)) return null;
  let summary: string;
  try {
    summary = gateSummary(g as GateRecordV1);
  } catch {
    summary = String(g.outcome);
  }
  return { outcome: g.outcome as GateOutcome, justification: g.justification ?? null, summary };
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function qualityDto(r: AiExitExecution): AiExitQualityDto | null {
  if (r.decisionLtp == null && r.orderLtp == null && r.fillPrice == null) return null;
  const cost = r.fillPrice != null && r.decisionLtp != null
    ? r2(r.side === 'BUY' ? r.fillPrice - r.decisionLtp : r.decisionLtp - r.fillPrice)
    : null;
  return {
    decisionLtp: r.decisionLtp ?? null, orderLtp: r.orderLtp ?? null, fillPrice: r.fillPrice ?? null,
    fillAt: r.fillAt ? r.fillAt.toISOString() : null, slippage: r.slippage ?? null, costPerUnit: cost, latencyMs: r.latencyMs ?? null,
  };
}

function outcomeDto(o: AiExitOutcome | null | undefined): AiExitOutcomeDto | null {
  if (!o) return null;
  return {
    kind: o.kind as OutcomeKind, status: o.status as AiExitOutcomeDto['status'],
    missedPnl: o.missedPnl ?? null, savedPnl: o.savedPnl ?? null, netAtEnd: o.netAtEnd ?? null, windowEnd: o.windowEnd.toISOString(),
  };
}

export function toAiExitExecutionDto(r: AiExitExecution, outcome?: AiExitOutcome | null): AiExitExecutionDto {
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
    gate: gateDto(r.gate),
    quality: qualityDto(r),
    outcome: outcomeDto(outcome),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
