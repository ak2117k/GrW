import { Badge } from '@/components/common';
import { cn } from '@/utils/cn';
import { callLine, classLabel, judgeHeading, lagLabel, watchLine, whyLine, type FeedItem } from './telegramFeed';

const CARD = 'rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-3';
const MUTED = 'text-[var(--color-text-muted)]';
const SECONDARY = 'text-[var(--color-text-secondary)]';

const istTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** Every incoming Telegram post, newest first: channel, time, text, and what the reader made of it. */
export function TelegramFeedView({ items }: { items: FeedItem[] }) {
  if (items.length === 0) return <p className={cn('py-10 text-center text-sm', MUTED)}>No messages match.</p>;
  return (
    <ul className="space-y-2">
      {items.map((m) => {
        const cls = classLabel(m.status);
        const why = whyLine(m);
        const lag = lagLabel(m.lagSec);
        return (
          <li key={m.id} className={cn(CARD, m.call && 'border-emerald-500/40')}>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge label={cls.label} variant={cls.variant} size="sm" />
              <span className="font-medium text-[var(--color-text-primary)]">{m.channel}</span>
              <span className={MUTED}>{istTime(m.postedAt)}</span>
              {m.hasMedia && <span className={MUTED}>· image</span>}
              {lag && <span className="text-amber-400">· {lag}</span>}
            </div>
            {m.text ? (
              <p className={cn('mt-1.5 whitespace-pre-wrap break-words text-sm line-clamp-4', SECONDARY)}>{m.text}</p>
            ) : (
              <p className={cn('mt-1.5 text-sm italic', MUTED)}>(no text)</p>
            )}
            {m.call && <p className="mt-1.5 text-sm font-medium text-emerald-400">{callLine(m.call)}</p>}
            {why && <p className={cn('mt-1 text-xs', MUTED)}>{why}</p>}
            {m.call && judgeHeading(m.call) && (
              <div className={cn('mt-1.5 text-xs', SECONDARY)}>
                <p className="font-medium">{judgeHeading(m.call)}</p>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                  {(m.call.judgeReasons ?? []).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
            {(m.watches ?? []).map((w, i) => (
              <p key={i} className="mt-1 text-xs font-medium text-sky-400">
                {watchLine(w)}
              </p>
            ))}
          </li>
        );
      })}
    </ul>
  );
}
