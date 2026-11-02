import { noiseFromBars } from '../../exit-discipline/noise';
import type { MinuteBar } from '../../exit-discipline/types';
import { NOISE_SCORE, scoreNoiseRead } from '../../exit-noise/domain/noise-score';
import type { Want } from '../../exit-noise/domain/noise-read';
import type { VerificationDraft } from '../self-review.types';

/**
 * The three kinds that make this week's real mistakes visible to the diagnosis (owner 2026-11-02: the
 * nightly review proposed nothing since 10-28 because only scorecard / overnight / live-exit / idea /
 * setup misses reach it). Pure.
 *
 *  SIGNAL_JUDGE — the Telegram entry judge's TAKE / SKIP on a closed learning paper trade, judged ONLY on
 *    the FAIR check (signal-trader domain/fair-score, stored on signal_decisions.ai_check.fair): WRONG = a
 *    miss. No fair block, or UNSCORABLE → not judged (null) — never the old no-stop rule. A RISK_CAP skip
 *    that was right is right (not a miss); one that was wrong IS a miss (the cap-sized trade would have paid).
 *  PAPER_EXIT — an AI exit (AI_EXIT / AI_TRIGGER) or the noise-trail exit (MOVED_STOP) of a PAPER trade:
 *    a miss ("premature exit") when the underlying recovered ≥ NOISE_SCORE.minMoveN exit units N in the
 *    trade's favour within 30 min (exit-noise/domain/noise-score, the same rule a NOISE read is scored by).
 *  ENGINE_ENTRY — a closed ENGINE_ENTRY paper trade: a gross loss is a miss, a gain is right, flat null.
 */
const r2 = (n: number) => Math.round(n * 100) / 100;
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const inr = (v: number) => `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v))}`;

// ─── SIGNAL_JUDGE ────────────────────────────────────────────────────────────

interface FairOutcomeLike {
  stop: number | null;
  result: string;
  price: number | null;
  pnl1Lot: number | null;
  reason?: string;
}
export interface FairLike {
  verdict: 'RIGHT' | 'WRONG' | 'UNSCORABLE';
  skipKind: 'RISK_CAP' | 'JUDGEMENT' | null;
  capStop: number | null;
  capOutcome: FairOutcomeLike;
  signalStop: number | null;
  signalStopOutcome: FairOutcomeLike;
  method: string;
  cap?: number | null;
}

export interface SignalJudgeRow {
  decisionId: string;
  sessionDate: string;
  symbol: string | null;
  channelId: string | null;
  aiDecision: 'TAKE' | 'SKIP' | 'NONE';
  confidence: number | null;
  reasons: string[];
  fair: FairLike | null;
  /** The old no-stop rule's verdict (kept for comparison only). */
  oldCorrect: boolean | null;
  exitTag: string | null;
  /** The no-stop paper trade's own gross ₹. */
  paperPnl: number | null;
  promptVersion: string | null;
}

export function asFair(v: unknown): FairLike | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const f = v as Record<string, unknown>;
  if (f.verdict !== 'RIGHT' && f.verdict !== 'WRONG' && f.verdict !== 'UNSCORABLE') return null;
  return f as unknown as FairLike;
}

export function scoreSignalJudge(r: SignalJudgeRow): VerificationDraft {
  const f = r.fair;
  const kind = f?.skipKind ? ` (${f.skipKind})` : '';
  const conf = r.confidence !== null ? ` ${r.confidence}%` : '';
  const base = {
    sessionDate: r.sessionDate,
    kind: 'SIGNAL_JUDGE' as const,
    refId: r.decisionId,
    subject: r.aiDecision,
    symbol: r.symbol,
    predicted: `${r.aiDecision}${conf}${kind}: ${r.reasons[0] ?? 'no reason'}`.slice(0, 400),
  };
  const details = {
    skipKind: f?.skipKind ?? null,
    reasons: r.reasons.slice(0, 5),
    channelId: r.channelId,
    capStop: f?.capStop ?? null,
    cap: f?.cap ?? null,
    capOutcome: f?.capOutcome ?? null,
    signalStop: f?.signalStop ?? null,
    signalStopOutcome: f?.signalStopOutcome ?? null,
    pathMethod: f?.method ?? null,
    oldNoStopCorrect: r.oldCorrect,
    paperExitTag: r.exitTag,
    paperPnl: r.paperPnl,
    judgePromptVersion: r.promptVersion,
  };
  if (r.aiDecision === 'NONE') return { ...base, actual: 'no judge verdict', correct: null, score: null, details };
  if (!f) return { ...base, actual: 'no fair check stored (closed before the fair scoring shipped)', correct: null, score: null, details };
  if (f.verdict === 'UNSCORABLE') return { ...base, actual: `fair check UNSCORABLE: ${f.capOutcome.reason ?? 'no price path'}`, correct: null, score: null, details };
  const o = f.capOutcome;
  const money = fin(o.pnl1Lot) ? ` ${inr(o.pnl1Lot)}` : '';
  return {
    ...base,
    actual: `cap-sized stop ${f.capStop ?? '—'} → ${o.result}${o.price !== null ? ` @ ${o.price}` : ''}${money} (1 lot, ${f.method})`.slice(0, 400),
    correct: f.verdict === 'RIGHT',
    // ₹ the cap-sized trade made / lost for 1 lot: a WRONG SKIP's score is the money left on the table.
    score: fin(o.pnl1Lot) ? r2(o.pnl1Lot) : null,
    details,
  };
}

