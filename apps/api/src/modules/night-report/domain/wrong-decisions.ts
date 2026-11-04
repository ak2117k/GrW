/**
 * The night report's "Wrong decisions" section (2026-11-04, self-review wrong-decision loop G1c). Built from the
 * latest self-review run's `summary.decisions` and the auto-applied setting changes. Pure.
 */

export interface WrongDecisionLine {
  /** One plain sentence: decided → better (₹) → cause → action. */
  text: string;
  decided: string;
  better: string;
  cause: string | null;
  causeType: string | null;
  action: string;
  deltaRupees: number | null;
  symbol: string | null;
  mode: string | null;
}

export interface WrongDecisionsView {
  session: string | null;
  graded: number;
  wrong: number;
  unscorable: number;
  /** Always present: "graded N, wrong W, unscorable U" (+ " — <reason>" when there is one). */
  line: string;
  reason: string | null;
  items: WrongDecisionLine[];
  /** "applied exit.floorTrailN 2 → 2.25 (2026-11-04)" / "rolled back …", newest first. */
  changes: string[];
  tickets: Array<{ key: string; title: string; occurrences: number; status: string }>;
}

interface ChangeLike {
  target?: string;
  kind?: string;
  from?: unknown;
  to?: unknown;
  session?: string;
  reason?: string;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const val = (v: unknown): string => (v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

/** The session the latest self-review graded (for the changes read); null when it has no decisions block. */
export function decisionsSessionOf(latest: unknown): string | null {
  const d = obj(obj(obj(latest)?.summary)?.decisions);
  return d ? str(d.session) : null;
}

export function changeText(c: ChangeLike): string {
  const verb = (c.kind ?? '').toUpperCase() === 'ROLLBACK' ? 'rolled back' : 'applied';
  return `${verb} ${c.target ?? '?'} ${val(c.from)} → ${val(c.to)}${c.session ? ` (${c.session})` : ''}${c.reason ? ` — ${c.reason}` : ''}`;
}

/**
 * The section, or null when the latest run carries no decisions block (the loop is off, or the run predates it).
 * An item whose action is a proposal for a target that auto-apply then applied reads `applied <target> a→b`.
 */
export function wrongDecisionsView(latest: unknown, changes: readonly ChangeLike[] = []): WrongDecisionsView | null {
  const d = obj(obj(obj(latest)?.summary)?.decisions);
  if (!d) return null;
  const graded = num(d.graded);
  const wrong = num(d.wrong);
  const unscorable = num(d.unscorable);
  const reason = str(d.reason);
  const applied = new Map<string, ChangeLike>();
  for (const c of changes) if (c.target && (c.kind ?? 'APPLY').toUpperCase() === 'APPLY' && !applied.has(c.target)) applied.set(c.target, c);
  const items: WrongDecisionLine[] = (Array.isArray(d.items) ? d.items : []).map((raw) => {
    const i = obj(raw) ?? {};
    let action = str(i.action) ?? 'watching';
    const m = /^proposal (\S+)$/.exec(action);
    const a = m ? applied.get(m[1]) : undefined;
    if (a) action = `applied ${a.target} ${val(a.from)}→${val(a.to)}`;
    const decided = str(i.decided) ?? '?';
    const better = str(i.better) ?? '?';
    const cause = str(i.cause);
    const causeType = str(i.causeType);
    return {
      text: `Decided ${decided}; better: ${better}. Cause: ${causeType ? `${causeType}${cause ? ` — ${cause}` : ''}` : cause ?? 'not diagnosed'}. Action: ${action}.`,
      decided, better, cause, causeType, action,
      deltaRupees: typeof i.deltaRupees === 'number' ? i.deltaRupees : null,
      symbol: str(i.symbol),
      mode: str(i.mode),
    };
  });
  const tickets = (Array.isArray(d.tickets) ? d.tickets : [])
    .map(obj)
    .filter((t): t is Record<string, unknown> => !!t && !!str(t.key))
    .map((t) => ({ key: String(t.key), title: str(t.title) ?? '', occurrences: num(t.occurrences), status: str(t.status) ?? 'OPEN' }));
  return {
    session: str(d.session),
    graded, wrong, unscorable,
    line: `graded ${graded}, wrong ${wrong}, unscorable ${unscorable}${reason ? ` — ${reason}` : ''}${graded > 0 && wrong === 0 ? ' — 0 wrong decisions found' : ''}`,
    reason,
    items,
    changes: changes.map(changeText),
    tickets,
  };
}
