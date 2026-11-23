import { Sparkles } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { AiArticleRead } from '@/services/newsAi';
import { DIR_BAR, DIR_CHIP, DIR_LABEL, dirKey, pct100, strengthLabel } from './newsAiFormat';

/** At or above this 0..100 importance the card flags the article as high impact. */
const HIGH_IMPORTANCE = 70;

interface AiReadBadgeProps {
  read: AiArticleRead;
  className?: string;
}

/** Claude's read of one article: direction + strength, one-line takeaway, affected chips. */
export default function AiReadBadge({ read, className }: AiReadBadgeProps) {
  const dk = dirKey(read.direction);
  const strength = strengthLabel(read.strength);
  const importance = pct100(read.importance);

  return (
    <div
      className={cn(
        'mt-3 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-tertiary)]/60 px-2.5 py-2',
        className,
      )}
      data-testid="ai-read"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent-blue)]">
          <Sparkles size={10} />
          AI read
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none',
            DIR_CHIP[dk],
          )}
        >
          {DIR_LABEL[dk]}
          <span className="opacity-80">· {strength}</span>
        </span>
        {importance >= HIGH_IMPORTANCE && (
          <span
            title={`Importance ${importance}/100`}
            className="rounded-full border border-[var(--color-accent-blue)]/40 px-1.5 py-0.5 text-[10px] font-medium leading-none text-[var(--color-accent-blue)]"
          >
            High impact
          </span>
        )}
      </div>

      {read.takeaway && (
        <p className="mt-1.5 text-xs leading-snug text-[var(--color-text-primary)]">{read.takeaway}</p>
      )}

      {read.affected.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {read.affected.slice(0, 8).map((a, i) => {
            const ak = dirKey(a.direction);
            const tip = [a.kind.toLowerCase(), DIR_LABEL[ak].toLowerCase(), a.why].filter(Boolean).join(' · ');
            return (
              <span
                key={`${a.kind}-${a.name}-${i}`}
                title={tip}
                tabIndex={0}
                aria-label={`${a.name}: ${tip}`}
                className="inline-flex cursor-help items-center gap-1 rounded bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-secondary)]"
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', DIR_BAR[ak])} />
                {a.name}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
