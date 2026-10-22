/** Night Report view of the setups — types only, so readers (night-report, the sentinel packet path) never import the service. */
import type { TradeSetupDraft } from './trade-setup.logic';

export interface TradeSetupView {
  id: string;
  sessionDate: string;
  symbol: string;
  exchange: string;
  instrument: string;
  instrumentKind: string;
  expiry: string | null;
  lotSize: number | null;
  side: string;
  entryRule: string;
  entryRef: number;
  stop: number;
  stopDistance: number;
  target1: number;
  target2: number;
  atr: number;
  qty: number;
  lots: number | null;
  riskRs: number;
  riskPct: number;
  rewardT1Rs: number;
  rewardT2Rs: number;
  marginUsed: number;
  marginAvailable: number | null;
  marginAsOf: string | null;
  marginSource: string;
  exceedsRisk: boolean;
  inputs: TradeSetupDraft['inputs'];
  outcome: { status: string; r: number | null; hitT1: boolean | null } | null;
  updatedAt: string;
}

export interface TradeSetupsView {
  /** IST date of the next NSE session (the one the setups are for). */
  sessionDate: string | null;
  setups: TradeSetupView[];
  advisory: string;
}

