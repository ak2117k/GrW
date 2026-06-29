import { useMemo } from 'react';
import AIInsightCard from '@/components/ai/AIInsightCard';
import {
  useStrategyBuilderStore,
  type IndicatorConfig,
  type RuleConfig,
} from '@/stores/strategy-builder-store';

/**
 * Stable fingerprint of the current strategy so the insight cache keys
 * correctly: the same strategy reuses a prior Claude review; a single
 * character change invalidates and triggers a fresh review on next click.
 *
 * The hash is a djb2 (cheap, deterministic, collision-tolerant for this
 * scale). We prefix the mode so script vs visual don't collide.
 */
function fingerprintStrategy(args: {
  mode: 'script' | 'visual';
  code: string;
  name: string;
  description: string;
  timeframe: string;
  segment: string;
  indicators: IndicatorConfig[];
  entryRules: RuleConfig[];
  exitRules: RuleConfig[];
}): string {
  const payload =
    args.mode === 'script'
      ? args.code
      : JSON.stringify({
          indicators: args.indicators,
          entry: args.entryRules,
          exit: args.exitRules,
        });
  const core = `${args.mode}|${args.timeframe}|${args.segment}|${payload}`;
  let h = 5381;
  for (let i = 0; i < core.length; i++) {
    h = ((h << 5) + h + core.charCodeAt(i)) | 0;
  }
  return `${args.mode}-${Math.abs(h).toString(36)}`;
}

export function AIStrategyReview() {
  const mode = useStrategyBuilderStore((s) => s.mode);
  const code = useStrategyBuilderStore((s) => s.code);
  const name = useStrategyBuilderStore((s) => s.name);
  const description = useStrategyBuilderStore((s) => s.description);
  const timeframe = useStrategyBuilderStore((s) => s.timeframe);
  const segment = useStrategyBuilderStore((s) => s.segment);
  const indicators = useStrategyBuilderStore((s) => s.indicators);
  const entryRules = useStrategyBuilderStore((s) => s.entryRules);
  const exitRules = useStrategyBuilderStore((s) => s.exitRules);

  const { contextKey, contextData, isEmpty } = useMemo(() => {
    const empty =
      mode === 'script'
        ? code.trim().length === 0
        : indicators.length === 0 && entryRules.length === 0 && exitRules.length === 0;

    const key = fingerprintStrategy({
      mode,
      code,
      name,
      description,
      timeframe,
      segment,
      indicators,
      entryRules,
      exitRules,
    });

    const data = {
      mode,
      name: name || '(untitled)',
      description: description || '',
      timeframe,
      segment,
      code: mode === 'script' ? code : '',
      indicators: mode === 'visual' ? indicators : [],
      entryRules: mode === 'visual' ? entryRules : [],
      exitRules: mode === 'visual' ? exitRules : [],
    };
    return { contextKey: key, contextData: data, isEmpty: empty };
  }, [mode, code, name, description, timeframe, segment, indicators, entryRules, exitRules]);

  if (isEmpty) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
        <p className="text-xs text-[var(--color-text-muted)]">
          Write some code (script mode) or add indicators and rules (visual mode) to enable Claude's review.
        </p>
      </div>
    );
  }

  return (
    <AIInsightCard
      sectionKey="strategy-review"
      contextKey={contextKey}
      contextData={contextData}
      title="Claude's Review"
    />
  );
}
