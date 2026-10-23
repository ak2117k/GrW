import { istYmd } from '../../night-report/domain/night-report.logic';
import { liveSummary, paperSummary, type TradeOutcomeSummary } from '../../signal-trader/domain/paper-summary';

/**
 * Telegram signal trades, live vs PAPER (no funds), for the run summary (owner request 2026-10-23:
 * the paper trades made when the account lacked funds are analysed next to the live ones). Pure.
 * Grouped by the IST date the trade was opened; `session` = S, `rolling20` = the run's sessions.
 */
export interface SignalTradeRows {
  paper: Array<{ createdAt: Date; status: string; pnl: number | null }>;
  live: Array<{ createdAt: Date; status: string; trackerStatus: string | null; pnl: number | null }>;
}

export interface SignalTradesSummary {
  session: { live: TradeOutcomeSummary; paperNoFunds: TradeOutcomeSummary };
  rolling20: { live: TradeOutcomeSummary; paperNoFunds: TradeOutcomeSummary };
}

export function signalTradeStats(rows: SignalTradeRows, sessions: readonly string[]): SignalTradesSummary {
  const S = sessions[0];
  const inWindow = new Set(sessions);
  const paper = rows.paper.filter((r) => inWindow.has(istYmd(r.createdAt)));
  const live = rows.live.filter((r) => inWindow.has(istYmd(r.createdAt)));
  const onS = <T extends { createdAt: Date }>(xs: T[]) => xs.filter((r) => istYmd(r.createdAt) === S);
  return {
    session: { live: liveSummary(onS(live)), paperNoFunds: paperSummary(onS(paper)) },
    rolling20: { live: liveSummary(live), paperNoFunds: paperSummary(paper) },
  };
}
