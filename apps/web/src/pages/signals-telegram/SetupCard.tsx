import type { ReactNode } from 'react';
import { Badge } from '@/components/common';
import { cn } from '@/utils/cn';
import {
  checkLabel,
  entryLine,
  optionName,
  rupee,
  setupDecisionChip,
  setupStatus,
  verdictChip,
  type AiSetupRow,
  type GradePartView,
  type SetupGradeView,
} from './signalsTelegram';

const MUTED = 'text-[var(--color-text-muted)]';
const PRIMARY = 'text-[var(--color-text-primary)]';
const SECONDARY = 'text-[var(--color-text-secondary)]';

const time = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
};

const money = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? rupee(n) : '₹ not known');
const pnlTone = (n: number | null | undefined) => (typeof n !== 'number' ? PRIMARY : n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : PRIMARY);

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className={cn('w-24 shrink-0', MUTED)}>{label}</span>
      <span className={cn('min-w-0 break-words', PRIMARY)}>{children}</span>
    </div>
  );
}

function partLine(p: GradePartView): string {
  if (p.status !== 'GRADED') return p.status === 'PENDING' ? 'not graded yet' : `could not be graded${p.reason ? ` (${p.reason})` : ''}`;
  if (p.filled === false) return `entry never came — ₹0${p.reason ? ` (${p.reason})` : ''}`;
  return `${money(p.rupees ?? null)}${p.outcome ? ` · ${p.outcome.replace(/_/g, ' ').toLowerCase()}` : ''}${p.rupeesNote ? ` (${p.rupeesNote})` : ''}`;
}

function GradeBlock({ g }: { g: SetupGradeView }) {
  return (
    <div className="mt-2 space-y-1 border-t border-[var(--color-border-default)] pt-2" data-testid="setup-grade">
      <p className={cn('text-xs font-medium', SECONDARY)}>Night review{g.status !== 'GRADED' ? ` — ${g.status === 'PENDING' ? 'not finished yet' : 'could not finish'}` : ''}</p>
      {g.actual && (
        <Field label="Paper result">
          {g.actual.filled ? (
            <span data-testid="grade-actual">
              <span className={cn('font-medium tabular-nums', pnlTone(g.actual.net))}>{money(g.actual.net)}</span> after charges ({money(g.actual.pnlGross)} before,{' '}
              {money(g.actual.fees)} charges)
            </span>
          ) : (
            <span data-testid="grade-actual">not traded — entry never came</span>
          )}
        </Field>
      )}
      {g.plan && <Field label="Plan's levels only">{partLine(g.plan)}</Field>}
      {g.whatIf && (
        <Field label="What if (hypothetical)">
          <span data-testid="grade-what-if">
            {partLine(g.whatIf)} — not a real trade{g.whatIf.reference ? ', a simple reference trade the AI did not make' : ', the blocked setup as written'}
          </span>
        </Field>
      )}
    </div>
  );
}

/** One AI setup card: the claim it came from, the AI's decision, the plan, its paper status and P&L, and the night grade. */
export function SetupCard({ s }: { s: AiSetupRow }) {
  const chip = setupDecisionChip(s);
  const live = s.decision === 'SETUP' && s.status !== 'NO_TRADE' && !!s.setup;
  const blocked = s.decision === 'SETUP' && s.status === 'NO_TRADE';
  const v = s.claim?.verdict ? verdictChip(s.claim.verdict) : null;
  const slNow = s.setup?.watch?.sl;
  return (
    <div className="mt-2 rounded-md border border-[var(--color-border-default)] p-2 sm:p-3" data-testid="setup-card" data-status={s.status}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge label={chip.label} variant={chip.variant} size="sm" />
        <span className={cn('text-sm font-medium', PRIMARY)}>{s.underlying}</span>
        <span className={cn('text-xs tabular-nums', MUTED)}>{time(s.createdAt)}</span>
      </div>
      {s.claim && (
        <p className={cn('mt-1 break-words text-xs', SECONDARY)}>
          <span className={MUTED}>Channel said:</span> {s.claim.text.length > 140 ? `${s.claim.text.slice(0, 137)}…` : s.claim.text}
          {v && <span className={MUTED}> · checked: {v.label.toLowerCase()}</span>}
        </p>
      )}

      {live && s.setup ? (
        <div className="mt-2 space-y-1">
          <Field label="Option">
            {s.setup.side === 'BUY' ? 'Buy ' : `${s.setup.side} `}
            {optionName(s.setup.instrument)}
          </Field>
          <Field label="Entry">{entryLine(s.setup)}</Field>
          <Field label="Stop-loss">
            {s.setup.sl}
            {typeof slNow === 'number' && slNow !== s.setup.sl ? ` (now ${slNow}, moved after target 1)` : ''}
            <span className={MUTED}> {s.underlying} price</span>
          </Field>
          <Field label="Targets">
            {s.setup.targets.join(' · ')}
            <span className={MUTED}> {s.underlying} price</span>
          </Field>
          <Field label="Valid until">{s.setup.validUntil} IST</Field>
          <Field label="Confidence">{Math.round(s.setup.confidence)}/100</Field>
          <Field label="Why">{s.reason}</Field>
          {(s.setup.evidence?.length ?? 0) > 0 && (
            <details className="text-xs">
              <summary className={cn('cursor-pointer', MUTED)}>Numbers behind it ({s.setup.evidence!.length})</summary>
              <ul className="mt-1 space-y-0.5 pl-2">
                {s.setup.evidence!.map((e, i) => (
                  <li key={i} className={MUTED}>
                    <span className={SECONDARY}>{e.fact}</span> <span className={cn('font-medium tabular-nums', PRIMARY)}>{e.value}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <Field label="Paper status">
            <span data-testid="setup-status">{setupStatus(s)}</span>
            {s.entryAt ? ` · in ${time(s.entryAt)}` : ''}
            {s.exitAt && s.status === 'EXITED' ? ` · out ${time(s.exitAt)}` : ''}
          </Field>
          {s.pnl !== null && (
            <Field label="Paper P&L">
              <span data-testid="setup-pnl" className={cn('font-medium tabular-nums', pnlTone(s.pnl))}>
                {money(s.pnl)}
              </span>{' '}
              <span className={MUTED}>before charges</span>
            </Field>
          )}
        </div>
      ) : (
        <div className="mt-2 space-y-1">
          {blocked && s.setup && <Field label="AI wanted">Buy {optionName(s.setup.instrument)}</Field>}
          {s.failedCheck && (
            <Field label="Failed check">
              <span data-testid="setup-failed-check">
                {checkLabel(s.failedCheck.name)}
                {s.failedCheck.detail ? ` — ${s.failedCheck.detail}` : ''}
              </span>
            </Field>
          )}
          {!s.failedCheck && (
            <Field label={s.status === 'SKIPPED' ? 'Why skipped' : 'Why no trade'}>
              <span data-testid="setup-reason">{s.reason}</span>
            </Field>
          )}
        </div>
      )}

      {s.grade && <GradeBlock g={s.grade} />}
    </div>
  );
}