// ─── PAPER_EXIT ──────────────────────────────────────────────────────────────

export interface PaperExitRow {
  tradeId: string;
  sessionDate: string;
  symbol: string;
  underlying: string | null;
  /** AI_EXIT | AI_TRIGGER | MOVED_STOP */
  exitRule: string;
  exitAt: Date;
  want: Want;
  entryPrice: number | null;
  exitPrice: number | null;
  qty: number;
  /** The exit's reason text (the AI's, or the trail's). */
  reason: string | null;
  /** The underlying's noise unit N and its path after the exit — from the exit noise read when there is one, else candles_1m. */
  n: number | null;
  nSource: string;
  underlyingAtExit: number | null;
  after15m: number | null;
  after30m: number | null;
  maxFavour30m: number | null;
  maxAgainst30m: number | null;
  /** The exit noise read's verdict at the exit (NOISE / REAL / MIXED / NO_DATA), null = no read taken. */
  noiseVerdict: string | null;
  noiseSummary: string | null;
  /** The paper watch's HELD follow (paper_exit_shadows rule HELD): what holding on the trade's own rules made. */
  held: { rulePnl: number | null; heldPnl: number | null; saved: number | null } | null;
}

/** The underlying's N (1-min ATR14 over the bars before the exit) and its 30 min after the exit, from 1-min bars. */
export function recoveryFromBars(bars: readonly MinuteBar[], exitAt: Date, want: Want): Pick<PaperExitRow, 'n' | 'underlyingAtExit' | 'after15m' | 'after30m' | 'maxFavour30m' | 'maxAgainst30m'> {
  const t = exitAt.getTime();
  const exitMin = Math.floor(t / 60_000) * 60_000;
  const sorted = [...bars].filter((b) => [b.high, b.low, b.close].every(fin) && b.low > 0).sort((a, b) => a.ts - b.ts);
  const before = sorted.filter((b) => b.ts <= exitMin);
  const at = before.length ? before[before.length - 1] : null;
  const u = at && exitMin - at.ts <= 5 * 60_000 ? at.close : null;
  const nr = noiseFromBars(before.filter((b) => b.ts >= exitMin - 120 * 60_000));
  const after = sorted.filter((b) => b.ts > exitMin && b.ts <= exitMin + 30 * 60_000);
  const closeAt = (m: number) => {
    const c = after.filter((b) => b.ts <= exitMin + m * 60_000);
    return c.length && exitMin + m * 60_000 - c[c.length - 1].ts <= 5 * 60_000 ? c[c.length - 1].close : null;
  };
  const bull = want === 'BULLISH';
  // Excursions need the window covered: at least 20 of its 30 bars.
  const covered = after.length >= 20 && u !== null;
  return {
    n: nr ? r2(nr.n) : null,
    underlyingAtExit: u,
    after15m: closeAt(15),
    after30m: closeAt(30),
    maxFavour30m: covered ? r2(Math.max(0, ...after.map((b) => (bull ? b.high - (u as number) : (u as number) - b.low)))) : null,
    maxAgainst30m: covered ? r2(Math.max(0, ...after.map((b) => (bull ? (u as number) - b.low : b.high - (u as number))))) : null,
  };
}

