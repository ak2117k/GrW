import type { OiVerdict } from './oi-check';

/**
 * Paper (no funds) vs live signal trades, side by side (the page and the self-review). Pure.
 * A trade is a WIN when its P&L is > 0, a LOSS when < 0; open trades count their mark-to-market
 * P&L in `pnl` but not in wins/losses.
 */
export interface TradeOutcomeSummary {
  n: number;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  /** Rows with no trade (paper could not be opened / live order never filled). */
  noTrade: number;
  /** ₹ closed + open (mark) P&L. */
  pnl: number;
  /** ₹ closed P&L only. */
  realised: number;
  /** wins / (wins + losses) of the closed trades; null when none closed. */
  winRate: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function summarise(rows: Array<{ open: boolean; pnl: number | null } | null>): TradeOutcomeSummary {
  const s: TradeOutcomeSummary = { n: rows.length, open: 0, closed: 0, wins: 0, losses: 0, noTrade: 0, pnl: 0, realised: 0, winRate: null };
  for (const r of rows) {
    if (!r) {
      s.noTrade += 1;
      continue;
    }
    const p = typeof r.pnl === 'number' && Number.isFinite(r.pnl) ? r.pnl : 0;
    s.pnl += p;
    if (r.open) {
      s.open += 1;
      continue;
    }
    s.closed += 1;
    s.realised += p;
    if (p > 0) s.wins += 1;
    else if (p < 0) s.losses += 1;
  }
  s.pnl = r2(s.pnl);
  s.realised = r2(s.realised);
  s.winRate = s.wins + s.losses > 0 ? r2(s.wins / (s.wins + s.losses)) : null;
  return s;
}

/** Paper trades (Trade rows; null = no paper trade for that decision). */
export function paperSummary(trades: Array<{ status: string; pnl: number | null } | null>): TradeOutcomeSummary {
  return summarise(trades.map((t) => (t ? { open: t.status !== 'CLOSED', pnl: t.pnl } : null)));
}

/** One bucket of the paper trades by the AI entry judge's call. */
export interface JudgeBucket {
  /** Paper trades in the bucket (decisions with no paper trade are left out). */
  n: number;
  closed: number;
  open: number;
  wins: number;
  losses: number;
  /** ₹ GROSS of the closed trades: side × (exit − entry) × qty — charges left out. */
  gross: number;
  /** ₹ mark-to-market of the open ones (the row's P&L, which the paper watch writes gross). */
  openMark: number;
  /** wins / (wins + losses), null when none closed. */
  winRate: number | null;
}

export type JudgeSplit = Record<'TAKE' | 'SKIP' | 'NONE', JudgeBucket>;
/** The same buckets keyed by the OI check's verdict at entry. */
export type OiSplit = Record<OiVerdict, JudgeBucket>;

/**
 * The AI entry judge's call on a PAPER decision: learning mode records it as `aiDecision`; a plain
 * no-funds PAPER decision (no `aiDecision`) only exists after the judge said TAKE, so its `verdict` is it.
 */
export function judgeCallOf(judgeRecord: unknown): 'TAKE' | 'SKIP' | 'NONE' {
  const r = judgeRecord && typeof judgeRecord === 'object' && !Array.isArray(judgeRecord) ? (judgeRecord as Record<string, unknown>) : {};
  if (r.aiDecision === 'TAKE' || r.aiDecision === 'SKIP' || r.aiDecision === 'NONE') return r.aiDecision;
  return r.verdict === 'TAKE' || r.verdict === 'SKIP' ? r.verdict : 'NONE';
}

const emptyBucket = (): JudgeBucket => ({ n: 0, closed: 0, open: 0, wins: 0, losses: 0, gross: 0, openMark: 0, winRate: null });

/**
 * Paper P&L split by the AI entry judge (owner 2026-10-29): learning mode books every call, including
 * the ones the AI rejected — this shows what the AI-approved (TAKE) trades made apart from the SKIPs
 * and the calls with no judge verdict (NONE). Closed P&L is recomputed GROSS from entry / exit /
 * quantity, never read from the row's pnl, so it is right whatever the paper close books (charges, or a
 * close-path bug). Pure.
 */
export function paperByJudge(rows: ReadonlyArray<{ aiDecision: 'TAKE' | 'SKIP' | 'NONE'; trade: BucketTrade | null }>): JudgeSplit {
  return bucketPaper(['TAKE', 'SKIP', 'NONE'] as const, 'NONE', rows.map((r) => ({ key: r.aiDecision, trade: r.trade })));
}

/** Paper P&L split by the OI check's verdict at entry (domain/oi-check), same gross rule as the judge split. Pure. */
export function paperByOi(rows: ReadonlyArray<{ oiVerdict: OiVerdict; trade: BucketTrade | null }>): OiSplit {
  return bucketPaper(['AGREES', 'AGAINST', 'MIXED', 'NO_DATA'] as const, 'NO_DATA', rows.map((r) => ({ key: r.oiVerdict, trade: r.trade })));
}

type BucketTrade = { status: string; side: string; quantity: number; entryPrice: number | null; exitPrice: number | null; pnl: number | null };

function bucketPaper<K extends string>(keys: readonly K[], fallback: K, rows: ReadonlyArray<{ key: K; trade: BucketTrade | null }>): Record<K, JudgeBucket> {
  const out = Object.fromEntries(keys.map((k) => [k, emptyBucket()])) as Record<K, JudgeBucket>;
  for (const r of rows) {
    const t = r.trade;
    if (!t) continue;
    const b = out[r.key] ?? out[fallback];
    b.n += 1;
    if (t.status !== 'CLOSED') {
      b.open += 1;
      if (typeof t.pnl === 'number' && Number.isFinite(t.pnl)) b.openMark += t.pnl;
      continue;
    }
    b.closed += 1;
    const priced = t.entryPrice !== null && t.entryPrice > 0 && t.exitPrice !== null && t.exitPrice > 0 && Number.isFinite(t.quantity);
    const g = priced ? (String(t.side).toUpperCase() === 'SELL' ? -1 : 1) * ((t.exitPrice as number) - (t.entryPrice as number)) * t.quantity : 0;
    b.gross += g;
    if (g > 0) b.wins += 1;
    else if (g < 0) b.losses += 1;
  }
  for (const b of Object.values<JudgeBucket>(out)) {
    b.gross = r2(b.gross);
    b.openMark = r2(b.openMark);
    b.winRate = b.wins + b.losses > 0 ? r2(b.wins / (b.wins + b.losses)) : null;
  }
  return out;
}

/** Live signal orders: only a FILLED / PARTIAL entry is a trade; its tracker carries the P&L. */
export function liveSummary(orders: Array<{ status: string; trackerStatus: string | null; pnl: number | null }>): TradeOutcomeSummary {
  const filled = orders.filter((o) => o.status === 'FILLED' || o.status === 'PARTIAL');
  const s = summarise(filled.map((o) => ({ open: o.trackerStatus !== 'CLOSED', pnl: o.pnl })));
  return { ...s, noTrade: orders.length - filled.length, n: orders.length };
}
