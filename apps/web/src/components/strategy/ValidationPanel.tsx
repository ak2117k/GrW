import { CheckCircle, XCircle, AlertTriangle, Wand2 } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { ParseResult, ValidationItem } from '@/stores/strategy-builder-store';

interface ValidationPanelProps {
  result: ParseResult | null;
  isValidating: boolean;
  onApplyFix: (line: number, suggestion: string) => void;
}

function ValidationIcon({ type }: { type: ValidationItem['type'] }) {
  switch (type) {
    case 'success':
      return <CheckCircle size={14} className="text-emerald-400 shrink-0" />;
    case 'error':
      return <XCircle size={14} className="text-red-400 shrink-0" />;
    case 'warning':
      return <AlertTriangle size={14} className="text-amber-400 shrink-0" />;
  }
}

export function ValidationPanel({ result, isValidating, onApplyFix }: ValidationPanelProps) {
  if (isValidating) {
    return (
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          <span className="text-xs text-gray-400">Validating strategy...</span>
        </div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
        <p className="text-xs text-gray-600 italic">
          Click "Validate" to check your strategy for errors and warnings.
        </p>
      </div>
    );
  }

  const errorCount = result.items.filter((i) => i.type === 'error').length;
  const warnCount = result.items.filter((i) => i.type === 'warning').length;
  const successCount = result.items.filter((i) => i.type === 'success').length;

  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
      {/* Summary */}
      <div className="flex items-center gap-3 mb-3">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
          Validation Results
        </h3>
        <div className="flex items-center gap-3 ml-auto">
          {successCount > 0 && (
            <span className="text-[10px] text-emerald-400">
              {successCount} passed
            </span>
          )}
          {warnCount > 0 && (
            <span className="text-[10px] text-amber-400">
              {warnCount} warning{warnCount > 1 ? 's' : ''}
            </span>
          )}
          {errorCount > 0 && (
            <span className="text-[10px] text-red-400">
              {errorCount} error{errorCount > 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      {/* Status banner */}
      <div
        className={cn(
          'rounded-md px-3 py-2 mb-3 text-xs font-medium',
          result.valid
            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
            : 'bg-red-500/10 text-red-400 border border-red-500/20',
        )}
      >
        {result.valid
          ? 'Strategy is valid and ready to save or backtest.'
          : 'Strategy has errors that need to be fixed.'}
      </div>

      {/* Items */}
      {result.items.length > 0 && (
        <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
          {result.items.map((item, idx) => (
            <div
              key={idx}
              className={cn(
                'flex items-start gap-2 rounded-md px-2.5 py-1.5 text-xs',
                item.type === 'error' && 'bg-red-500/5',
                item.type === 'warning' && 'bg-amber-500/5',
              )}
            >
              <ValidationIcon type={item.type} />
              <div className="flex-1 min-w-0">
                <span className="text-gray-500 mr-1.5">
                  {item.line > 0 ? `Line ${item.line}:` : ''}
                </span>
                <span
                  className={cn(
                    item.type === 'success' && 'text-gray-300',
                    item.type === 'error' && 'text-red-300',
                    item.type === 'warning' && 'text-amber-300',
                  )}
                >
                  {item.message}
                </span>
              </div>
              {item.suggestion && (
                <button
                  onClick={() => onApplyFix(item.line, item.suggestion!)}
                  className="flex items-center gap-1 shrink-0 rounded-md border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-400 hover:bg-blue-500/20 transition-colors"
                >
                  <Wand2 size={10} />
                  Apply Fix
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
