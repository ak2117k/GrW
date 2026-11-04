/**
 * The wrong-decision loop's pure steps (docs/superpowers/plans/2026-11-04-self-review-wrong-decision-loop.md, G1):
 * decision-ledger rows → diagnosis misses, the shared miss cap, the per-item "what was done", the fix-ticket drafts
 * and the nothing-graded alert rule. No I/O.
 */
import type { DiagnosisMiss, DiagnosisOutput } from '../self-review.ports';
import { actionable, groupCostRupees, groupStats, type MissFacts } from '../diagnose/actionable';
import { FIX_CAUSES, type FixCause } from '../diagnose/types';
import type { DecisionGradeRowLike, GradeSessionResult } from './decision-loop.ports';

/** WRONG / DETECTOR rows of this many sessions (S included) go to the diagnosis. */
export const DECISION_LOOKBACK_SESSIONS = 10;
/** Of the diagnosis' 15 misses, decisions get at least this many slots when they have them (the rest fill up). */
export const DECISION_MISS_SLOTS = 8;
/** Items shown in the report / page. */
export const MAX_WRONG_ITEMS = 25;

export const decisionRefId = (id: string) => `dg:${id}`;

const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** A ledger row as a diagnosis miss: kind DECISION:<type>, score = ₹ delta per lot net (null for most detectors). */
export function decisionMiss(r: DecisionGradeRowLike): DiagnosisMiss {
  const delta = typeof r.deltaRupees === 'number' && Number.isFinite(r.deltaRupees) ? r.deltaRupees : null;
  return {
    sessionDate: r.sessionDate,
    kind: `DECISION:${r.decisionType}`,
    refId: decisionRefId(r.id),
    subject: r.detector ?? r.horizon ?? null,
    symbol: r.symbol,
    predicted: `${r.decisionType}${r.detector ? ` ${r.detector}` : ''}: ${r.chosen}`,
    actual: delta !== null ? `${r.alternative} better by ${rupees(delta)}/lot net (${r.horizon})` : `${r.alternative} (${r.reason})`,
    correct: false,
    score: delta,
    details: {
      decisionType: r.decisionType, detector: r.detector, mode: r.mode, horizon: r.horizon, underlying: r.underlying ?? null,
      pnlChosen: r.pnlChosen, pnlAlternative: r.pnlAlternative, deltaRupees: delta, reason: r.reason, facts: r.facts ?? null,
      decidedAt: r.decidedAt instanceof Date ? r.decidedAt.toISOString() : r.decidedAt ?? null,
    },
  };
}

/** Detectors first (an absence costs more than it shows), then the costliest ₹ delta. */
function rankDecisions(rows: readonly DecisionGradeRowLike[]): DecisionGradeRowLike[] {
  return [...rows].sort((a, b) => (b.detector ? 1 : 0) - (a.detector ? 1 : 0) || Math.abs(b.deltaRupees ?? 0) - Math.abs(a.deltaRupees ?? 0) || b.sessionDate.localeCompare(a.sessionDate));
}

/**
 * The diagnosis' misses, capped at `cap` as before: decisions take up to DECISION_MISS_SLOTS, the older kinds
 * (already ranked by the caller) fill the rest, and spare slots go back to decisions.
 */
export function mergeMisses(legacy: readonly DiagnosisMiss[], decisions: readonly DecisionGradeRowLike[], cap: number): DiagnosisMiss[] {
  const ranked = rankDecisions(decisions).map(decisionMiss);
  const firstDecisions = ranked.slice(0, Math.min(DECISION_MISS_SLOTS, cap));
  const old = legacy.slice(0, cap - firstDecisions.length);
  const more = ranked.slice(firstDecisions.length, firstDecisions.length + (cap - firstDecisions.length - old.length));
  return [...old, ...firstDecisions, ...more];
}

export function missFacts(misses: readonly DiagnosisMiss[]): Map<string, MissFacts> {
  return new Map(misses.map((m) => [m.refId, { sessionDate: m.sessionDate, score: m.score, kind: m.kind }]));
}

const causeOf = (v: unknown): FixCause | null => ((FIX_CAUSES as readonly unknown[]).includes(v) ? (v as FixCause) : null);

