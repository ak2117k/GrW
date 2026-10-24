import { CheckCircle, XCircle, AlertTriangle, ListChecks } from 'lucide-react';
import type { CheckReport, CheckStatus } from './strategyAi';

function Icon({ status }: { status: CheckStatus }) {
  if (status === 'pass') return <CheckCircle size={14} className="text-emerald-400 shrink-0 mt-0.5" />;
  if (status === 'error') return <XCircle size={14} className="text-red-400 shrink-0 mt-0.5" />;
  return <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />;
}

interface Props {
  report: CheckReport | null;
  loading: boolean;
  error: string | null;
}

/** The deterministic checklist (free, every user). Server-computed; updates as the strategy changes. */
export function StrategyChecklist({ report, loading, error }: Props) {
  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wide">
          <ListChecks size={14} />
          Strategy checks
        </h3>
        {loading ? (
          <span className="text-[10px] text-gray-500">checking…</span>
        ) : report ? (
          <span className="text-[10px] text-gray-500">
            {report.errors > 0 ? (
              <span className="text-red-400">{report.errors} to fix</span>
            ) : (
              <span className="text-emerald-400">no blocking issues</span>
            )}
            {report.warnings > 0 && <span className="text-amber-400"> · {report.warnings} warning{report.warnings > 1 ? 's' : ''}</span>}
          </span>
        ) : null}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {!report && !error && <p className="text-xs text-gray-600 italic">Start building — checks run as you edit.</p>}
      {report && (
        <ul className="space-y-1.5">
          {report.items.map((it) => (
            <li key={it.id} className="flex items-start gap-2">
              <Icon status={it.status} />
              <div className="min-w-0">
                <span className="text-xs text-gray-300">{it.label}</span>
                {it.details.length > 0 && (
                  <ul className="mt-0.5 space-y-0.5">
                    {it.details.map((d) => (
                      <li
                        key={d}
                        className={
                          it.status === 'error' ? 'text-[11px] text-red-300/90' : it.status === 'warn' ? 'text-[11px] text-amber-300/90' : 'text-[11px] text-gray-500'
                        }
                      >
                        {d}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
