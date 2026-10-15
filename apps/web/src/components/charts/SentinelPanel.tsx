import { Eye, AlertTriangle, ShieldCheck, HelpCircle, Moon } from 'lucide-react';
import clsx from 'clsx';
import type { SentinelPosition } from '@/hooks/useSentinelPositions';
import type { SentinelTriggerRow } from '@/hooks/useSentinelTriggers';
import { armedForTracker, armedTriggerLine } from './triggerView';
import { agoLabel, overnightPlanCard, type OvernightPlanCard, type OvernightTone } from './overnightPlanView';

export { agoLabel };

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

const TONE_CLS: Record<OvernightTone, string> = {
  emerald: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  amber: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  red: 'bg-red-500/15 text-red-400 border-red-500/30',
  muted: 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] border-[var(--color-border-subtle)]',
};

/**
 * The latest after-close or pre-open verdict: what the sentinel would do at the
 * next open, and the plan for the first minutes. Shown BESIDE the live verdict,
 * never in place of it — and marked when a newer live read has superseded it.
 */
function OvernightPlan({ card }: { card: OvernightPlanCard }) {
  return (
    <div
      className={clsx(
        'rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-tertiary)]/40 p-2 text-[11px]',
        (card.superseded || card.stale) && 'opacity-70',
      )}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 font-medium text-[var(--color-text-secondary)]">
          <Moon size={11} />
          {card.title}
        </span>
        <span className={clsx('rounded border px-1.5 py-0.5 font-semibold', TONE_CLS[card.tone])}>{card.verdictLabel}</span>
        <span className="text-[var(--color-text-muted)]">
          {card.windowLabel} · {card.ago} · confidence {card.confidence}
        </span>
      </div>
      {card.plan && (
        <p className="text-[var(--color-text-secondary)]">
          <span className="font-medium">At the open:</span> {card.plan}
        </p>
      )}
      {card.risk && (
        <p className="mt-1 text-[var(--color-text-muted)]">
          <span className="font-medium text-[var(--color-text-secondary)]">Overnight risk:</span> {card.risk}
        </p>
      )}
      {card.changeMind && (
        <p className="mt-1 text-[var(--color-text-muted)]">
          <span className="font-medium text-[var(--color-text-secondary)]">Changes its mind:</span> {card.changeMind}
        </p>
      )}
      {(card.superseded || card.stale) && (
        <p className="mt-1 italic text-[var(--color-text-muted)]">
          {card.superseded ? 'Superseded by the live read above.' : 'From an earlier session.'}
        </p>
      )}
    </div>
  );
}

/**
 * The agent's read on the positions held in the charted instrument.
 *
 * Renders NOTHING when there are none — a chart of an instrument you do not
 * hold should look exactly as it did before this existed.
 */
export default function SentinelPanel({
  positions,
  triggers = [],
}: {
  positions: SentinelPosition[];
  /** The executor's price triggers (what WILL fire); optional — none = the panel as before. */
  triggers?: SentinelTriggerRow[];
}) {
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
        const overnight = overnightPlanCard(p);

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
                {(() => {
                  const armed = armedForTracker(triggers, p.trackerId);
                  const line = armed ? armedTriggerLine(armed) : null;
                  return line ? (
                    <p className="mt-1 text-[11px] font-medium text-amber-400" title={armed?.verdictId}>
                      {line}
                    </p>
                  ) : null;
                })()}
              </>
            ) : (
              <p className="text-[var(--color-text-muted)]">
                No verdict recorded yet for this position — the sentinel has not judged it.
              </p>
            )}

            {overnight && (
              <div className="mt-2">
                <OvernightPlan card={overnight} />
              </div>
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
