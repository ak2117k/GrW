import { Bot } from 'lucide-react';
import clsx from 'clsx';
import { useAiExits } from '@/hooks/useAiExits';
import { aiExitRowView, recentAiExits, type AiExitTone } from './aiExitView';

const TONE_CLS: Record<AiExitTone, string> = {
  emerald: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  amber: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  red: 'bg-red-500/15 text-red-400 border-red-500/30',
  muted: 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] border-[var(--color-border-subtle)]',
};

/**
 * What the sentinel auto-exit did in the last 24 h. Renders NOTHING when there
 * is nothing to show or the account is not enabled (403/404) — a sibling of
 * SentinelPanel because an exited position no longer has a sentinel card
 * (ruling R15). Live rows are coloured by outcome; dry-run and skipped rows
 * are muted so a real order always stands out.
 */
export default function AiExitsList() {
  const { rows } = useAiExits();
  const recent = recentAiExits(rows);
  if (recent.length === 0) return null;
  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-3 text-xs">
      <div className="mb-2 flex items-center gap-1.5 font-medium text-[var(--color-text-secondary)]">
        <Bot size={12} />
        AI exits
        <span className="font-normal text-[var(--color-text-muted)]">· last 24 h</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {recent.map((r) => {
          const v = aiExitRowView(r);
          return (
            <li key={r.id} className={clsx('flex flex-wrap items-baseline gap-x-2 gap-y-0.5', v.dryRun && 'opacity-80')}>
              <span className={clsx('rounded border px-1.5 py-0.5 font-semibold', TONE_CLS[v.tone])}>{v.label}</span>
              {v.unitUnverified && (
                <span
                  className="rounded border border-amber-500/30 px-1 py-0.5 text-[10px] text-amber-400"
                  title="The order quantity unit for this exchange is not verified; live mode would refuse this exit."
                >
                  unit unverified
                </span>
              )}
              <span className={clsx(v.dryRun ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-text-primary)]')}>
                {v.line}
              </span>
              <span className="text-[var(--color-text-muted)]" title={r.createdAt}>
                {v.time ? `${v.time} · ${v.ago}` : v.ago}
              </span>
              {v.detail && (
                <span className="basis-full break-words text-[11px] text-[var(--color-text-muted)]">{v.detail}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
