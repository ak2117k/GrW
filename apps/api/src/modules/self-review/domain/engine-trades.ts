import { istYmd } from '../../night-report/domain/night-report.logic';

/**
 * The entry engine (stage 1, owner 2026-10-30), for the run summary and the nightly diagnosis: its
 * recorded decisions (entry_engine_decisions — ENTER_CE / ENTER_PE / NO_TRADE every 15 min per
 * underlying) and its PAPER trades (strategy ENGINE_ENTRY), GROSS ₹ of the closed ones (side ×
 * (exit − entry) × qty, as the signal paper splits). Grouped by IST date; `session` = S, `rolling20`
 * = the run's sessions. OBSERVATION ONLY: nothing here changes a decision or a threshold. Pure.
 */
export const ENGINE_MIN_SAMPLE = 10;

export interface EngineDecisionRow {
  at: Date;
  underlying: string;
  action: string;
  mode: string;
  tradeId: string | null;
  /** The decision's first reasons, one line each (news / trend / oi). */
  reasons: string[];
}

export interface EngineTradeRow {
  id: string;
  createdAt: Date;
  underlying: string | null;
  symbol: string | null;
  status: string;
  side: string | null;
  quantity: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  exitReasonTag: string | null;
}

export interface EngineWindow {
  decisions: number;
  enters: number;
  byAction: Record<string, number>;
  byUnderlying: Record<string, { decisions: number; enters: number }>;
  trades: number;
  closed: number;
  wins: number;
  losses: number;
  winRate: number | null;
  /** ₹ gross of the closed engine paper trades. */
  gross: number;
}

export interface SessionEngineTrade {
  symbol: string | null;
  underlying: string | null;
  status: string;
  gross: number | null;
  exitTag: string | null;
}

export interface SessionEngineEnter {
  at: string;
  underlying: string;
  action: string;
  mode: string;
  traded: boolean;
  why: string[];
}

export interface EngineSummary {
  session: EngineWindow & { tradeList: SessionEngineTrade[]; enterList: SessionEngineEnter[] };
  rolling20: EngineWindow;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const SESSION_MAX = 40;
const WHY_MAX = 200;

export function engineGross(t: Pick<EngineTradeRow, 'status' | 'side' | 'quantity' | 'entryPrice' | 'exitPrice'>): number | null {
  if (t.status !== 'CLOSED' || !(t.entryPrice! > 0) || !(t.exitPrice! > 0) || !Number.isFinite(t.quantity ?? NaN)) return null;
  const sign = String(t.side ?? 'BUY').toUpperCase() === 'SELL' ? -1 : 1;
  return r2(sign * ((t.exitPrice as number) - (t.entryPrice as number)) * (t.quantity as number));
}

function window(decisions: readonly EngineDecisionRow[], trades: readonly EngineTradeRow[]): EngineWindow {
  const byAction: Record<string, number> = {};
  const byUnderlying: Record<string, { decisions: number; enters: number }> = {};
  for (const d of decisions) {
    byAction[d.action] = (byAction[d.action] ?? 0) + 1;
    const u = (byUnderlying[d.underlying] ??= { decisions: 0, enters: 0 });
    u.decisions++;
    if (d.action !== 'NO_TRADE') u.enters++;
  }
  const grosses = trades.map(engineGross).filter((g): g is number => g !== null);
  const wins = grosses.filter((g) => g > 0).length;
  return {
    decisions: decisions.length,
    enters: decisions.filter((d) => d.action !== 'NO_TRADE').length,
    byAction,
    byUnderlying,
    trades: trades.length,
    closed: grosses.length,
    wins,
    losses: grosses.filter((g) => g < 0).length,
    winRate: grosses.length ? r2(wins / grosses.length) : null,
    gross: r2(grosses.reduce((s, g) => s + g, 0)),
  };
}

export function engineStats(rows: { decisions: EngineDecisionRow[]; trades: EngineTradeRow[] }, sessions: readonly string[]): EngineSummary {
  const S = sessions[0];
  const inWin = new Set(sessions);
  const d = rows.decisions.filter((r) => inWin.has(istYmd(r.at)));
  const t = rows.trades.filter((r) => inWin.has(istYmd(r.createdAt)));
  const dS = d.filter((r) => istYmd(r.at) === S);
  const tS = t.filter((r) => istYmd(r.createdAt) === S);
  return {
    session: {
      ...window(dS, tS),
      tradeList: tS.slice(0, SESSION_MAX).map((x) => ({ symbol: x.symbol, underlying: x.underlying, status: x.status, gross: engineGross(x), exitTag: x.exitReasonTag })),
      enterList: dS
        .filter((x) => x.action !== 'NO_TRADE')
        .slice(0, SESSION_MAX)
        .map((x) => ({ at: x.at.toISOString(), underlying: x.underlying, action: x.action, mode: x.mode, traded: x.tradeId !== null, why: x.reasons.slice(0, 4).map((r) => r.slice(0, WHY_MAX)) })),
    },
    rolling20: window(d, t),
  };
}

const compact = (w: EngineWindow) => ({ decisions: w.decisions, enters: w.enters, byAction: w.byAction, trades: w.trades, closed: w.closed, wins: w.wins, losses: w.losses, winRate: w.winRate, gross: w.gross });

/**
 * The engine block for the diagnosis: S and rolling-20 counts and gross, S's ENTER decisions with
 * their reasons and S's engine trades. null when the window has no engine decision (nothing to assess).
 */
export function engineDigest(s: EngineSummary | undefined | null) {
  if (!s || (s.rolling20?.decisions ?? 0) === 0) return null;
  return {
    basis: `entry engine stage 1: ENTER only when news (news_impacts), trend (VWAP + 15m/1h EMA) and OI (chain lean / futures buildup) agree; gross ₹ = side × (exit − entry) × qty of the closed ENGINE_ENTRY paper trades, charges left out; under ${ENGINE_MIN_SAMPLE} closed trades = insufficient sample`,
    sampleOk: s.rolling20.closed >= ENGINE_MIN_SAMPLE,
    session: compact(s.session),
    rolling20: compact(s.rolling20),
    sessionEnters: s.session.enterList ?? [],
    sessionTrades: s.session.tradeList ?? [],
  };
}

export type EngineDigest = NonNullable<ReturnType<typeof engineDigest>>;
