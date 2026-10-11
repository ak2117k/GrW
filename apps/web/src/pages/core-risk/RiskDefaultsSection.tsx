import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { changeCoreRiskDefault, listCoreRiskDefaults } from '@/services/coreRiskDefaults';
import { apiErrorMessage } from '@/pages/core-strategies/core-strategy-picker';
import { DAILY_LOSS_ACTION_OPTIONS, editText } from './core-risk';
import { defaultChangePayload, defaultRows, defaultSavedMessage } from './core-risk-defaults';
import { BUTTON, CARD, FIELD, LABEL } from './core-risk-styles';

const DEFAULTS_KEY = ['trade-core', 'risk', 'defaults'] as const;

/** Owner only (decision 20): the values new users' limits start at. Logic in core-risk-defaults.ts. */
export default function RiskDefaultsSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: DEFAULTS_KEY, queryFn: listCoreRiskDefaults });
  const [edit, setEdit] = useState<{ id: string; text: string; reason: string } | null>(null);
  const save = useMutation({
    mutationFn: (a: { key: string; scope: string; body: { value: number | string; reason: string } }) => changeCoreRiskDefault(a.key, a.scope, a.body),
    onSuccess: (v) => {
      toast.success(defaultSavedMessage(v));
      setEdit(null);
      void qc.invalidateQueries({ queryKey: DEFAULTS_KEY });
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err, 'Could not change the default')),
  });

  if (q.isLoading) return <section className={CARD}><p className="text-xs text-[var(--color-text-muted)]">Loading seed defaults…</p></section>;
  if (q.isError || !q.data) {
    return <section className={CARD}><p className="text-xs text-[var(--color-accent-red)]">Could not load the seed defaults: {apiErrorMessage(q.error, 'unknown error')}</p></section>;
  }
  const rows = defaultRows(q.data);

  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Seed defaults (owner)</h2>
      <p className="text-xs text-[var(--color-text-muted)]">
        What a user’s limit starts at when their settings have no equivalent. A change applies to limits seeded from now on and never changes anyone’s current limits.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-[var(--color-text-muted)]">
            <th className="py-1">Limit</th>
            <th className="py-1">Applies to</th>
            <th className="py-1">Default</th>
            <th className="py-1">Basis</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const editing = edit !== null && edit.id === row.id;
            return (
              <Fragment key={row.id}>
                <tr className="border-t border-[var(--color-border-default)] align-top">
                  <td className="py-1.5 text-[var(--color-text-primary)]">{row.label}</td>
                  <td className="py-1.5 text-[var(--color-text-secondary)]">{row.scopeLabel}</td>
                  <td className="py-1.5 text-[var(--color-text-primary)]">{row.valueText}</td>
                  <td className="py-1.5 text-xs text-[var(--color-text-muted)]">
                    {row.note}
                    <div>{row.updatedText}</div>
                  </td>
                  <td className="py-1.5 text-right">
                    <button
                      type="button"
                      className="text-[var(--color-accent-blue)] underline"
                      onClick={() => setEdit(editing ? null : { id: row.id, text: editText(row), reason: '' })}
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
                          New default
                          {row.kind === 'enum' ? (
                            <select className={FIELD} value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })}>
                              {DAILY_LOSS_ACTION_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                              ))}
                            </select>
                          ) : (
                            <input className={FIELD} value={edit.text} placeholder={row.kind === 'hhmm' ? 'HH:MM (IST)' : ''} onChange={(e) => setEdit({ ...edit, text: e.target.value })} />
                          )}
                        </label>
                        <label className={LABEL}>
                          Reason (becomes the basis)
                          <input className={FIELD} value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} />
                        </label>
                        <button
                          type="button"
                          className={BUTTON}
                          disabled={save.isPending}
                          onClick={() => {
                            const p = defaultChangePayload(row.kind, edit.text, edit.reason);
                            if (!p.ok) {
                              toast.error(p.error);
                              return;
                            }
                            save.mutate({ key: row.key, scope: row.scope, body: p.value });
                          }}
                        >
                          {save.isPending ? 'Saving…' : 'Save default'}
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
