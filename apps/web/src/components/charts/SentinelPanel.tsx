import { Eye, AlertTriangle, ShieldCheck, HelpCircle } from 'lucide-react';
import clsx from 'clsx';
import type { SentinelPosition } from '@/hooks/useSentinelPositions';

/**
 * Colour and icon per verdict.
 *
 * ESCALATE is AMBER, not grey. It means the agent could not reach a decision it
 * was willing to stand behind and is handing the position back to the user —
 * which is a call to action, not an absence of one. Rendering it as a neutral
 * "no opinion" would reproduce, in the UI, exactly the bias this system had in
 * its reasoning: silence read as reassurance.
 */
const VERDICT_STYLE: Record<string, { cls: string; Icon: typeof Eye; label: string }> = {
  HOLD: { cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30', Icon: ShieldCheck, label: 'HOLD' },
  EXIT_ARMED: { cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30', Icon: AlertTriangle, label: 'EXIT ARMED' },
  EXIT_NOW: { cls: 'bg-red-500/15 text-red-400 border-red-500/30', Icon: AlertTriangle, label: 'EXIT NOW' },
  ESCALATE: { cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30', Icon: HelpCircle, label: 'ESCALATE — YOUR CALL' },
};

const THESIS_CLS: Record<string, string> = {
  INTACT: 'text-emerald-400',
  WEAKENING: 'text-amber-400',
  BROKEN: 'text-red-400',
};

const rs = (n: number) =>
  `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;

/** "4 min ago" — how stale the agent's read is, which the user must be able to see. */
export function agoLabel(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'unknown';
  const mins = Math.floor((now - then) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * The agent's read on the positions held in the charted instrument.
 *
 * Renders NOTHING when there are none — a chart of an instrument you do not
 * hold should look exactly as it did before this existed.
 */
export default function SentinelPanel({ positions }: { positions: SentinelPosition[] }) {
  if (positions.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {positions.map((p) => {
        const v = p.verdict;
        const style = (v && VERDICT_STYLE[v.verdict]) ?? {
          cls: 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] border-[var(--color-border-subtle)]',
          Icon: Eye,
          label: v?.verdict ?? 'NOT YET JUDGED',
        };
        const { Icon } = style;
        const side = p.qty < 0 ? 'SHORT' : 'LONG';

        return (
          <div
            key={p.trackerId}
            className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-3 text-xs"
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className={clsx('inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-semibold', style.cls)}>
                <Icon size={12} />
                {style.label}
              </span>
              <span className="font-medium text-[var(--color-text-primary)]">{p.symbol}</span>
              <span className="text-[var(--color-text-muted)]">
                {side} {Math.abs(p.qty)} @ {p.entryPrice}
              </span>
              {v && (
                <span className={clsx('ml-auto tabular-nums font-medium', v.netPnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                  {rs(v.netPnl)} net
                </span>
              )}
            </div>

            {v ? (
              <>
                <div className="mb-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
                  <span>
                    thesis <span className={THESIS_CLS[v.thesisStatus] ?? ''}>{v.thesisStatus}</span>
                  </span>
                  <span>confidence {v.confidence}</span>
                  {v.greenFloor != null && <span>green floor {v.greenFloor}</span>}
                  {/* Staleness is first-class: an old verdict on a moving market
                      is the one thing a user must not mistake for a live read. */}
                  <span>judged {agoLabel(v.at)}</span>
                  {v.triggeredBy.length > 0 && <span>woken by {v.triggeredBy.join(', ')}</span>}
                </div>
                <p className="text-[var(--color-text-secondary)]">{v.reason}</p>
                {v.invalidationPoint && (
                  <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
                    <span className="font-medium text-[var(--color-text-secondary)]">Invalidation:</span>{' '}
                    {v.invalidationPoint}
                  </p>
                )}
              </>
            ) : (
              <p className="text-[var(--color-text-muted)]">
                No verdict recorded yet for this position — the sentinel has not judged it.
              </p>
            )}

            {p.thesis && (
              <p className="mt-1.5 border-t border-[var(--color-border-subtle)] pt-1.5 text-[11px] text-[var(--color-text-muted)]">
                <span className="font-medium text-[var(--color-text-secondary)]">
                  Thesis ({p.thesis.source === 'USER' ? 'yours' : 'inferred'}):
                </span>{' '}
                {p.thesis.reason}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
