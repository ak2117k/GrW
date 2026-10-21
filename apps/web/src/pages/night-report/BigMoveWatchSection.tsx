import { Badge, SymbolChartLink } from '@/components/common';
import { cn } from '@/utils/cn';
import type { BigMoveWatchView } from '@/types/nightReport.types';
import { bookLine, bucketVariant, NO_SCORE, outcomeText, pText, resultsText, sourcesText } from './bigMoveWatchFormat';

const CARD = 'rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-3 sm:p-4';
const MUTED = 'text-[var(--color-text-muted)]';
const SECONDARY = 'text-[var(--color-text-secondary)]';
const PRIMARY = 'text-[var(--color-text-primary)]';

/**
 * Night report "Big-move watch": the stock big-move model's 5-session reading (move SIZE, never
 * direction) for the stocks you hold, the news-idea stocks, and the day's top TOP20 names.
 */
export function BigMoveWatchPanel({ view }: { view: BigMoveWatchView }) {
  return (
    <div className={cn(CARD, 'space-y-2')} data-testid="big-move-watch">
      <p className={cn('text-xs', MUTED)}>{bookLine(view)}</p>
      {view.rows.length === 0 ? (
        <p className={cn('text-sm', MUTED)}>No held stocks, news-idea stocks or TOP20 names to show.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border-subtle)]">
          {view.rows.map((r) => {
            const results = resultsText(r.reading);
            return (
              <li key={r.symbol} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <SymbolChartLink symbol={r.symbol} token={null} exchange="NSE" className={cn('min-h-10 font-medium', PRIMARY)} />
                {r.reading ? (
                  <>
                    <span className={cn('tabular-nums', PRIMARY)}>{pText(r.reading)}</span>
                    <Badge label={r.reading.bucket} variant={bucketVariant(r.reading.bucket)} size="sm" />
                    {results && <span className={cn('text-xs', r.reading.resultsInWindow ? 'text-amber-400' : SECONDARY)}>{results}</span>}
                  </>
                ) : (
                  <span className={cn('text-xs', MUTED)}>{NO_SCORE}</span>
                )}
                <span className={cn('text-xs', SECONDARY)}>{outcomeText(r.lastOutcome)}</span>
                <span className={cn('ml-auto text-[11px]', MUTED)}>{sourcesText(r.sources)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
