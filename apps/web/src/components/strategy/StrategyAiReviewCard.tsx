import { Check, Wand2 } from 'lucide-react';
import { editLabel, type AiEdit, type StrategyReview } from './strategyAi';

interface Props {
  review: StrategyReview;
  cached: boolean;
  applied: ReadonlySet<string>;
  onApply: (edit: AiEdit) => void;
}

function List({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className={`text-[10px] font-semibold uppercase tracking-wide mb-1 ${tone}`}>{title}</h4>
      <ul className="list-disc pl-4 space-y-0.5">
        {items.map((s) => (
          <li key={s} className="text-xs text-gray-300">
            {s}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Claude's review of a strategy, with one-click "apply" for each suggested edit. */
export function StrategyAiReviewCard({ review, cached, applied, onApply }: Props) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-gray-500">
          Confidence in this review: {review.confidence}/100{cached && ' · cached answer (no new call)'}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-gray-200">{review.summary}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <List title="Strengths" items={review.strengths} tone="text-emerald-400" />
        <List title="Risks" items={review.risks} tone="text-red-400" />
        <List title="Works in" items={review.regimes.worksIn} tone="text-blue-400" />
        <List title="Struggles in" items={review.regimes.failsIn} tone="text-amber-400" />
      </div>
      {review.suggestions.length > 0 && (
        <div>
          <h4 className="text-[10px] font-semibold uppercase tracking-wide mb-1 text-purple-300">Suggested edits</h4>
          <ul className="space-y-1.5">
            {review.suggestions.map((e) => {
              const done = applied.has(e.field);
              return (
                <li key={e.field} className="flex items-start justify-between gap-2 rounded-md border border-gray-700/60 bg-gray-800/30 p-2">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-gray-200">{editLabel(e)}</div>
                    {e.reason && <div className="text-[11px] text-gray-500">{e.reason}</div>}
                  </div>
                  <button
                    onClick={() => onApply(e)}
                    disabled={done}
                    className="flex shrink-0 items-center gap-1 rounded-md border border-purple-500/40 bg-purple-500/10 px-2 py-1 text-[11px] text-purple-300 hover:bg-purple-500/20 disabled:opacity-50"
                  >
                    {done ? <Check size={12} /> : <Wand2 size={12} />}
                    {done ? 'Applied' : 'Apply'}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p className="text-[10px] italic text-gray-500">{review.disclaimer}</p>
    </div>
  );
}