/** A group of the diagnosis as G1 reads it back (validated by the diagnosis; read defensively). */
type Group = DiagnosisOutput['misses'][number];

/** What was done about a group: `lesson <key>` / `ticket <title>` / `proposal <target>` / `none (noise)` / `watching`. */
export function actionOf(g: Group | undefined, facts: ReadonlyMap<string, MissFacts>): string {
  if (!g) return 'watching';
  const cause = causeOf(g.causeType);
  if (cause === 'NOISE' || g.category === 'NOISE') return 'none (noise)';
  const acts = actionable(groupStats(g.refIds, facts), cause);
  if (acts && g.ticket && (cause === 'CODE_BUG' || cause === 'DATA')) return `ticket ${g.ticket.title}`;
  if (acts && g.lessonKey) return `lesson ${g.lessonKey}`;
  // A setting moves only through the proposal engine's own evidence gate (S1); G2 applies what passes it.
  if (g.proposalTarget) return `proposal ${g.proposalTarget}`;
  return 'watching';
}

export interface WrongDecisionItem {
  refId: string;
  sessionDate: string;
  decisionType: string;
  detector: string | null;
  symbol: string | null;
  mode: string;
  /** Plain language: what was decided. */
  decided: string;
  /** Plain language: what would have been better, in ₹ (or the detector's finding). */
  better: string;
  deltaRupees: number | null;
  causeType: FixCause | null;
  cause: string | null;
  action: string;
}

/** `summary.decisions` on the run: the night report and the page read it. */
export interface DecisionLoopSummary {
  session: string;
  graded: number;
  wrong: number;
  unscorable: number;
  byType: Record<string, number>;
  /** Why nothing (or not everything) was graded; absent on a normal night. */
  reason?: string;
  /** The session's WRONG + DETECTOR rows, costliest first. */
  items: WrongDecisionItem[];
  /** Fix tickets this run opened or bumped. */
  tickets: Array<{ key: string; title: string; occurrences: number; status: string }>;
}

export function wrongItems(rows: readonly DecisionGradeRowLike[], diagnosis: DiagnosisOutput | null, facts: ReadonlyMap<string, MissFacts>): WrongDecisionItem[] {
  const groupOf = new Map<string, Group>();
  for (const g of diagnosis?.misses ?? []) for (const r of g.refIds ?? []) if (!groupOf.has(r)) groupOf.set(r, g);
  return rankDecisions(rows)
    .slice(0, MAX_WRONG_ITEMS)
    .map((r) => {
      const refId = decisionRefId(r.id);
      const g = groupOf.get(refId);
      const delta = typeof r.deltaRupees === 'number' && Number.isFinite(r.deltaRupees) ? Math.round(r.deltaRupees) : null;
      const who = [r.symbol, r.mode === 'live' ? 'live' : 'paper'].filter(Boolean).join(', ');
      return {
        refId,
        sessionDate: r.sessionDate,
        decisionType: r.decisionType,
        detector: r.detector,
        symbol: r.symbol,
        mode: r.mode,
        decided: r.detector ? `${r.detector} (${who}): ${r.reason}` : `${r.decisionType} ${r.chosen} (${who})`,
        better: delta !== null ? `${r.alternative} would have made ${rupees(delta)} more per lot, net (${r.horizon})` : `${r.alternative}${r.detector ? '' : ` (${r.reason})`}`,
        deltaRupees: delta,
        causeType: causeOf(g?.causeType),
        cause: g?.cause ?? null,
        action: actionOf(g, facts),
      };
    });
}

/** A fix ticket to upsert (the repository adds occurrences / lastSeen / cost on a repeat). */
export interface FixTicketDraft {
  key: string;
  cause: 'CODE_BUG' | 'DATA';
  title: string;
  proposedChange: string;
  files: string[];
  testDescription: string;
  /** The misses this sighting explains (refIds); occurrences grow by the ones not seen before. */
  refIds: string[];
  costRupees: number;
  /** ₹ per refId (DECISION:* only), so a repeat adds the cost of the new misses alone. */
  refCosts: Record<string, number>;
  evidence: { cause: string; sessions: string[]; kinds: string[]; symbols: string[] };
  sessionDate: string;
}

