import { Badge } from '@/components/common';
import { cn } from '@/utils/cn';
import type { NewsDigestItem, NewsDigestView } from '@/types/nightReport.types';

const MUTED = 'text-[var(--color-text-muted)]';
const SECONDARY = 'text-[var(--color-text-secondary)]';
const PRIMARY = 'text-[var(--color-text-primary)]';

const directionVariant = (d: string): 'success' | 'danger' | 'neutral' => (d === 'BULL' ? 'success' : d === 'BEAR' ? 'danger' : 'neutral');
const magnitudeVariant = (m: string): 'danger' | 'warning' | 'neutral' => (m === 'HIGH' ? 'danger' : m === 'MED' ? 'warning' : 'neutral');

const AT_LABEL: Record<string, string> = { p15: '+15m', p60: '+60m', close: 'close', nextClose: 'next close' };

/** "NIFTY, RELIANCE · NIFTY BANK" — affected index, symbols, sectors. */
export function affectedText(i: NewsDigestItem): string {
  const parts = [...(i.affected.index ? [i.affected.index] : []), ...i.affected.symbols.filter((s) => s !== i.affected.index)];
  const head = parts.join(', ');
  const sectors = i.affected.sectors.join(', ');
  return [head, sectors].filter(Boolean).join(' · ') || 'market-wide';
}

/** "RELIANCE +1.20% (+60m) · NIFTY −0.30% (close)"; "no reaction yet" when nothing is filled. */
export function reactionText(i: NewsDigestItem): string {
  const parts = i.reaction
    .filter((r) => r.movePct !== null)
    .map((r) => `${r.symbol} ${r.movePct! >= 0 ? '+' : '−'}${Math.abs(r.movePct!).toFixed(2)}%${r.at ? ` (${AT_LABEL[r.at] ?? r.at})` : ''}`);
  return parts.length ? parts.join(' · ') : 'no reaction yet';
}

/**
 * Night report "News digest": the day's top model-read news (direction, magnitude, horizon, affected,
 * coverage) and the market reaction recorded so far. Context only — never a trade trigger.
 */
export function NewsDigestPanel({ view }: { view: NewsDigestView }) {
  return (
    <div className="space-y-3 text-sm" data-testid="news-digest">
      <p className={cn('text-xs', MUTED)}>{view.note}</p>
      {view.items.length === 0 ? (
        <p className={MUTED}>No analysed news in this window.</p>
      ) : (
        <ul className="space-y-2.5">
          {view.items.map((i) => (
            <li key={i.clusterId} className="space-y-0.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge label={i.direction} variant={directionVariant(i.direction)} size="sm" />
                <Badge label={i.magnitude} variant={magnitudeVariant(i.magnitude)} size="sm" />
                <span className={cn('text-xs', SECONDARY)}>{i.horizon.toLowerCase()}</span>
                {i.pricedIn && <span className={cn('text-xs', MUTED)}>priced in?</span>}
                <span className={cn('font-medium break-words', PRIMARY)}>{i.headline}</span>
              </div>
              <p className={cn('text-xs', SECONDARY)}>{i.oneLine}</p>
              <p className={cn('text-xs tabular-nums', MUTED)}>
                {affectedText(i)} · {i.sourceCount} source{i.sourceCount === 1 ? '' : 's'} ({i.sources.slice(0, 3).join(', ')}) · {i.materialType.toLowerCase()} · {reactionText(i)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
