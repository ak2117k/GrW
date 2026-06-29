import { Sparkles, Loader2, RefreshCw, AlertCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useInsight } from '@/hooks/useInsight';

interface AIInsightCardProps {
  sectionKey: string;
  contextKey: string;
  contextData: Record<string, unknown>;
  title?: string;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function AIInsightCard({
  sectionKey,
  contextKey,
  contextData,
  title = 'AI Analysis',
}: AIInsightCardProps) {
  const { insight, isLoading, isWaiting, error, ask } = useInsight(
    sectionKey,
    contextKey,
    contextData,
  );

  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-[var(--color-accent-purple,#a78bfa)]" />
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</h3>
        </div>
        {insight?.status === 'completed' && (
          <button
            onClick={ask}
            className="flex items-center gap-1 rounded p-1 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]"
            title="Re-analyze"
          >
            <RefreshCw size={12} />
            <span>Re-analyze</span>
          </button>
        )}
      </div>

      {isLoading && (
        <div className="flex h-16 items-center justify-center text-xs text-[var(--color-text-muted)]">
          Loading...
        </div>
      )}

      {!isLoading && !insight && !error && (
        <div className="flex flex-col items-center gap-3 py-4">
          <p className="text-xs text-[var(--color-text-muted)]">No analysis yet</p>
          <button
            onClick={ask}
            className="flex items-center gap-2 rounded-md bg-[var(--color-accent-purple,#a78bfa)] px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
          >
            <Sparkles size={12} />
            Ask Claude to analyze
          </button>
        </div>
      )}

      {!isLoading && isWaiting && (
        <div className="flex flex-col items-center gap-2 py-4">
          <Loader2 size={20} className="animate-spin text-[var(--color-accent-purple,#a78bfa)]" />
          <p className="text-xs text-[var(--color-text-muted)]">Claude is analyzing...</p>
          <p className="text-[10px] text-[var(--color-text-muted)]">
            (Make sure /loop is running in your Claude Code session)
          </p>
        </div>
      )}

      {!isLoading && insight?.status === 'completed' && insight.insight && (
        <>
          <div className="text-xs leading-relaxed text-[var(--color-text-secondary)] [&_h1]:mb-2 [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-[var(--color-text-primary)] [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-[var(--color-text-primary)] [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-[var(--color-text-primary)] [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:mb-1 [&_strong]:font-semibold [&_strong]:text-[var(--color-text-primary)] [&_code]:rounded [&_code]:bg-[var(--color-bg-tertiary)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[10px]">
            <ReactMarkdown>{insight.insight}</ReactMarkdown>
          </div>
          <div className="mt-3 flex items-center justify-between text-[10px] text-[var(--color-text-muted)]">
            <span>Confidence: {insight.confidence ?? '--'}/100</span>
            <span>Last analyzed: {formatRelativeTime(insight.completedAt)}</span>
          </div>
        </>
      )}

      {!isLoading && insight?.status === 'failed' && (
        <div className="flex flex-col items-center gap-2 py-4">
          <AlertCircle size={18} className="text-[var(--color-accent-red)]" />
          <p className="text-xs text-[var(--color-accent-red)]">
            {insight.errorMessage ?? 'Analysis failed'}
          </p>
          <button
            onClick={ask}
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
          >
            Try again
          </button>
        </div>
      )}

      {!isLoading && error && !insight && (
        <div className="rounded-md bg-[var(--color-bg-tertiary)] p-2 text-xs text-[var(--color-accent-red)]">
          {error}
        </div>
      )}
    </div>
  );
}
