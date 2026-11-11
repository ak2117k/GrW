import { cn } from '@/utils/cn';
import { useLatestSelfReview, useSelfReviewRuns } from '@/hooks/useSelfReview';
import type { SelfReviewLatest, SelfReviewRun } from '@/types/selfReview.types';
import { CARD, Empty, MUTED, PRIMARY, SECONDARY, TONE_TEXT } from './SelfReviewViews';
import { dayLabel, findingMeta, istTime, nightStatuses, outcomeOf, outcomeTally, type NightStatus } from './lastNight';

const OUTCOME_TONE: Record<string, string> = {
  LESSON: 'text-violet-400',
  TICKET: 'text-red-400',
  ONE_OFF: 'text-[var(--color-text-secondary)]',
  NOISE: 'text-[var(--color-text-muted)]',
  UNKNOWN: 'text-[var(--color-text-muted)]',
};

const ASSESSMENTS: Array<{ key: 'engineAssessment' | 'exitNoiseAssessment' | 'signalPaperAssessment'; label: string }> = [
  { key: 'engineAssessment', label: 'Entry engine' },
  { key: 'exitNoiseAssessment', label: 'Exit noise reads' },
  { key: 'signalPaperAssessment', label: 'Signal paper trades' },
];

/** The default view: what the newest reviewed session's review found, what each finding became, and recent nights. */
export function LastNightPanel({ latest, nights }: { latest: SelfReviewLatest | null; nights: NightStatus[] }) {
  const run = latest?.run ?? null;
  const misses = Array.isArray(latest?.misses) ? latest.misses : [];
  return (
    <div className="space-y-6">
      <section className="space-y-2" aria-labelledby="last-night-h">
        <h2 id="last-night-h" className={cn('text-sm font-semibold', PRIMARY)}>
          {run ? `Last reviewed session · ${dayLabel(run.sessionDate)}` : 'Last reviewed session'}
        </h2>
        {!run ? (
          <Empty text="No review has run yet." />
        ) : (
          <p className={cn('text-xs', MUTED)} data-testid="run-line">
            Run {run.status}
            {run.startedAt ? ` · started ${istTime(run.startedAt)}` : ''}
            {run.finishedAt ? ` · finished ${istTime(run.finishedAt)}` : ''}
            {run.error ? ` · ${run.error}` : ''}
          </p>
        )}
        {(latest?.proposalsPending ?? 0) > 0 && (
          <p className={cn('text-sm', SECONDARY)} data-testid="pending-line">
            {latest?.proposalsPending} setting proposal{latest?.proposalsPending === 1 ? '' : 's'} waiting for you on the Proposals tab.
          </p>
        )}
      </section>

      {run && (
        <section className="space-y-3" aria-labelledby="findings-h">
          <h3 id="findings-h" className={cn('text-sm font-semibold', PRIMARY)}>
            What it found
          </h3>
          {misses.length === 0 ? (
            <Empty text="The review found nothing to flag in this session." />
          ) : (
            <>
              <p className={cn('text-sm', SECONDARY)} data-testid="outcome-tally">
                {outcomeTally(misses)}
              </p>
              <ul className="space-y-2">
                {misses.map((m, i) => {
                  const o = outcomeOf(m);
                  return (
                    <li key={`${m.refIds?.[0] ?? 'm'}-${i}`} className={cn(CARD, 'space-y-1 text-sm')}>
                      <p className={cn('break-words text-xs', MUTED)}>{findingMeta(m)}</p>
                      <p className={PRIMARY}>{m.cause}</p>
                      <p className={cn('font-medium', OUTCOME_TONE[o.type])} data-testid="finding-outcome">
                        → {o.label}
                      </p>
                      {m.lessonText && o.type === 'LESSON' ? <p className={cn('text-xs', SECONDARY)}>{m.lessonText}</p> : null}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      )}

      {run && (
        <section className="space-y-2" aria-labelledby="assess-h">
          <h3 id="assess-h" className={cn('text-sm font-semibold', PRIMARY)}>
            Assessments
          </h3>
          {ASSESSMENTS.map((a) => {
            const text = latest?.[a.key] ?? run[a.key] ?? null;
            return (
              <div key={a.key} className={cn(CARD, 'space-y-1 text-sm')}>
                <p className={cn('text-xs font-medium', MUTED)}>{a.label}</p>
                <p className={text ? SECONDARY : MUTED}>{text || 'No assessment this night.'}</p>
              </div>
            );
          })}
        </section>
      )}

      <section className="space-y-2" aria-labelledby="nights-h">
        <h3 id="nights-h" className={cn('text-sm font-semibold', PRIMARY)}>
          Recent weeknights
        </h3>
        <p className={cn('text-xs', MUTED)}>The review runs at 00:30 IST for the session before. A weeknight without a run is listed, not skipped.</p>
        <ul className="space-y-1" data-testid="nights">
          {nights.map((n) => (
            <li key={n.session} className={cn('text-sm', TONE_TEXT[n.tone])}>
              {n.text}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export default function LastNightTab() {
  const latest = useLatestSelfReview();
  const runs = useSelfReviewRuns(40);
  if (latest.isLoading) return <div className="h-32 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" aria-busy="true" />;
  if (latest.isError) return <Empty text="Could not load the latest review run." />;
  const nights = nightStatuses((runs.data ?? []) as SelfReviewRun[], new Date());
  return <LastNightPanel latest={latest.data ?? null} nights={runs.isError ? [] : nights} />;
}
