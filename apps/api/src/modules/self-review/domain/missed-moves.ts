import type { VerificationDraft } from '../self-review.types';

/**
 * The missed-move review (owner 2026-11-09): the rest of the self-review grades what the system decided, so a
 * stock it never looked at could not be a mistake. This asks the opposite question: which F&O stocks moved hard
 * today, did we have them, and if not, where did the pipeline lose them? Pure.
 */

/** One session's move, in daily ATRs, that counts as big (2026-10-28 to 11-06: 3 to 16 stocks a day). */
export const MISSED_MOVE_MIN_ATR = 2;
/** At most this many moves are reviewed per session, biggest first. */
export const MISSED_MOVE_CAP = 10;
/** Slots of the diagnosis reserved for missed moves, so bp- and rupee-scored misses cannot crowd them out. */
export const MISSED_MOVE_DIAGNOSIS_SLOTS = 5;

export interface DailyMoveRow {
  symbol: string;
  close: number | null;
  prevClose: number | null;
  /** ATR as a fraction of price, from the session before the move. */
  atrPct: number | null;
  bucket: string | null;
  rankPct: number | null;
  resultsInWindow: boolean;
}

export interface BigMove {
  symbol: string;
  retPct: number;
  atrMove: number;
  bucket: string | null;
  rankPct: number | null;
  resultsInWindow: boolean;
}

/** What the system had on one stock between the previous close and this session's close. */
export interface MoveEvidence {
  realTrade: boolean;
  paperTrade: boolean;
  /** Trade-setup sides: LONG | SHORT. */
  setups: string[];
  /** News-idea calls: CE_IDEA | PE_IDEA | NO_TRADE. */
  ideas: string[];
  /** Telegram-signal directions: BULL | BEAR. */
  signals: string[];
  /** Non-boilerplate stories tagged with the stock. */
  articles: number;
  /** The AI's reads of those stories. */
  reads: Array<{ direction: string; magnitude: string }>;
}

export const NO_EVIDENCE: MoveEvidence = { realTrade: false, paperTrade: false, setups: [], ideas: [], signals: [], articles: 0, reads: [] };

export type MissCause =
  | 'TRADED'
  | 'PAPER_ONLY'
  | 'SETUP_NOT_TAKEN'
  | 'IDEA_NOT_TAKEN'
  | 'IDEA_REJECTED'
  | 'SIGNAL_NOT_TAKEN'
  | 'NEWS_NOT_READ'
  | 'NEWS_READ_NOT_USED'
  | 'NEWS_READ_LOW'
  | 'MODEL_ONLY'
  | 'NO_SIGNAL';

const round = (x: number, dp: number): number => Math.round(x * 10 ** dp) / 10 ** dp;

/** The session's biggest moves: at least `minAtr` daily ATRs, close to close. Rows missing a price or an ATR are skipped. */
export function bigMoves(rows: readonly DailyMoveRow[], minAtr = MISSED_MOVE_MIN_ATR, cap = MISSED_MOVE_CAP): BigMove[] {
  const out: BigMove[] = [];
  for (const r of rows) {
    if (!(r.close && r.close > 0) || !(r.prevClose && r.prevClose > 0) || !(r.atrPct && r.atrPct > 0)) continue;
    const ret = r.close / r.prevClose - 1;
    const atrMove = Math.abs(ret) / r.atrPct;
    if (atrMove < minAtr) continue;
    out.push({ symbol: r.symbol, retPct: round(ret * 100, 2), atrMove: round(atrMove, 2), bucket: r.bucket, rankPct: r.rankPct, resultsInWindow: r.resultsInWindow });
  }
  return out.sort((a, b) => b.atrMove - a.atrMove || a.symbol.localeCompare(b.symbol)).slice(0, cap);
}

/** The furthest point the stock reached in our pipeline, nearest to a trade first. */
export function missCause(move: BigMove, e: MoveEvidence): MissCause {
  const up = move.retPct > 0;
  if (e.realTrade) return 'TRADED';
  if (e.paperTrade) return 'PAPER_ONLY';
  if (e.setups.includes(up ? 'LONG' : 'SHORT')) return 'SETUP_NOT_TAKEN';
  if (e.ideas.includes(up ? 'CE_IDEA' : 'PE_IDEA')) return 'IDEA_NOT_TAKEN';
  if (e.ideas.length > 0) return 'IDEA_REJECTED';
  if (e.signals.includes(up ? 'BULL' : 'BEAR')) return 'SIGNAL_NOT_TAKEN';
  if (e.articles > 0) {
    if (e.reads.length === 0) return 'NEWS_NOT_READ';
    const usable = e.reads.some((r) => r.direction === (up ? 'BULL' : 'BEAR') && (r.magnitude === 'MED' || r.magnitude === 'HIGH'));
    return usable ? 'NEWS_READ_NOT_USED' : 'NEWS_READ_LOW';
  }
  return move.bucket === 'TOP20' ? 'MODEL_ONLY' : 'NO_SIGNAL';
}

const PLAIN: Record<MissCause, string> = {
  TRADED: 'held a real position',
  PAPER_ONLY: 'held a paper position only',
  SETUP_NOT_TAKEN: 'a setup on the right side existed, no position',
  IDEA_NOT_TAKEN: 'a news idea on the right side existed, no setup or position',
  IDEA_REJECTED: 'a news idea said NO_TRADE or the other side',
  SIGNAL_NOT_TAKEN: 'a Telegram signal on the right side existed, no position',
  NEWS_NOT_READ: 'news existed but the AI never read it',
  NEWS_READ_NOT_USED: 'the AI read the news as MED/HIGH on the right side, no idea followed',
  NEWS_READ_LOW: 'the AI read the news as low impact or the other side',
  MODEL_ONLY: 'only the big-move model flagged it (top 20)',
  NO_SIGNAL: 'nothing in the system flagged it',
};

/** A position (real or paper) counts as caught; everything else is a miss for the diagnosis. */
export function scoreMissedMove(sessionDate: string, move: BigMove, e: MoveEvidence): VerificationDraft {
  const cause = missCause(move, e);
  return {
    sessionDate,
    kind: 'MISSED_MOVE',
    refId: `${sessionDate}:${move.symbol}`,
    subject: cause,
    symbol: move.symbol,
    predicted: PLAIN[cause],
    actual: `${move.retPct > 0 ? '+' : ''}${move.retPct}% close to close (${move.atrMove} ATR)`,
    correct: cause === 'TRADED' || cause === 'PAPER_ONLY',
    score: move.atrMove,
    details: {
      cause,
      retPct: move.retPct,
      atrMove: move.atrMove,
      modelBucket: move.bucket,
      modelRankPct: move.rankPct,
      resultsInWindow: move.resultsInWindow,
      articles: e.articles,
      reads: e.reads,
      ideas: e.ideas,
      setups: e.setups,
      signals: e.signals,
    },
  };
}
