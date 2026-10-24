import { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, Lightbulb, Loader2, Lock, X, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import { useStrategyBuilderStore } from '@/stores/strategy-builder-store';
import { useBacktestStore } from '@/stores/backtest-store';
import { checkStrategy, getStrategyAiStatus, reviewStrategy, suggestStrategy } from '@/services/strategy-ai';
import { StrategyChecklist } from './StrategyChecklist';
import { StrategyAiReviewCard } from './StrategyAiReviewCard';
import {
  backtestAggregates,
  buildState,
  createClickGate,
  editLabel,
  outcomeMessage,
  type AiEdit,
  type AiStatus,
  type CheckReport,
  type StrategyReview,
  type StrategySuggestions,
} from './strategyAi';

const CHECK_DEBOUNCE_MS = 700;
const AI_CLICK_GAP_MS = 1_500;

function errorText(err: unknown): string {
  const e = err as { response?: { status?: number; data?: { message?: string } }; message?: string };
  if (e?.response?.status === 403) return 'AI review is available to the account owner only.';
  return e?.response?.data?.message ?? e?.message ?? 'Request failed';
}

/**
 * Checklist (everyone) + "Review with Claude" / "Suggest" (owner only).
 *
 * Claude is only ever called from an explicit button click — never on a
 * keystroke or auto-save — and each button allows one request in flight. The
 * server enforces the real guard rails (owner, checks, guard, cache, cooldown,
 * daily cap); this component just never asks when the answer is known to be no.
 */
export function StrategyAssistant() {
  const s = useStrategyBuilderStore();
  const applyAiEdit = useStrategyBuilderStore((st) => st.applyAiEdit);
  const lastBacktestConfig = useBacktestStore((b) => b.config);
  const lastBacktestResults = useBacktestStore((b) => b.results);

  const state = useMemo(
    () =>
      buildState({
        mode: s.mode,
        name: s.name,
        description: s.description,
        timeframe: s.timeframe,
        segment: s.segment,
        instrument: s.instrument,
        code: s.code,
        indicators: s.indicators,
        entryRules: s.entryRules,
        exitRules: s.exitRules,
        settings: s.settings,
      }),
    [s.mode, s.name, s.description, s.timeframe, s.segment, s.instrument, s.code, s.indicators, s.entryRules, s.exitRules, s.settings],
  );
  const stateKey = useMemo(() => JSON.stringify(state), [state]);

  // ── deterministic checklist (debounced, free) ─────────────────────
  const [report, setReport] = useState<CheckReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setChecking(true);
      checkStrategy(state, ctrl.signal)
        .then((r) => {
          setReport(r.checks);
          setAi(r.ai);
          setCheckError(null);
        })
        .catch((err) => {
          if (!ctrl.signal.aborted) setCheckError(`Could not run checks: ${errorText(err)}`);
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setChecking(false);
        });
    }, CHECK_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [stateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    getStrategyAiStatus().then(setAi).catch(() => setAi({ allowed: false, remaining: 0, dailyCap: 0 }));
  }, []);

  // ── Claude review / suggest (owner only, explicit clicks) ──────────
  const gate = useRef(createClickGate(AI_CLICK_GAP_MS));
  const [busy, setBusy] = useState<'review' | 'suggest' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [review, setReview] = useState<{ review: StrategyReview; cached: boolean; key: string } | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [suggestions, setSuggestions] = useState<StrategySuggestions | null>(null);

  const allowed = ai?.allowed === true;
  const hasErrors = !report || report.errors > 0;
  const outOfCalls = allowed && ai !== null && ai.remaining <= 0;

  const onReview = () =>
    gate.current.run(async () => {
      setBusy('review');
      setMessage(null);
      try {
        const bt = backtestAggregates(s.name, lastBacktestConfig, lastBacktestResults);
        const out = await reviewStrategy(state, bt);
        setAi(out.ai);
        if (out.status === 'ok' || out.status === 'cached') {
          setReview({ review: out.result, cached: out.status === 'cached', key: stateKey });
          setApplied(new Set());
        } else {
          setMessage(outcomeMessage(out));
        }
      } catch (err) {
        setMessage(errorText(err));
      } finally {
        setBusy(null);
      }
    });

  const onSuggest = () =>
    gate.current.run(async () => {
      setBusy('suggest');
      setMessage(null);
      try {
        const out = await suggestStrategy(state);
        setAi(out.ai);
        if (out.status === 'ok' || out.status === 'cached') setSuggestions(out.result);
        else setMessage(outcomeMessage(out));
      } catch (err) {
        setMessage(errorText(err));
      } finally {
        setBusy(null);
      }
    });

  const applyReviewEdit = (e: AiEdit) => {
    if (applyAiEdit(e)) {
      setApplied((prev) => new Set(prev).add(e.field));
      toast.success(`Applied: ${editLabel(e)}`);
    }
  };

  const acceptSuggestion = (e: AiEdit) => {
    if (applyAiEdit(e, { onlyIfEmpty: true })) toast.success(`Filled: ${editLabel(e)}`);
    else toast.error('That field is no longer empty — suggestion skipped.');
    dismissSuggestion(e);
  };
  const dismissSuggestion = (e: AiEdit) =>
    setSuggestions((prev) => (prev ? { ...prev, edits: prev.edits.filter((x) => x.field !== e.field) } : prev));

  const btn =
    'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div className="space-y-4">
      <StrategyChecklist report={report} loading={checking} error={checkError} />

      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wide">
            <Sparkles size={14} />
            Claude
          </h3>
          {allowed ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] text-gray-500">
                {ai?.remaining ?? 0}/{ai?.dailyCap ?? 0} AI calls left today
              </span>
              <button
                onClick={onSuggest}
                disabled={busy !== null || outOfCalls}
                title="Propose values for empty fields only"
                className={`${btn} border border-blue-500/40 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20`}
              >
                {busy === 'suggest' ? <Loader2 size={14} className="animate-spin" /> : <Lightbulb size={14} />}
                Suggest
              </button>
              <button
                onClick={onReview}
                disabled={busy !== null || hasErrors || outOfCalls}
                title={hasErrors ? 'Fix the failing checks first' : 'Ask Claude to review this strategy'}
                className={`${btn} border border-purple-500/40 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20`}
              >
                {busy === 'review' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                Review with Claude
              </button>
            </div>
          ) : (
            <button disabled title="Claude features are limited to the account owner for now" className={`${btn} border border-gray-700 text-gray-500`}>
              <Lock size={14} />
              AI review (owner only)
            </button>
          )}
        </div>

        {allowed && hasErrors && !review && <p className="text-[11px] text-gray-500">Review unlocks once the checks above have no errors.</p>}
        {!allowed && <p className="text-[11px] text-gray-500">The checklist above is free and always on.</p>}
        {message && <p className="text-xs text-amber-300">{message}</p>}

        {suggestions && (
          <div className="space-y-1.5">
            <h4 className="text-[10px] font-semibold uppercase tracking-wide text-blue-300">Suggestions for empty fields</h4>
            {suggestions.edits.length === 0 && <p className="text-xs text-gray-500">{suggestions.note || 'No suggestions.'}</p>}
            {suggestions.edits.map((e) => (
              <div key={e.field} className="flex items-start justify-between gap-2 rounded-md border border-gray-700/60 bg-gray-800/30 p-2">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-gray-200">{editLabel(e)}</div>
                  {e.reason && <div className="text-[11px] text-gray-500">{e.reason}</div>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button onClick={() => acceptSuggestion(e)} className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-1 text-emerald-300 hover:bg-emerald-500/20" title="Accept">
                    <Check size={12} />
                  </button>
                  <button onClick={() => dismissSuggestion(e)} className="rounded-md border border-gray-600 p-1 text-gray-400 hover:bg-gray-700" title="Dismiss">
                    <X size={12} />
                  </button>
                </div>
              </div>
            ))}
            {suggestions.edits.length > 0 && suggestions.note && <p className="text-[10px] italic text-gray-500">{suggestions.note}</p>}
          </div>
        )}

        {review && (
          <>
            {review.key !== stateKey && <p className="text-[11px] text-amber-300/80">The strategy changed since this review.</p>}
            <StrategyAiReviewCard review={review.review} cached={review.cached} applied={applied} onApply={applyReviewEdit} />
          </>
        )}
      </div>
    </div>
  );
}
