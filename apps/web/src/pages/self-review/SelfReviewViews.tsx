import { useState } from 'react';
import { ArrowRight, Check, X } from 'lucide-react';
import { Badge, SymbolChartLink } from '@/components/common';
import { cn } from '@/utils/cn';
import type { AgentLesson, SelfReviewRun, TuningProposal } from '@/types/selfReview.types';
import type { Decision } from './proposalDecision';
import {
  evidenceLine,
  formatValue,
  hitRateOf,
  hitTone,
  kindRows,
  lessonInjected,
  pct,
  proposalStatusVariant,
  runStatusVariant,
  scopeLabel,
  sessionLabel,
  signalTradeLines,
  skillLines,
  targetLabel,
} from './selfReviewFormat';

export const CARD = 'rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-3 sm:p-4';
export const MUTED = 'text-[var(--color-text-muted)]';
export const SECONDARY = 'text-[var(--color-text-secondary)]';
export const PRIMARY = 'text-[var(--color-text-primary)]';
const BTN = 'inline-flex min-h-10 items-center justify-center gap-1.5 rounded border px-3 text-sm font-medium disabled:opacity-50';

export const TONE_TEXT = { good: 'text-emerald-400', bad: 'text-red-400', neutral: PRIMARY } as const;

export function Empty({ text }: { text: string }) {
  return <p className={cn(CARD, 'text-sm', MUTED)}>{text}</p>;
}

// ---------------------------------------------------------------- proposals

/** Approve / Reject with a confirm step: the first tap arms, the second commits. */
function DecisionButtons({ busy, onDecide }: { busy: boolean; onDecide: (d: Decision) => void }) {
  const [armed, setArmed] = useState<Decision | null>(null);
  if (armed) {
    return (
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm decision">
        <span className={cn('text-sm', SECONDARY)}>
          {armed === 'approve' ? 'Apply this change?' : 'Reject this proposal?'}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            onDecide(armed);
            setArmed(null);
          }}
          className={cn(
            BTN,
            armed === 'approve'
              ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
              : 'border-red-500/50 bg-red-500/15 text-red-300',
          )}
        >
          Confirm {armed === 'approve' ? 'approve' : 'reject'}
        </button>
        <button
          type="button"
          onClick={() => setArmed(null)}
          className={cn(BTN, 'border-[var(--color-border-default)]', SECONDARY)}
        >
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => setArmed('approve')}
        className={cn(BTN, 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10')}
      >
        <Check size={16} /> Approve
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setArmed('reject')}
        className={cn(BTN, 'border-red-500/40 text-red-300 hover:bg-red-500/10')}
      >
        <X size={16} /> Reject
      </button>
    </div>
  );
}

export function ProposalCard({
  p,
  busy = false,
  onDecide,
}: {
  p: TuningProposal;
  busy?: boolean;
  onDecide?: (id: string, d: Decision) => void;
}) {
  const examples = p.evidence?.examples ?? [];
  return (
    <article className={cn(CARD, 'space-y-3')} data-testid="proposal-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className={cn('text-sm font-semibold', PRIMARY)}>{targetLabel(p.target)}</h3>
          <p className={cn('break-all font-mono text-[11px]', MUTED)}>{p.target}</p>
        </div>
        <Badge label={p.status} variant={proposalStatusVariant(p.status)} size="sm" />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm tabular-nums">
        <span className={cn('rounded bg-[var(--color-bg-tertiary)] px-2 py-1', SECONDARY)}>{formatValue(p.currentValue)}</span>
        <ArrowRight size={16} className={MUTED} aria-label="to" />
        <span className="rounded bg-[var(--color-accent-blue)]/15 px-2 py-1 font-semibold text-[var(--color-accent-blue)]">
          {formatValue(p.proposedValue)}
        </span>
      </div>

      <p className={cn('text-sm', SECONDARY)}>{p.rationale}</p>

      <div className="space-y-1.5">
        <p className={cn('text-xs', MUTED)}>Evidence: {evidenceLine(p)}</p>
        {examples.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {examples.slice(0, 6).map((e) =>
              e.symbol ? (
                <span key={e.refId} className="inline-flex items-center gap-1 text-xs">
                  <SymbolChartLink
                    symbol={e.symbol}
                    className="min-h-10 rounded-full border border-[var(--color-border-subtle)] px-3 text-xs text-[var(--color-text-secondary)] hover:border-[var(--color-accent-blue)]"
                  />
                  {e.sessionDate && <span className={MUTED}>{sessionLabel(e.sessionDate)}</span>}
                </span>
              ) : (
                <span
                  key={e.refId}
                  className={cn('inline-flex min-h-10 items-center rounded-full border border-[var(--color-border-subtle)] px-3 text-xs', MUTED)}
                >
                  {e.sessionDate ? sessionLabel(e.sessionDate) : e.refId}
                </span>
              ),
            )}
          </div>
        )}
      </div>

      <div className={cn('flex flex-wrap items-center justify-between gap-2 text-[11px]', MUTED)}>
        <span>
          Raised {new Date(p.createdAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}
          {p.decidedAt && ` · decided ${new Date(p.decidedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}`}
          {p.decidedBy && ` by ${p.decidedBy}`}
        </span>
      </div>

      {p.status === 'PENDING' && onDecide && <DecisionButtons busy={busy} onDecide={(d) => onDecide(p.id, d)} />}
    </article>
  );
}

