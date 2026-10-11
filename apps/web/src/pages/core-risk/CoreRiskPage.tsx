import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ShieldAlert } from 'lucide-react';
import { LoadingSkeleton } from '@/components/common';
import {
  changeCoreRiskLimit,
  getCoreKillSwitch,
  listCoreRiskLimits,
  setCoreKillSwitch,
  type CoreKillSwitchCascade,
  type CoreRiskLimitView,
} from '@/services/coreRisk';
import { apiErrorMessage } from '@/pages/core-strategies/core-strategy-picker';
import { useAuthStore } from '@/stores/auth-store';
import {
  cascadeLines,
  changeHint,
  changeResultMessage,
  DAILY_LOSS_ACTION_OPTIONS,
  editText,
  KILL_CONFIRM_WORD,
  killSwitchPayload,
  killSwitchSummary,
  limitChangePayload,
  limitRows,
  parseLimitInput,
} from './core-risk';
import { BADGE, BUTTON, CARD, DANGER, FIELD, LABEL, QUIET, TONE } from './core-risk-styles';
import RiskDefaultsSection from './RiskDefaultsSection';

const LIMITS_KEY = ['trade-core', 'risk', 'limits'] as const;
const KILL_KEY = ['trade-core', 'risk', 'kill-switch'] as const;

interface EditState {
  id: string;
  text: string;
  reason: string;
}

/**
 * SP2 Core Risk (spec §8.4): the caller's limits with pending-loosen badges and an edit
 * form with a reason, and the kill switch with a typed confirmation. Logic lives in
 * core-risk.ts; the server applies D5 (tighten now, loosen at the next session open).
 */
