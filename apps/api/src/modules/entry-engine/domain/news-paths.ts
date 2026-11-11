import type { Direction, NewsReading } from './entry-decision';
import { ENGINE_WINDOW, istMinutes } from './engine-inputs';
import type { NewsTheme } from './news-theme';

/**
 * The extra ways the engine's news component can be MATERIAL (owner 2026-11-02), on top of the
 * original per-story rule, which is kept and wins when it fires:
 *
 *   STORY    — the original rule (newsReading): a MED/HIGH story or material cluster in 60 min.
 *   THEME    — the news theme score (news-theme.ts) over the last 3 h is material.
 *   PRE_OPEN — the day's pre-open outlook (pre-open-outlook module, 08:30 IST) has a bias with
 *              confidence ≥ {@link PRE_OPEN_BIAS}.minConfidence, and the evaluation is in the
 *              opening window (the engine's first run 09:20 IST + windowMin).
 *
 * A path only applies when the 60-min read does not lean the OTHER way (no override of a contrary
 * read). Making news material never trades by itself: entryDecision still needs trend AND OI to
 * agree (all-agree rule), and the engine is observe / paper only. Pure.
 */
export const PRE_OPEN_BIAS = Object.freeze({
  /** Outlook confidence needed for the bias to stand in for the news component. */
  minConfidence: 0.6,
  /**
   * Minutes after the engine's first run (09:20 IST) the bias stays usable: 09:20 / 09:35 / 09:50 /
   * 10:05. The brief asked for "the first run"; MCX bars often start late (prod 2 Nov: none before
   * 09:40), so the trend cannot be read at 09:20 — 45 min keeps it to the opening window. 0 = 09:20 only.
   */
  windowMin: 45,
  /**
   * NSE / BSE underlyings (NFO / BFO options): the bias stops counting after this IST minute — 09:30, 15 min after
   * the 09:15 open (2026-11-11). The NSE outlook is a GIFT-NIFTY GAP call: once the market has opened the gap is
   * priced in. Prod 11-11: BANKNIFTY's news at 09:50 was "material via PRE_OPEN" off the 08:30 gap read (+1.08%),
   * and the engine bought the top of the opening run. MCX keeps {@link windowMin}: its outlook is the same gap model
   * (WTI since the MCX close), but MCX bars often start late (above), so the opening window was kept as designed.
   */
  nseCutoffMin: 9 * 60 + 30,
});

/** MCX underlyings (signal-trader contract-resolver's list). */
const MCX_NAMES: ReadonlySet<string> = new Set(['CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI', 'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD', 'NICKEL']);
/** Index / stock underlyings whose options trade on NFO / BFO (everything but MCX). */
export const isNseBseUnderlying = (u: string) => !MCX_NAMES.has(String(u ?? '').trim().toUpperCase());
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** What the engine reads of a stored pre-open outlook (pre_open_outlooks). */
export interface PreOpenBiasInput {
  underlying: string;
  /** IST session date YYYY-MM-DD the outlook is for. */
  sessionDate: string;
  bias: Direction | 'NEUTRAL';
  confidence: number;
  /** When it was computed (ISO). */
  at: string;
  summary: string;
}

const istYmd = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);

/** Is the pre-open bias usable at `at`? Returns the reason either way. */
export function preOpenUsable(p: PreOpenBiasInput | null, at: Date): { ok: boolean; why: string } {
  if (!p) return { ok: false, why: 'no pre-open outlook today' };
  if (p.sessionDate !== istYmd(at)) return { ok: false, why: `outlook is for ${p.sessionDate}, not ${istYmd(at)}` };
  if (p.bias === 'NEUTRAL') return { ok: false, why: 'pre-open bias NEUTRAL' };
  if (!(p.confidence >= PRE_OPEN_BIAS.minConfidence)) return { ok: false, why: `pre-open ${p.bias} confidence ${p.confidence} < ${PRE_OPEN_BIAS.minConfidence}` };
  const m = istMinutes(at);
  if (isNseBseUnderlying(p.underlying) && m > PRE_OPEN_BIAS.nseCutoffMin) {
    return { ok: false, why: `pre-open ${p.bias} ${p.confidence} expired at ${hhmm(PRE_OPEN_BIAS.nseCutoffMin)} IST (the pre-open gap is priced in after the NSE / BSE open)` };
  }
  if (m < ENGINE_WINDOW.fromMin || m > ENGINE_WINDOW.fromMin + PRE_OPEN_BIAS.windowMin) return { ok: false, why: `pre-open ${p.bias} ${p.confidence} outside the opening window` };
  return { ok: true, why: `pre-open ${p.bias} confidence ${p.confidence}` };
}

/** The news component with the THEME and PRE_OPEN paths applied (see the file comment). */
export function withNewsPaths(news: NewsReading, theme: NewsTheme | null, preOpen: PreOpenBiasInput | null, at: Date): NewsReading {
  const themeRec = theme ? { side: theme.side, material: theme.material, net: theme.net, stories: theme.stories, sources: theme.sources, sideShare: theme.sideShare, summary: theme.summary } : null;
  const pre = preOpenUsable(preOpen, at);
  const preRec = preOpen ? { bias: preOpen.bias, confidence: preOpen.confidence, at: preOpen.at, usable: pre.ok, why: pre.why } : null;
  const base: NewsReading = { ...news, materialPath: news.material ? 'STORY' : null, theme: themeRec, preOpen: preRec };
  if (news.material) return base;
  const compatible = (side: Direction) => news.lean === side || news.lean === 'NEUTRAL' || news.lean === 'NO_DATA';
  if (theme && theme.material && theme.side && compatible(theme.side)) {
    return { ...base, lean: theme.side, material: true, materialPath: 'THEME', summary: `${theme.summary}; 60-min read: ${news.summary}` };
  }
  if (pre.ok && preOpen && preOpen.bias !== 'NEUTRAL' && compatible(preOpen.bias)) {
    return { ...base, lean: preOpen.bias, material: true, materialPath: 'PRE_OPEN', summary: `${pre.why} — ${preOpen.summary.slice(0, 160)}; 60-min read: ${news.summary}` };
  }
  return base;
}
