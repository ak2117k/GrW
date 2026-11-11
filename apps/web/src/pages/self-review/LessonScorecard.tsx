import { cn } from '@/utils/cn';
import { useLessonScorecard } from '@/hooks/useSelfReview';
import type { LessonScorecard } from '@/types/selfReview.types';
import { CARD, Empty, MUTED, PRIMARY, SECONDARY, TONE_TEXT } from './SelfReviewViews';
import { dayLabel, VERDICT_LABEL, VERDICT_TONE, windowLine } from './lastNight';

/** "Is it working?": per lesson, how often its mistake happened before vs after it went active. */
export function LessonScorecardPanel({ card }: { card: LessonScorecard }) {
  return (
    <section className="space-y-3" aria-labelledby="scorecard-h">
      <h2 id="scorecard-h" className={cn('text-sm font-semibold', PRIMARY)}>
        Is each lesson working?
      </h2>
      <p className={cn('text-xs', MUTED)} data-testid="scorecard-rule">
        {card.rule} Counted over {card.reviewedSessions} reviewed session{card.reviewedSessions === 1 ? '' : 's'}.
      </p>
      {card.lessons.length === 0 ? (
        <Empty text="No lessons to score yet." />
      ) : (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {card.lessons.map((l) => (
            <li key={l.id} className={cn(CARD, 'space-y-1 text-sm')} data-testid="scorecard-row">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn('break-all font-medium', PRIMARY)}>{l.key}</span>
                <span className={cn('text-xs font-semibold', TONE_TEXT[VERDICT_TONE[l.verdict]])}>{VERDICT_LABEL[l.verdict]}</span>
                {l.status !== 'ACTIVE' && <span className={cn('text-xs', MUTED)}>{l.status.toLowerCase()}</span>}
              </div>
              <p className={cn('text-xs', MUTED)}>Active since {dayLabel(l.activeSince)}</p>
              <p className={SECONDARY}>
                <span className={MUTED}>Before: </span>
                {windowLine(l.before)}
              </p>
              <p className={SECONDARY}>
                <span className={MUTED}>After: </span>
                {windowLine(l.after)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function LessonScorecardSection() {
  const q = useLessonScorecard();
  if (q.isLoading) return <div className="h-24 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" aria-busy="true" />;
  if (q.isError || !q.data) return <Empty text="Could not load the lesson scorecard." />;
  return <LessonScorecardPanel card={q.data} />;
}