const slug = (s: string) => s.toLowerCase().replace(/\.[a-z]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/**
 * The ticket's stable key: cause + component. The component is the first named file (module + file name, which the
 * diagnosis repeats night after night far more reliably than a title), else the title's first six words.
 */
export function ticketKey(cause: 'CODE_BUG' | 'DATA', t: { title: string; files: readonly string[] }): string {
  const f = [...t.files].sort()[0];
  let component = '';
  if (f) {
    const parts = f.split('/').filter(Boolean);
    const modIdx = parts.indexOf('modules');
    const mod = modIdx >= 0 && parts[modIdx + 1] ? parts[modIdx + 1] : parts.length > 1 ? parts[parts.length - 2] : '';
    component = slug([mod, parts[parts.length - 1]].filter(Boolean).join('-'));
  }
  if (!component) component = slug(t.title.split(/\s+/).slice(0, 6).join(' ')) || 'unnamed';
  return `${cause.toLowerCase().replace('_', '-')}:${component}`;
}

/** Tickets for the actionable CODE_BUG / DATA groups that carry one. */
export function ticketDrafts(diagnosis: DiagnosisOutput | null, misses: readonly DiagnosisMiss[], sessionDate: string): FixTicketDraft[] {
  const facts = missFacts(misses);
  const byRef = new Map(misses.map((m) => [m.refId, m]));
  const out = new Map<string, FixTicketDraft>();
  for (const g of diagnosis?.misses ?? []) {
    const cause = causeOf(g.causeType);
    if ((cause !== 'CODE_BUG' && cause !== 'DATA') || !g.ticket || !g.ticket.title) continue;
    if (!actionable(groupStats(g.refIds, facts), cause)) continue;
    const refs = g.refIds.filter((r) => byRef.has(r));
    const ms = refs.map((r) => byRef.get(r) as DiagnosisMiss);
    const key = ticketKey(cause, { title: g.ticket.title, files: g.ticket.files ?? [] });
    const draft: FixTicketDraft = {
      key,
      cause,
      title: g.ticket.title,
      proposedChange: g.ticket.proposedChange,
      files: g.ticket.files ?? [],
      testDescription: g.ticket.testDescription ?? '',
      refIds: refs,
      costRupees: groupCostRupees(refs, facts),
      refCosts: Object.fromEntries(refs.map((r) => [r, groupCostRupees([r], facts)])),
      evidence: {
        cause: g.cause,
        sessions: [...new Set(ms.map((m) => m.sessionDate))].sort(),
        kinds: [...new Set(ms.map((m) => String(m.kind)))].sort(),
        symbols: [...new Set(ms.map((m) => m.symbol).filter((s): s is string => !!s))].sort(),
      },
      sessionDate,
    };
    const prev = out.get(key);
    // Two groups naming the same component in one night are one ticket sighting.
    if (prev) {
      prev.refIds = [...new Set([...prev.refIds, ...draft.refIds])];
      prev.refCosts = { ...prev.refCosts, ...draft.refCosts };
      prev.costRupees = Object.values(prev.refCosts).reduce((s, v) => s + v, 0);
    } else out.set(key, draft);
  }
  return [...out.values()];
}

/**
 * Why nothing was graded, for the report line. `sessionToday` = the run's IST day is itself an NSE session
 * (a weekday that traded); a weekend / holiday run re-reads the last session.
 */
export function nothingGradedReason(g: GradeSessionResult | null, loaded: boolean, sessionToday: boolean): string | undefined {
  if (!loaded) return 'decision grading is not loaded';
  if (g?.error) return `grading failed: ${g.error}`;
  if (g && g.graded > 0) return undefined;
  return sessionToday ? 'no decisions were recorded or none could be graded on a trading day' : 'no NSE session today (weekend / holiday)';
}

/** SELF_REVIEW_NOTHING_GRADED: a trading day whose decisions all went ungraded is itself an alert (spec §3). */
export function shouldAlertNothingGraded(g: GradeSessionResult | null, loaded: boolean, sessionToday: boolean): boolean {
  return sessionToday && (!loaded || !g || !!g.error || g.graded === 0);
}
