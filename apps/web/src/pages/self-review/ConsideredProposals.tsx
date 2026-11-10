import { cn } from '@/utils/cn';
import { CARD, Empty, MUTED, PRIMARY, SECONDARY } from './SelfReviewViews';

export interface Considered {
  session: string;
  items: Array<{ target: string; reason: string }>;
}

type RunLike = { sessionDate?: string | null; summary?: unknown };

/** The newest run that recorded the settings it checked (runs come newest first; the 02:30 run checks none). */
export function consideredFrom(runs: readonly RunLike[] | null | undefined): Considered | null {
  for (const r of runs ?? []) {
    const s = r.summary as { session?: string; proposalsConsidered?: unknown } | null | undefined;
    if (s && Array.isArray(s.proposalsConsidered)) {
      const items = s.proposalsConsidered
        .filter((x): x is { target: string; reason: string } => !!x && typeof (x as { target?: unknown }).target === 'string')
        .map((x) => ({ target: x.target, reason: String(x.reason ?? '') }));
      return { session: String(s.session ?? r.sessionDate ?? ''), items };
    }
  }
  return null;
}

/** What the nightly review checked and why it raised no proposal (2026-11-10: this was only in the server log). */
export function ConsideredProposals({ data }: { data: Considered | null }) {
  if (!data) return <Empty text="What the review checks and why it does not propose shows here from the next nightly review." />;
  return (
    <section className="space-y-2" aria-labelledby="considered-h">
      <h2 id="considered-h" className={cn('text-sm font-semibold', PRIMARY)}>
        Checked in the {data.session} review, not proposed
      </h2>
      {data.items.length === 0 ? (
        <p className={cn('text-sm', SECONDARY)}>Nothing came close: no setting had evidence to check.</p>
      ) : (
        <ul className="space-y-2">
          {data.items.map((i) => (
            <li key={i.target} className={cn(CARD, 'space-y-1 text-sm')}>
              <p className={PRIMARY}>{i.target}</p>
              <p className={cn('text-xs', MUTED)}>{i.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
