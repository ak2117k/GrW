import { useQuery } from '@tanstack/react-query';
import { cn } from '@/utils/cn';
import api from '@/services/api';
import { CARD, Empty, MUTED, PRIMARY, SECONDARY } from './SelfReviewViews';

/**
 * "Wrong decisions" + "Fix queue" (2026-11-04, self-review wrong-decision loop): what the nightly run graded,
 * each wrong decision in plain words (decided → better in ₹ → cause → action), and the fix tickets it queued
 * for the developer. Read-only; the data is the latest run's `summary.decisions` and GET /self-review/fix-queue.
 */

export interface WrongDecisionItem {
  refId: string;
  sessionDate?: string;
  decisionType?: string;
  detector?: string | null;
  symbol?: string | null;
  mode?: string;
  decided: string;
  better: string;
  deltaRupees?: number | null;
  causeType?: string | null;
  cause?: string | null;
  action: string;
}

export interface DecisionsBlock {
  session: string;
  graded: number;
  wrong: number;
  unscorable: number;
  reason?: string;
  items: WrongDecisionItem[];
  tickets?: Array<{ key: string; title: string; occurrences: number; status: string }>;
}

export interface FixTicket {
  id: string;
  key: string;
  cause: string;
  title: string;
  proposedChange: string;
  files: string[];
  testDescription: string;
  status: string;
  occurrences: number;
  costRupees: number;
  firstSeen: string;
  lastSeen: string;
}

const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** The always-present count line ("0 wrong decisions found" is said out loud, never left blank). */
export function gradedLine(d: DecisionsBlock): string {
  const base = `Graded ${d.graded}, wrong ${d.wrong}, unscorable ${d.unscorable}`;
  if (d.reason) return `${base} — ${d.reason}`;
  return d.graded > 0 && d.wrong === 0 ? `${base} — 0 wrong decisions found` : base;
}

const CAUSE_TONE: Record<string, string> = {
  CODE_BUG: 'text-red-400',
  DATA: 'text-amber-400',
  SETTING: 'text-sky-400',
  REASONING: 'text-violet-400',
  NOISE: 'text-[var(--color-text-muted)]',
};

export function WrongDecisionsPanel({ decisions, tickets }: { decisions: DecisionsBlock | null; tickets: FixTicket[] }) {
  return (
    <div className="space-y-6">
      <section className="space-y-3" aria-labelledby="wrong-decisions-h">
        <h2 id="wrong-decisions-h" className={cn('text-sm font-semibold', PRIMARY)}>
          Wrong decisions{decisions ? ` · ${decisions.session}` : ''}
        </h2>
        {!decisions ? (
          <Empty text="The latest review run has no decision grading (the loop is off or the run predates it)." />
        ) : (
          <>
            <p className={cn('text-sm', SECONDARY)} data-testid="graded-line">
              {gradedLine(decisions)}
            </p>
            {decisions.items.length === 0 ? null : (
              <ul className="space-y-2">
                {decisions.items.map((i) => (
                  <li key={i.refId} className={cn(CARD, 'space-y-1 text-sm')}>
                    <p className={PRIMARY}>
                      <span className={MUTED}>Decided </span>
                      {i.decided}
                    </p>
                    <p className={SECONDARY}>
                      <span className={MUTED}>Better: </span>
                      {i.better}
                    </p>
                    <p className={SECONDARY}>
                      <span className={MUTED}>Cause: </span>
                      {i.causeType ? <span className={cn('font-medium', CAUSE_TONE[i.causeType] ?? PRIMARY)}>{i.causeType}</span> : 'not diagnosed'}
                      {i.cause ? ` — ${i.cause}` : ''}
                    </p>
                    <p className={SECONDARY}>
                      <span className={MUTED}>Action: </span>
                      {i.action}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="fix-queue-h">
        <h2 id="fix-queue-h" className={cn('text-sm font-semibold', PRIMARY)}>
          Fix queue
        </h2>
        <p className={cn('text-xs', MUTED)}>
          Code bugs and data gaps the review found on repeated wrong decisions. Nothing is changed in code automatically; the developer fixes OPEN tickets first.
        </p>
        {tickets.length === 0 ? (
          <Empty text="No fix tickets." />
        ) : (
          <ul className="space-y-2">
            {tickets.map((t) => (
              <li key={t.id} className={cn(CARD, 'space-y-1 text-sm')}>
                <p className={cn('font-medium', PRIMARY)}>
                  <span className={cn('mr-2 text-xs', t.status === 'OPEN' ? 'text-red-400' : MUTED)}>{t.status}</span>
                  {t.title}
                </p>
                <p className={cn('text-xs', MUTED)}>
                  {t.cause} · seen {t.occurrences}× · cost {rupees(t.costRupees)} · last {t.lastSeen.slice(0, 10)}
                </p>
                <p className={SECONDARY}>{t.proposedChange}</p>
                {t.files.length > 0 && <p className={cn('break-all text-xs', MUTED)}>{t.files.join(', ')}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function asDecisions(summary: unknown): DecisionsBlock | null {
  const d = summary && typeof summary === 'object' ? (summary as { decisions?: unknown }).decisions : undefined;
  if (!d || typeof d !== 'object') return null;
  const o = d as Partial<DecisionsBlock>;
  return {
    session: String(o.session ?? ''),
    graded: Number(o.graded ?? 0),
    wrong: Number(o.wrong ?? 0),
    unscorable: Number(o.unscorable ?? 0),
    ...(o.reason ? { reason: o.reason } : {}),
    items: Array.isArray(o.items) ? o.items : [],
    tickets: Array.isArray(o.tickets) ? o.tickets : [],
  };
}

export default function WrongDecisionsTab() {
  const latest = useQuery({
    queryKey: ['self-review', 'latest'],
    queryFn: async () => (await api.get<{ summary: unknown }>('/self-review/latest')).data,
    staleTime: 60_000,
  });
  const queue = useQuery({
    queryKey: ['self-review', 'fix-queue'],
    queryFn: async () => {
      const { data } = await api.get<FixTicket[]>('/self-review/fix-queue');
      return Array.isArray(data) ? data : [];
    },
    staleTime: 60_000,
  });
  if (latest.isLoading || queue.isLoading) return <div className="h-32 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" aria-busy="true" />;
  if (latest.isError) return <Empty text="Could not load the latest review run." />;
  // The review's findings (what each became) moved to the Last night tab (2026-11-11).
  return <WrongDecisionsPanel decisions={asDecisions(latest.data?.summary)} tickets={queue.data ?? []} />;
}
