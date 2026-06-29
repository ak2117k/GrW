import { IsString, IsOptional } from 'class-validator';

export class ApproveSignalDto {
  @IsOptional()
  @IsString()
  notes?: string;
}

export class RejectSignalDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export interface AutoTradeStatusResponse {
  mode: string;
  isRunning: boolean;
  pendingApprovals: number;
  lastScanStats: {
    processed: number;
    executed: number;
    pending: number;
    skipped: number;
    errors: number;
    timestamp: Date | null;
  };
}

export interface PendingApprovalResponse {
  signalId: string;
  symbol: string;
  exchange: string;
  side: string;
  entryPrice: number;
  targetPrice: number;
  stoplossPrice: number;
  confidence: string;
  confidenceScore: number;
  strategy: string;
  quantity: number;
  timestamp: Date;
}
