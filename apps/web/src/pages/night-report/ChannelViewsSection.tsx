import { Badge } from '@/components/common';
import { cn } from '@/utils/cn';
import type { ChannelViewItem, ChannelViewsView } from '@/types/nightReport.types';

const MUTED = 'text-[var(--color-text-muted)]';
const SECONDARY = 'text-[var(--color-text-secondary)]';
const PRIMARY = 'text-[var(--color-text-primary)]';

const biasVariant = (b: string | null): 'success' | 'danger' | 'neutral' => (b === 'BULL' ? 'success' : b === 'BEAR' ? 'danger' : 'neutral');

function istTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** "levels 21000 · target 21000 · put OI 3x → support · if CRUDE UP · months" */
export function channelViewDetail(i: ChannelViewItem): string {
  const parts: string[] = [];
  if (i.levels.length) parts.push(`levels ${i.levels.join(' / ')}`);
  if (i.targetLevel !== null) parts.push(`target ${i.targetLevel}`);
  if (i.oi) parts.push(`${i.oi.strike} ${i.oi.side}: ${i.oi.note}`);
  if (i.condition) parts.push(`if ${i.condition.driver} ${i.condition.direction ?? '?'}`);
  if (i.horizon) parts.push(i.horizon.toLowerCase());
  return parts.join(' · ');
}

/**
 * Night report "Telegram channel views": the day's INFO posts (channel, underlying, bias, levels,
 * condition) and the weighted lean per underlying. Context only — never a trade trigger.
 */
export function ChannelViewsPanel({ view }: { view: ChannelViewsView }) {
  return (
    <div className="space-y-3 text-sm" data-testid="channel-views">
      <p className={cn('text-xs', MUTED)}>{view.note}</p>
      {view.sentiment.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {view.sentiment.map((s) => (
            <li key={s.underlying} className="rounded-md border border-[var(--color-border-default)] px-2 py-1 text-xs tabular-nums">
              <span className={cn('font-medium', PRIMARY)}>{s.underlying}</span>{' '}
              <span className={SECONDARY}>
                {s.lean.toLowerCase()} · {s.bull} bull / {s.bear} bear{s.neutral ? ` / ${s.neutral} neutral` : ''} · {s.channels} ch
              </span>
            </li>
          ))}
        </ul>
      )}
      {view.items.length === 0 ? (
        <p className={MUTED}>No market views from the Telegram channels in this window.</p>
      ) : (
        <ul className="space-y-1.5">
          {view.items.map((i, k) => (
            <li key={`${i.postedAt}-${i.channelId}-${i.underlying}-${k}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className={cn('text-xs tabular-nums', MUTED)}>{istTime(i.postedAt)}</span>
              <span className={cn('text-xs', SECONDARY)}>{i.channel}</span>
              <span className={cn('font-medium', PRIMARY)}>{i.underlying}</span>
              <Badge label={i.bias ?? 'no bias'} variant={biasVariant(i.bias)} size="sm" />
              <span className={cn('text-xs tabular-nums', SECONDARY)}>{channelViewDetail(i)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
