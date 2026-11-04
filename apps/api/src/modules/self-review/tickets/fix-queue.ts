/**
 * The dev fix queue (spec goal 6 CODE_BUG / S5): OPEN tickets first, then the costliest, then the most recent.
 * `GET /api/self-review/fix-queue?format=md` renders it; scripts/ops/pull-fix-queue.sh writes the same shape from
 * a read-only psql query. Pure.
 */

export const FIX_TICKET_STATUSES = ['OPEN', 'DONE', 'WONTFIX'] as const;
export type FixTicketStatus = (typeof FIX_TICKET_STATUSES)[number];

/** A `fix_tickets` row. */
export interface FixTicketRecord {
  id: string;
  key: string;
  cause: string;
  title: string;
  evidence: unknown;
  proposedChange: string;
  files: string[];
  testDescription: string;
  status: string;
  occurrences: number;
  costRupees: number;
  firstSeen: Date;
  lastSeen: Date;
}

const STATUS_RANK: Record<string, number> = { OPEN: 0, DONE: 1, WONTFIX: 2 };

export function sortQueue<T extends Pick<FixTicketRecord, 'status' | 'costRupees' | 'lastSeen'>>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3) ||
      b.costRupees - a.costRupees ||
      new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime(),
  );
}

const ymd = (d: Date) => new Date(d).toISOString().slice(0, 10);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function renderFixQueueMd(rows: readonly FixTicketRecord[], generatedAt: Date = new Date()): string {
  const sorted = sortQueue(rows);
  const open = sorted.filter((r) => r.status === 'OPEN');
  const lines = [
    '# Self-review fix queue',
    '',
    `Generated ${generatedAt.toISOString()} — ${open.length} OPEN of ${sorted.length}. Fix OPEN tickets first; each is a CODE_BUG or DATA cause the nightly self-review found on repeated wrong decisions.`,
    '',
  ];
  if (sorted.length === 0) lines.push('No tickets.');
  for (const r of sorted) {
    const ev = r.evidence && typeof r.evidence === 'object' ? (r.evidence as { cause?: unknown; sessions?: unknown; refIds?: unknown }) : {};
    const sessions = Array.isArray(ev.sessions) ? ev.sessions.filter((s) => typeof s === 'string') : [];
    const refs = Array.isArray(ev.refIds) ? ev.refIds.filter((s) => typeof s === 'string') : [];
    lines.push(
      `## [${r.status}] ${oneLine(r.title)}`,
      '',
      `- key: \`${r.key}\` · cause: ${r.cause} · seen ${r.occurrences}× · cost ₹${Math.round(r.costRupees).toLocaleString('en-IN')} · ${ymd(r.firstSeen)} → ${ymd(r.lastSeen)}`,
      ...(typeof ev.cause === 'string' && ev.cause ? [`- why: ${oneLine(ev.cause)}`] : []),
      `- change: ${oneLine(r.proposedChange)}`,
      ...(r.files.length ? [`- files: ${r.files.map((f) => `\`${f}\``).join(', ')}`] : []),
      ...(r.testDescription ? [`- test: ${oneLine(r.testDescription)}`] : []),
      ...(sessions.length ? [`- sessions: ${sessions.slice(-10).join(', ')}`] : []),
      ...(refs.length ? [`- evidence: ${refs.slice(-10).join(', ')}`] : []),
      '',
    );
  }
  return lines.join('\n');
}