export default function CoreRiskPage() {
  const qc = useQueryClient();
  const isOwner = useAuthStore((s) => s.user?.role) === 'ADMIN';
  const limitsQ = useQuery({ queryKey: LIMITS_KEY, queryFn: listCoreRiskLimits });
  const killQ = useQuery({ queryKey: KILL_KEY, queryFn: getCoreKillSwitch });
  const [edit, setEdit] = useState<EditState | null>(null);
  const [mode, setMode] = useState<'on' | 'off' | null>(null);
  const [killReason, setKillReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [lastCascade, setLastCascade] = useState<CoreKillSwitchCascade | null>(null);

  const change = useMutation({
    mutationFn: (a: { view: CoreRiskLimitView; body: { value: number | string; reason: string } }) =>
      changeCoreRiskLimit(a.view.key, a.view.scope, a.body),
    onSuccess: (r) => {
      toast.success(changeResultMessage(r));
      setEdit(null);
      void qc.invalidateQueries({ queryKey: LIMITS_KEY });
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err, 'Could not change the limit')),
  });

  const kill = useMutation({
    mutationFn: (body: { active: boolean; reason: string }) => setCoreKillSwitch(body),
    onSuccess: (r) => {
      setLastCascade(r.cascade);
      setMode(null);
      setKillReason('');
      setConfirmText('');
      toast.success(!r.state.active ? 'Kill switch is off' : r.state.pendingRelease ? 'Release scheduled for the next session open' : 'Kill switch is ON');
      void qc.invalidateQueries({ queryKey: KILL_KEY });
    },
    onError: (err: unknown) => {
      toast.error(apiErrorMessage(err, 'Could not change the kill switch'));
      // The switch may be persisted even when the request failed: show the stored state.
      void qc.invalidateQueries({ queryKey: KILL_KEY });
    },
  });

  if (limitsQ.isLoading || killQ.isLoading) {
    return <div className="p-4"><LoadingSkeleton variant="card" /></div>;
  }
  if (limitsQ.isError || killQ.isError || !limitsQ.data || !killQ.data) {
    return (
      <div className="p-4 text-sm text-[var(--color-accent-red)]">
        Could not load your risk settings: {apiErrorMessage(limitsQ.error ?? killQ.error, 'unknown error')}
      </div>
    );
  }

  const views = limitsQ.data;
  const rows = limitRows(views);
  const ks = killQ.data;
  const summary = killSwitchSummary(ks);
  const lines = cascadeLines(lastCascade);

  const submitKill = () => {
    const p = killSwitchPayload(mode === 'on', killReason, confirmText);
    if (!p.ok) {
      toast.error(p.error);
      return;
    }
    kill.mutate(p.value);
  };

  return (
    <div className="space-y-4 p-4">
      <header className="flex items-center gap-2">
        <ShieldAlert size={18} className="text-[var(--color-accent-red)]" />
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">Core Risk</h1>
        <span className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Paper only
        </span>
      </header>

      <section className={`${CARD} border-2 ${summary.tone === 'danger' ? 'border-[var(--color-accent-red)]' : ''}`}>
        <h2 className={`text-base font-bold ${TONE[summary.tone === 'danger' ? 'danger' : 'ok']}`}>{summary.headline}</h2>
        {summary.detail && <p className="text-xs text-[var(--color-text-secondary)]">{summary.detail}</p>}
        {summary.releaseText && <p className="text-xs text-[var(--color-accent-yellow)]">{summary.releaseText}</p>}

        {mode === null ? (
          <div className="flex flex-wrap gap-2">
            {!ks.active && (
              <button type="button" className={DANGER} onClick={() => setMode('on')}>Stop everything…</button>
            )}
            {ks.active && (
              <button type="button" className={QUIET} onClick={() => setMode('off')}>Release at next session open…</button>
            )}
            {ks.active && ks.pendingRelease && (
              <button type="button" className={DANGER} onClick={() => setMode('on')}>Keep it on (cancel the release)…</button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-[var(--color-text-secondary)]">
              {mode === 'on'
                ? 'This blocks every core entry now, exits core positions, and calls the old tracks’ square-off paths. For the owner that closes every silo position and every trade-engine trade, and trade-engine orders stay blocked until the API restarts.'
                : 'Releasing is a loosening: it takes effect at the next session open, not now.'}
            </p>
            <label className={LABEL}>
              Reason
              <input className={FIELD} value={killReason} onChange={(e) => setKillReason(e.target.value)} placeholder="Why?" />
            </label>
            {mode === 'on' && (
              <label className={LABEL}>
                Type {KILL_CONFIRM_WORD} to confirm
                <input className={FIELD} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
              </label>
            )}
            <div className="flex gap-2">
              <button type="button" className={mode === 'on' ? DANGER : BUTTON} disabled={kill.isPending} onClick={submitKill}>
                {kill.isPending ? 'Working…' : mode === 'on' ? 'Turn the kill switch on' : 'Schedule the release'}
              </button>
              <button type="button" className={QUIET} disabled={kill.isPending} onClick={() => setMode(null)}>Cancel</button>
            </div>
          </div>
        )}

        {lines.length > 0 && (
          <ul className="space-y-0.5 text-xs">
            {lines.map((l) => (
              <li key={l.text} className={TONE[l.tone]}>{l.text}</li>
            ))}
          </ul>
        )}
      </section>

      <section className={CARD}>
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Limits</h2>
        <p className="text-xs text-[var(--color-text-muted)]">Tighter changes take effect now. Looser changes take effect at the next session open.</p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-[var(--color-text-muted)]">
              <th className="py-1">Limit</th>
              <th className="py-1">Applies to</th>
              <th className="py-1">In force</th>
              <th className="py-1">Status</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const view = views[i];
              const editing = edit !== null && edit.id === row.id;
              const parsed = editing ? parseLimitInput(view.kind, edit.text) : null;
              return (
                <Fragment key={row.id}>
                  <tr className="border-t border-[var(--color-border-default)] align-top">
                    <td className="py-1.5 text-[var(--color-text-primary)]">{row.label}</td>
                    <td className="py-1.5 text-[var(--color-text-secondary)]">{row.scopeLabel}</td>
                    <td className="py-1.5 text-[var(--color-text-primary)]">
                      {row.valueText}
                      {row.pendingText && <div className="text-xs text-[var(--color-accent-yellow)]">{row.pendingText}</div>}
                    </td>
                    <td className="py-1.5">
                      {row.badge && (
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${BADGE[row.badge].cls}`}>{BADGE[row.badge].text}</span>
                      )}
                      {row.note && <div className="text-xs text-[var(--color-text-muted)]">{row.note}</div>}
                    </td>
                    <td className="py-1.5 text-right">
                      <button
                        type="button"
                        className="text-[var(--color-accent-blue)] underline"
                        onClick={() => setEdit(editing ? null : { id: row.id, text: editText(view), reason: '' })}
                      >
                        {editing ? 'Close' : 'Change'}
                      </button>
                    </td>
                  </tr>
                  {editing && (
                    <tr>
                      <td colSpan={5} className="pb-3">
                        <div className="flex flex-wrap items-end gap-3">
                          <label className={LABEL}>
                            New value
                            {view.kind === 'enum' ? (
                              <select className={FIELD} value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })}>
                                {DAILY_LOSS_ACTION_OPTIONS.map((o) => (
                                  <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                              </select>
                            ) : (
                              <input
                                className={FIELD}
                                inputMode={view.kind === 'hhmm' ? 'text' : 'decimal'}
                                placeholder={view.kind === 'hhmm' ? 'HH:MM (IST)' : ''}
                                value={edit.text}
                                onChange={(e) => setEdit({ ...edit, text: e.target.value })}
                              />
                            )}
                          </label>
                          <label className={LABEL}>
                            Reason
                            <input className={FIELD} value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} placeholder="Why?" />
                          </label>
                          <button
                            type="button"
                            className={BUTTON}
                            disabled={change.isPending}
                            onClick={() => {
                              const p = limitChangePayload(view, edit.text, edit.reason);
                              if (!p.ok) {
                                toast.error(p.error);
                                return;
                              }
                              change.mutate({ view, body: p.value });
                            }}
                          >
                            {change.isPending ? 'Saving…' : 'Save'}
                          </button>
                        </div>
                        {parsed?.ok && <p className="mt-1 text-xs text-[var(--color-text-muted)]">{changeHint(view, parsed.value)}</p>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </section>

      {isOwner && <RiskDefaultsSection />}
    </div>
  );
}