export function scorePaperExit(r: PaperExitRow): VerificationDraft {
  const s = scoreNoiseRead({ verdict: 'NOISE', want: r.want, underlyingAtExit: r.underlyingAtExit, n: r.n, after15m: r.after15m, after30m: r.after30m, maxFavour30m: r.maxFavour30m, maxAgainst30m: r.maxAgainst30m });
  const base = {
    sessionDate: r.sessionDate,
    kind: 'PAPER_EXIT' as const,
    refId: r.tradeId,
    subject: r.exitRule,
    symbol: r.symbol,
    predicted: `${r.exitRule} at ${r.exitPrice ?? '?'}: ${r.reason ?? 'no reason recorded'}`.slice(0, 400),
  };
  const details = {
    underlying: r.underlying,
    want: r.want,
    entryPrice: r.entryPrice,
    exitPrice: r.exitPrice,
    qty: r.qty,
    n: r.n,
    nSource: r.nSource,
    underlyingAtExit: r.underlyingAtExit,
    after15m: r.after15m,
    after30m: r.after30m,
    favourN: s.favourN,
    againstN: s.againstN,
    noiseReadVerdict: r.noiseVerdict,
    noiseReadSaidNoise: r.noiseVerdict === null ? null : r.noiseVerdict === 'NOISE',
    noiseReadSummary: r.noiseSummary,
    held: r.held,
    rule: `premature when the underlying recovered ≥ ${NOISE_SCORE.minMoveN} N in the trade's favour within 30 min`,
  };
  if (s.favourN === null) return { ...base, actual: 'no underlying path / noise unit after the exit', correct: null, score: null, details };
  const premature = s.favourN >= NOISE_SCORE.minMoveN;
  const heldTxt = r.held && fin(r.held.saved) ? `; holding on its own rules ${inr(r.held.saved)} vs the exit` : '';
  return {
    ...base,
    actual: `${premature ? 'premature exit' : 'exit held up'}: underlying ${s.favourN} N in favour / ${s.againstN} N against within 30 min${r.noiseVerdict ? ` (noise read said ${r.noiseVerdict})` : ''}${heldTxt}`.slice(0, 400),
    correct: !premature,
    // ₹ when the HELD follow knows what holding made (> 0 = the exit cost that much), else the recovery in N.
    score: r.held && fin(r.held.saved) ? r2(r.held.saved) : s.favourN,
    details,
  };
}

// ─── ENGINE_ENTRY ────────────────────────────────────────────────────────────

export interface EngineEntryRow {
  id: string;
  sessionDate: string;
  symbol: string | null;
  underlying: string | null;
  side: string | null;
  quantity: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  exitReasonTag: string | null;
  reasons: string[];
}

export function scoreEngineEntry(r: EngineEntryRow): VerificationDraft {
  const priced = fin(r.entryPrice) && fin(r.exitPrice) && fin(r.quantity) && (r.entryPrice as number) > 0 && (r.exitPrice as number) > 0;
  const gross = priced ? r2((String(r.side).toUpperCase() === 'SELL' ? -1 : 1) * ((r.exitPrice as number) - (r.entryPrice as number)) * (r.quantity as number)) : null;
  return {
    sessionDate: r.sessionDate,
    kind: 'ENGINE_ENTRY',
    refId: r.id,
    subject: r.side,
    symbol: r.symbol,
    predicted: `ENTER ${r.side ?? '?'} ${r.symbol ?? r.underlying ?? ''} at ${r.entryPrice ?? '?'}${r.reasons[0] ? `: ${r.reasons[0]}` : ''}`.slice(0, 400),
    actual: gross === null ? 'no exit price' : `${r.exitReasonTag ?? 'closed'} at ${r.exitPrice} → gross ${inr(gross)}`,
    correct: gross === null || gross === 0 ? null : gross > 0,
    score: gross,
    details: { underlying: r.underlying, entryPrice: r.entryPrice, exitPrice: r.exitPrice, quantity: r.quantity, exitReasonTag: r.exitReasonTag, grossPnl: gross, reasons: r.reasons.slice(0, 5) },
  };
}

/** BUY CE / FUT / cash → BULLISH; BUY PE → BEARISH; a SELL flips it. */
export function wantOf(side: string, symbol: string): Want {
  const pe = /\dPE$/.test(String(symbol).toUpperCase());
  const buy = String(side).toUpperCase() !== 'SELL';
  return buy !== pe ? 'BULLISH' : 'BEARISH';
}