// ---------------------------------------------------------------- lessons

export function LessonCard({ l, busy = false, onRetire }: { l: AgentLesson; busy?: boolean; onRetire?: (id: string) => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <article className={cn(CARD, 'space-y-2', l.status !== 'ACTIVE' && 'opacity-70')} data-testid="lesson-card">
      <div className="flex flex-wrap items-center gap-2">
        <Badge label={scopeLabel(l.scope)} variant="info" size="sm" />
        <Badge label={l.status} variant={l.status === 'ACTIVE' ? 'success' : 'neutral'} size="sm" />
        {lessonInjected(l) && <Badge label="Fed to agent" variant="warning" size="sm" />}
        <span className={cn('ml-auto text-xs tabular-nums', MUTED)}>
          <span className="text-emerald-400">{l.rightCount} right</span> · <span className="text-red-400">{l.wrongCount} wrong</span>
        </span>
      </div>
      <p className={cn('text-sm', PRIMARY)}>{l.text}</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={cn('break-all font-mono text-[11px]', MUTED)}>{l.key}</span>
        {l.status === 'ACTIVE' && onRetire && (
          armed ? (
            <span className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onRetire(l.id);
                  setArmed(false);
                }}
                className={cn(BTN, 'border-red-500/50 bg-red-500/15 text-red-300')}
              >
                Confirm retire
              </button>
              <button type="button" onClick={() => setArmed(false)} className={cn(BTN, 'border-[var(--color-border-default)]', SECONDARY)}>
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setArmed(true)}
              className={cn(BTN, 'border-[var(--color-border-default)]', SECONDARY)}
            >
              Retire
            </button>
          )
        )}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- history

export function RunCard({ run }: { run: SelfReviewRun }) {
  const rows = kindRows(run.summary);
  return (
    <article className={cn(CARD, 'space-y-2')} data-testid="run-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('text-sm font-semibold', PRIMARY)}>{sessionLabel(run.sessionDate)}</span>
        <Badge label={run.status} variant={runStatusVariant(run.status)} size="sm" />
        <span className={cn('ml-auto text-[11px]', MUTED)}>
          {new Date(run.startedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
        </span>
      </div>
      {run.error && <p className="text-xs text-red-400">{run.error}</p>}
      {rows.length === 0 ? (
        <p className={cn('text-xs', MUTED)}>No judged calls.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {rows.map((r) => {
            const rate = hitRateOf(r.stats);
            return (
              <div key={r.kind} className="rounded border border-[var(--color-border-subtle)] px-2 py-1.5">
                <p className={cn('text-[11px]', MUTED)}>{r.label}</p>
                <p className={cn('text-sm font-semibold tabular-nums', TONE_TEXT[hitTone(rate)])}>{pct(rate)}</p>
                <p className={cn('text-[11px] tabular-nums', MUTED)}>
                  {r.stats.right}/{r.stats.right + r.stats.wrong}
                </p>
              </div>
            );
          })}
        </div>
      )}
      {skillLines(run.summary).map((s) => (
        <p key={s.kind} className={cn('text-[11px]', MUTED)} data-testid="skill-line">
          {s.label}, last 20 sessions: <span className={cn('font-semibold', TONE_TEXT[s.tone])}>{s.verdict}</span> — {s.note}
        </p>
      ))}
      {signalTradeLines(run.summary).map((s) => (
        <p key={s.key} className={cn('text-[11px]', MUTED)} data-testid="signal-trade-line">
          {s.label}, last 20 sessions: <span className={cn('font-semibold', TONE_TEXT[s.tone])}>{s.text}</span>
        </p>
      ))}
    </article>
  );
}
