import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Layers } from 'lucide-react';
import { LoadingSkeleton, Toggle } from '@/components/common';
import { useAuthStore } from '@/stores/auth-store';
import {
  approveCoreVersion,
  listCoreSelections,
  listCoreStrategies,
  setCoreSelection,
  type SetCoreSelectionBody,
} from '@/services/coreStrategies';
import { apiErrorMessage, describeBlocks, pickerRow, selectionPayload, versionLabel } from './core-strategy-picker';

const STRATEGIES_KEY = ['trade-core', 'strategies'] as const;
const SELECTIONS_KEY = ['trade-core', 'strategy-selections'] as const;

const CARD = 'space-y-3 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-4';
const LABEL = 'flex flex-col gap-1 text-xs font-medium text-[var(--color-text-muted)]';
const FIELD = 'rounded border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-sm text-[var(--color-text-primary)]';
const BUTTON = 'rounded bg-[var(--color-accent-blue)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50';

interface FormState {
  /** pickerRow identity the form was started from; a new server row resets the form. */
  key: string;
  versionId: string | null;
  enabled: boolean;
  capitalText: string;
}

/**
 * SP2 strategy picker (spec §4.3): choose a strategy and an approved version,
 * switch it on (paper) with a capital allocation, read its blocks. The owner can
 * approve a draft here. Logic lives in core-strategy-picker.ts.
 */
export default function CoreStrategiesPage() {
  const qc = useQueryClient();
  const isOwner = useAuthStore((s) => s.user?.role) === 'ADMIN';
  const strategiesQ = useQuery({ queryKey: STRATEGIES_KEY, queryFn: listCoreStrategies });
  const selectionsQ = useQuery({ queryKey: SELECTIONS_KEY, queryFn: listCoreSelections });
  const [pickedId, setPickedId] = useState('');
  const [viewId, setViewId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);

  const save = useMutation({
    mutationFn: (args: { strategyId: string; body: SetCoreSelectionBody }) => setCoreSelection(args.strategyId, args.body),
    onSuccess: () => {
      toast.success('Selection saved (paper)');
      void qc.invalidateQueries({ queryKey: SELECTIONS_KEY });
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err, 'Could not save the selection')),
  });

  const approve = useMutation({
    mutationFn: (versionId: string) => approveCoreVersion(versionId),
    onSuccess: (v) => {
      toast.success(`v${v.version} approved: selectable in paper`);
      void qc.invalidateQueries({ queryKey: STRATEGIES_KEY });
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err, 'Could not approve the version')),
  });

  if (strategiesQ.isLoading || selectionsQ.isLoading) {
    return <div className="p-4"><LoadingSkeleton variant="card" /></div>;
  }
  if (strategiesQ.isError || selectionsQ.isError) {
    return (
      <div className="p-4 text-sm text-[var(--color-accent-red)]">
        Could not load the strategy catalogue: {apiErrorMessage(strategiesQ.error ?? selectionsQ.error, 'unknown error')}
      </div>
    );
  }

  const strategies = strategiesQ.data ?? [];
  const strategy = strategies.find((s) => s.id === pickedId) ?? strategies[0];
  if (!strategy) {
    return <div className="p-4 text-sm text-[var(--color-text-muted)]">No strategies in the catalogue yet.</div>;
  }
  const selection = (selectionsQ.data ?? []).find((x) => x.strategyId === strategy.id);
  const row = pickerRow(strategy, selection);
  const rowKey = [row.strategyId, row.versionId, row.enabled, row.capitalText, selection?.updatedAt ?? ''].join('|');
  const current: FormState =
    form && form.key === rowKey
      ? form
      : { key: rowKey, versionId: row.versionId, enabled: row.enabled, capitalText: row.capitalText };
  const shown = strategy.versions.find((v) => v.id === (viewId ?? current.versionId)) ?? strategy.versions[0];

  const onSave = () => {
    const payload = selectionPayload(current);
    if (!payload.ok) {
      toast.error(payload.error);
      return;
    }
    save.mutate({ strategyId: strategy.id, body: payload.value });
  };

  return (
    <div className="space-y-4 p-4">
      <header className="flex items-center gap-2">
        <Layers size={18} className="text-[var(--color-accent-blue)]" />
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">Core Strategies</h1>
        <span className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Paper only
        </span>
      </header>

      <section className={CARD}>
        <label className={LABEL}>
          Strategy
          <select
            className={FIELD}
            value={strategy.id}
            onChange={(e) => {
              setPickedId(e.target.value);
              setViewId(null);
              setForm(null);
            }}
          >
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <p className="text-xs text-[var(--color-text-secondary)]">{strategy.description}</p>

        <label className={LABEL}>
          Version
          <select
            className={FIELD}
            value={current.versionId ?? ''}
            disabled={row.options.length === 0}
            onChange={(e) => {
              setForm({ ...current, versionId: e.target.value });
              setViewId(null);
            }}
          >
            {row.options.length === 0 && <option value="">No approved version yet</option>}
            {row.options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        {row.staleSelection && (
          <p className="text-xs text-[var(--color-accent-yellow)]">
            Your saved version is no longer approved, so the core will not trade it. Pick a version and save, or switch it off.
          </p>
        )}

        <div className="flex flex-wrap items-end gap-4">
          <Toggle checked={current.enabled} onChange={(on) => setForm({ ...current, enabled: on })} label="Enabled (paper)" />
          <label className={LABEL}>
            Capital allocation (₹)
            <input
              className={FIELD}
              inputMode="decimal"
              placeholder="e.g. 2,00,000"
              value={current.capitalText}
              onChange={(e) => setForm({ ...current, capitalText: e.target.value })}
            />
          </label>
          <button type="button" className={BUTTON} disabled={save.isPending || !current.versionId} onClick={onSave}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </section>

      <section className={CARD}>
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
          Blocks{shown ? ` · ${versionLabel(shown)}` : ''}
        </h2>
        {shown ? (
          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-sm">
            {describeBlocks(shown.blocks).map((line) => (
              <Fragment key={line.label}>
                <dt className="text-[var(--color-text-muted)]">{line.label}</dt>
                <dd className="text-[var(--color-text-secondary)]">{line.value}</dd>
              </Fragment>
            ))}
          </dl>
        ) : (
          <p className="text-xs text-[var(--color-text-muted)]">This strategy has no versions yet.</p>
        )}
        {shown?.notes && <p className="whitespace-pre-wrap text-xs text-[var(--color-text-muted)]">{shown.notes}</p>}
      </section>

      <section className={CARD}>
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">All versions</h2>
        <ul className="space-y-1 text-sm">
          {strategy.versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-3">
              <button type="button" className="text-[var(--color-accent-blue)] underline" onClick={() => setViewId(v.id)}>
                {versionLabel(v)}
              </button>
              <span className="text-xs text-[var(--color-text-muted)]">
                {v.approvedAt ? `approved ${new Date(v.approvedAt).toLocaleString('en-IN')}` : 'not approved'}
              </span>
              {isOwner && v.status === 'DRAFT' && (
                <button type="button" className={BUTTON} disabled={approve.isPending} onClick={() => approve.mutate(v.id)}>
                  Approve into paper
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
