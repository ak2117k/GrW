import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { Badge } from '@/components/common';
import { cn } from '@/utils/cn';
import type { SelfReviewLatest } from '@/types/selfReview.types';
import {
  hitLine,
  hitRateOf,
  hitTone,
  kindLabel,
  kindRows,
  lessonsAddedCount,
  lessonsAddedList,
  pct,
  sessionLabel,
  topMisses,
  totals,
} from '../self-review/selfReviewFormat';

const CARD = 'rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-3 sm:p-4';
const MUTED = 'text-[var(--color-text-muted)]';
const SECONDARY = 'text-[var(--color-text-secondary)]';
const PRIMARY = 'text-[var(--color-text-primary)]';
const TONE = { good: 'text-emerald-400', bad: 'text-red-400', neutral: PRIMARY } as const;

/** Night report panel: how yesterday's calls scored, the top misses, new lessons, pending proposals. */
export function SelfReviewPanel({ data }: { data: SelfReviewLatest }) {
  const summary = data.summary ?? data.run?.summary ?? null;
  const rows = kindRows(summary);
  const all = totals(summary);
  const misses = topMisses(data.misses, 3);
  const lessons = lessonsAddedList(data.lessonsAdded);
  const lessonCount = lessonsAddedCount(data.lessonsAdded);
  const pending = data.proposalsPending ?? 0;
  const session = summary?.session ?? data.run?.sessionDate ?? null;

  if (!data.run && rows.length === 0) {
    return <p className={cn(CARD, 'text-sm', MUTED)}>No self-review run yet.</p>;
  }

  return (
    <div className={cn(CARD, 'space-y-3')} data-testid="self-review-panel">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={cn('font-semibold', PRIMARY)}>Session {sessionLabel(session)}</span>
        {data.run && data.run.status !== 'DONE' && (
          <Badge label={data.run.status} variant={data.run.status === 'FAILED' ? 'danger' : 'info'} size="sm" />
        )}
        <span className={MUTED}>
          {all.right} right · {all.wrong} wrong · hit rate <span className={TONE[hitTone(all.rate)]}>{pct(all.rate)}</span>
        </span>
      </div>

      {rows.length === 0 ? (
        <p className={cn('text-xs', MUTED)}>No calls were judged for this session.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border-subtle)] text-xs">
          {rows.map((r) => (
            <li key={r.kind} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span className={SECONDARY}>{r.label}</span>
              <span className={cn('tabular-nums', TONE[hitTone(hitRateOf(r.stats))])}>{hitLine(r.stats)}</span>
            </li>
          ))}
        </ul>
      )}

      {misses.length > 0 && (
        <div className="space-y-1.5">
          <h3 className={cn('text-xs font-semibold uppercase tracking-wide', MUTED)}>Top misses</h3>
          <ol className="space-y-1.5">
            {misses.map((m, i) => (
              <li key={`${m.refIds?.join(',') ?? ''}-${i}`} className="text-sm">
                <span className={cn('mr-1.5 text-xs', MUTED)}>
                  {[m.kind ? kindLabel(m.kind) : null, m.symbol].filter(Boolean).join(' · ') || `Miss ${i + 1}`}
                </span>
                <span className={PRIMARY}>{m.cause}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="space-y-1.5">
        <h3 className={cn('text-xs font-semibold uppercase tracking-wide', MUTED)}>
          Lessons added {lessonCount > 0 && <span className="normal-case">({lessonCount})</span>}
        </h3>
        {lessonCount === 0 ? (
          <p className={cn('text-xs', MUTED)}>None this run.</p>
        ) : lessons.length > 0 ? (
          <ul className="space-y-1">
            {lessons.map((l) => (
              <li key={l.key} className={cn('text-sm', SECONDARY)}>
                {l.text ?? <span className="font-mono text-xs">{l.key}</span>}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <Link
        to="/self-review"
        className={cn(
          'flex min-h-10 items-center justify-between rounded border px-3 text-sm',
          pending > 0
            ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
            : 'border-[var(--color-border-subtle)] text-[var(--color-text-secondary)]',
        )}
      >
        <span>
          {pending > 0 ? `${pending} tuning proposal${pending === 1 ? '' : 's'} waiting for approval` : 'No proposals waiting'}
        </span>
        <ChevronRight size={16} />
      </Link>
    </div>
  );
}
