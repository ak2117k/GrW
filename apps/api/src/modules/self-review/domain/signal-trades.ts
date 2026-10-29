import { istYmd } from '../../night-report/domain/night-report.logic';
import { liveSummary, paperByJudge, paperByOi, paperSummary, type JudgeBucket, type JudgeSplit, type OiSplit, type TradeOutcomeSummary } from '../../signal-trader/domain/paper-summary';
import type { OiVerdict } from '../../signal-trader/domain/oi-check';

/**
 * Telegram signal trades, live vs PAPER (no funds), for the run summary (owner request 2026-10-23:
 * the paper trades made when the account lacked funds are analysed next to the live ones). Pure.
 * Grouped by the IST date the trade was opened; `session` = S, `rolling20` = the run's sessions.
 * The paper trades are also split by the OI check recorded at their open and by the AI entry judge's
 * call (owner 2026-10-29: does "OI against" lose? — record only until the review says otherwise).
 * The splits are GROSS — side × (exit − entry) × qty of the closed trades, the signals page's basis —
 * never the booked pnl: 24 closed paper trades of 28–29 Oct carry a double-counted pnl (a since-fixed
 * closeTrade bug, left unrepaired by the owner) that would inflate them ~2×. {@link signalPaperDigest}
 * is the compact form the nightly diagnosis reasons over.
 */
export type JudgeCall = 'TAKE' | 'SKIP' | 'NONE';

export interface SignalTradeRows {
  paper: Array<{
    createdAt: Date;
    status: string;
    pnl: number | null;
    side?: string | null;
    quantity?: number | null;
    entryPrice?: number | null;
    exitPrice?: number | null;
    oiVerdict?: OiVerdict;
    oiSummary?: string | null;
    aiDecision?: JudgeCall;
    symbol?: string | null;
  }>;
  live: Array<{ createdAt: Date; status: string; trackerStatus: string | null; pnl: number | null }>;
}

/** One of S's paper trades with its OI verdict and the check's one-line reasoning; `gross` null while open / unpriced. */
export interface SessionPaperTrade {
  symbol: string | null;
  side: string | null;
  status: string;
  gross: number | null;
  aiDecision: JudgeCall;
  oiVerdict: OiVerdict;
  oiSummary: string | null;
}

interface Window {
  live: TradeOutcomeSummary;
  paperNoFunds: TradeOutcomeSummary;
  /** Gross buckets (paper-summary JudgeBucket). */
  paperByOi: OiSplit;
  paperByJudge: JudgeSplit;
}

export interface SignalTradesSummary {
  session: Window & { paperTrades: SessionPaperTrade[] };
  rolling20: Window;
}

const OI_VERDICTS: readonly OiVerdict[] = ['AGREES', 'AGAINST', 'MIXED', 'NO_DATA'];
const JUDGE_CALLS: readonly JudgeCall[] = ['TAKE', 'SKIP', 'NONE'];
/** S's paper trades listed for the diagnosis, and each reasoning line's length. */
const SESSION_TRADES_MAX = 40;
const OI_SUMMARY_MAX = 220;

type PaperRow = SignalTradeRows['paper'][number];
const oiOf = (p: PaperRow): OiVerdict => p.oiVerdict ?? 'NO_DATA';
const judgeOf = (p: PaperRow): JudgeCall => p.aiDecision ?? 'NONE';
const asTrade = (p: PaperRow) => ({ status: p.status, side: p.side ?? 'BUY', quantity: p.quantity ?? NaN, entryPrice: p.entryPrice ?? null, exitPrice: p.exitPrice ?? null, pnl: p.pnl });

/** A closed trade's gross ₹ (null when open or unpriced) — the same rule as paper-summary's buckets. */
function grossOf(p: PaperRow): number | null {
  if (p.status !== 'CLOSED' || !(p.entryPrice! > 0) || !(p.exitPrice! > 0) || !Number.isFinite(p.quantity ?? NaN)) return null;
  const g = (String(p.side ?? 'BUY').toUpperCase() === 'SELL' ? -1 : 1) * ((p.exitPrice as number) - (p.entryPrice as number)) * (p.quantity as number);
  return Math.round(g * 100) / 100;
}

function window(paper: PaperRow[], live: SignalTradeRows['live']): Window {
  return {
    live: liveSummary(live),
    paperNoFunds: paperSummary(paper),
    paperByOi: paperByOi(paper.map((p) => ({ oiVerdict: oiOf(p), trade: asTrade(p) }))),
    paperByJudge: paperByJudge(paper.map((p) => ({ aiDecision: judgeOf(p), trade: asTrade(p) }))),
  };
}

export function signalTradeStats(rows: SignalTradeRows, sessions: readonly string[]): SignalTradesSummary {
  const S = sessions[0];
  const inWindow = new Set(sessions);
  const paper = rows.paper.filter((r) => inWindow.has(istYmd(r.createdAt)));
  const live = rows.live.filter((r) => inWindow.has(istYmd(r.createdAt)));
  const onS = <T extends { createdAt: Date }>(xs: T[]) => xs.filter((r) => istYmd(r.createdAt) === S);
  const paperTrades = onS(paper)
    .slice(0, SESSION_TRADES_MAX)
    .map((p) => ({
      symbol: p.symbol ?? null,
      side: p.side ?? null,
      status: p.status,
      gross: grossOf(p),
      aiDecision: judgeOf(p),
      oiVerdict: oiOf(p),
      oiSummary: p.oiSummary ? p.oiSummary.slice(0, OI_SUMMARY_MAX) : null,
    }));
  return {
    session: { ...window(onS(paper), onS(live)), paperTrades },
    rolling20: window(paper, live),
  };
}

/** One gross bucket for the diagnosis. */
function bucket(b: JudgeBucket | undefined) {
  if (!b) return null;
  return { n: b.n, closed: b.closed, wins: b.wins, losses: b.losses, winRate: b.winRate, gross: b.gross, openMark: b.openMark };
}

function compact<K extends string>(keys: readonly K[], rec: Record<K, JudgeBucket> | undefined) {
  return Object.fromEntries(keys.map((k) => [k, bucket(rec?.[k])]));
}

/**
 * The paper splits by OI verdict and by AI judge call — S and rolling-20, GROSS ₹ of the closed
 * trades — plus S's paper trades with their verdict and reasoning line, compact for the diagnosis
 * message. null when there are no paper trades in the window (nothing to assess). Older summaries
 * without the splits give null buckets.
 */
export function signalPaperDigest(s: SignalTradesSummary | undefined | null) {
  if (!s || (s.rolling20.paperNoFunds?.n ?? 0) === 0) return null;
  return {
    basis: 'gross ₹ = side × (exit − entry) × qty of the closed trades, charges left out',
    session: { byOi: compact(OI_VERDICTS, s.session.paperByOi), byJudge: compact(JUDGE_CALLS, s.session.paperByJudge) },
    rolling20: { byOi: compact(OI_VERDICTS, s.rolling20.paperByOi), byJudge: compact(JUDGE_CALLS, s.rolling20.paperByJudge) },
    sessionTrades: (s.session.paperTrades ?? []).map((t) => ({ symbol: t.symbol, side: t.side, status: t.status, gross: t.gross, judge: t.aiDecision, oi: t.oiVerdict, oiWhy: t.oiSummary })),
  };
}

export type SignalPaperDigest = NonNullable<ReturnType<typeof signalPaperDigest>>;
