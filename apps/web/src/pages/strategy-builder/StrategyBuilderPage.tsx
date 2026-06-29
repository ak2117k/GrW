import { useEffect, useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Code2,
  Blocks,
  CheckCircle,
  Save,
  FlaskConical,
  Trash2,
  FolderOpen,
  MessageSquare,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import {
  useStrategyBuilderStore,
  type IndicatorDef,
} from '@/stores/strategy-builder-store';
import { useBacktestStore } from '@/stores/backtest-store';
import { StrategyCodeEditor } from '@/components/strategy/StrategyCodeEditor';
import { IndicatorPalette } from '@/components/strategy/IndicatorPalette';
import { VisualRuleBuilder } from '@/components/strategy/VisualRuleBuilder';
import { ValidationPanel } from '@/components/strategy/ValidationPanel';
import { StrategyTemplates } from '@/components/strategy/StrategyTemplates';
import { AIStrategyReview } from '@/components/strategy/AIStrategyReview';
import { StrategyChat } from '@/components/strategy/StrategyChat';

const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'];
const SEGMENTS = ['OPTIONS', 'EQUITY', 'FUTURES', 'COMMODITY'];

export default function StrategyBuilderPage() {
  const store = useStrategyBuilderStore();
  const navigate = useNavigate();
  const updateBacktestConfig = useBacktestStore((s) => s.updateConfig);
  const [chatOpen, setChatOpen] = useState(false);

  /**
   * Quick Backtest pre-fills the backtest page with whatever we know from
   * the builder (name, timeframe, segment-derived exchange, last-30-days
   * date range) and navigates there. The backtest engine only executes
   * *registered* strategies (rsi-reversal, ema-crossover, vwap-deviation),
   * so if the builder's strategy name doesn't match one, the /backtest
   * page will show that error when the user clicks Run. It's the most
   * honest behaviour we can offer without a Pine-script runtime on the
   * backend.
   */
  const handleQuickBacktest = useCallback(() => {
    const segmentToExchange: Record<string, string> = {
      OPTIONS: 'NFO',
      EQUITY: 'NSE',
      FUTURES: 'NFO',
      COMMODITY: 'MCX',
    };
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    const isoDate = (d: Date) => d.toISOString().slice(0, 10);

    updateBacktestConfig({
      strategy: store.name.trim() || 'rsi-reversal',
      symbol: store.segment === 'OPTIONS' ? 'NIFTY' : '',
      exchange: segmentToExchange[store.segment] ?? 'NSE',
      timeframe: store.timeframe,
      startDate: isoDate(start),
      endDate: isoDate(end),
    });
    navigate('/backtest');
  }, [store.name, store.timeframe, store.segment, updateBacktestConfig, navigate]);

  useEffect(() => {
    store.fetchSavedStrategies();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleInsertCode = useCallback(
    (snippet: string) => {
      store.insertAtCursor(snippet);
    },
    [store],
  );

  const handleAddIndicator = useCallback(
    (def: IndicatorDef) => {
      store.addIndicator({
        id: `ind_${Date.now()}`,
        name: def.shortName,
        params: { ...def.defaultParams },
      });
    },
    [store],
  );

  const handleApplyFix = useCallback(
    (line: number, suggestion: string) => {
      const lines = store.code.split('\n');
      if (line > 0 && line <= lines.length) {
        lines[line - 1] = suggestion;
        store.setCode(lines.join('\n'));
        // Re-validate
        store.validateStrategy();
      }
    },
    [store],
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Code2 size={24} className="text-[var(--color-text-secondary)]" />
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            Strategy Builder
          </h1>
        </div>

        <div className="flex items-center gap-2">
          {/* Mode toggle */}
          <div className="flex items-center gap-1 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-1">
            <button
              onClick={() => store.setMode('script')}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all',
                store.mode === 'script'
                  ? 'bg-blue-500/20 text-blue-400 shadow-sm'
                  : 'text-gray-500 hover:text-gray-300',
              )}
            >
              <Code2 size={14} />
              Script
            </button>
            <button
              onClick={() => store.setMode('visual')}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all',
                store.mode === 'visual'
                  ? 'bg-blue-500/20 text-blue-400 shadow-sm'
                  : 'text-gray-500 hover:text-gray-300',
              )}
            >
              <Blocks size={14} />
              Visual
            </button>
          </div>

          {/* Chat toggle */}
          <button
            onClick={() => setChatOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-[var(--color-accent-purple,#a78bfa)]/40 bg-[var(--color-accent-purple,#a78bfa)]/10 px-3 py-1.5 text-xs font-medium text-[var(--color-accent-purple,#a78bfa)] hover:bg-[var(--color-accent-purple,#a78bfa)]/20 transition-colors"
            title="Open chat with Claude"
          >
            <MessageSquare size={14} />
            Ask Claude
          </button>
        </div>
      </div>

      {/* Main layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        {/* Left column: Editor / Visual Builder */}
        <div className="space-y-4">
          {store.mode === 'script' ? (
            <StrategyCodeEditor
              code={store.code}
              onChange={store.setCode}
              validation={store.validationResult}
            />
          ) : (
            <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
              <VisualRuleBuilder
                indicators={store.indicators}
                entryRules={store.entryRules}
                exitRules={store.exitRules}
                onUpdateEntryRule={store.updateEntryRule}
                onRemoveEntryRule={store.removeEntryRule}
                onAddEntryRule={store.addEntryRule}
                onUpdateExitRule={store.updateExitRule}
                onRemoveExitRule={store.removeExitRule}
                onAddExitRule={store.addExitRule}
                onRemoveIndicator={store.removeIndicator}
              />
            </div>
          )}

          {/* Claude's semantic review — logic, risk, missing exits, etc. */}
          <AIStrategyReview />

          {/* Rule-based validation — syntax errors, fast and precise */}
          <ValidationPanel
            result={store.validationResult}
            isValidating={store.isValidating}
            onApplyFix={handleApplyFix}
          />

          {/* Action buttons */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => store.validateStrategy()}
              disabled={store.isValidating || (!store.code && store.mode === 'script')}
              className="flex items-center gap-1.5 rounded-lg bg-gray-700 px-4 py-2 text-xs font-medium text-gray-200 hover:bg-gray-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <CheckCircle size={14} />
              Validate
            </button>
            <button
              onClick={() => store.saveStrategy()}
              disabled={store.isSaving || !store.name.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Save size={14} />
              {store.isSaving ? 'Saving...' : 'Save Strategy'}
            </button>
            <button
              onClick={handleQuickBacktest}
              disabled={!store.code && store.mode === 'script'}
              className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-xs font-medium text-emerald-400 hover:bg-emerald-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Pre-fills the backtest page with this strategy and opens it"
            >
              <FlaskConical size={14} />
              Quick Backtest
            </button>
          </div>
        </div>

        {/* Right column: Sidebar panels */}
        <div className="space-y-4">
          {/* Indicator palette */}
          <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
            <IndicatorPalette
              mode={store.mode}
              onInsertCode={handleInsertCode}
              onAddIndicator={handleAddIndicator}
            />
          </div>

          {/* Strategy settings */}
          <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
              Strategy Settings
            </h3>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-gray-500 mb-1 block">Name</label>
                <input
                  type="text"
                  value={store.name}
                  onChange={(e) => store.setName(e.target.value)}
                  placeholder="My Strategy"
                  className="w-full rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-gray-200 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 mb-1 block">Description</label>
                <input
                  type="text"
                  value={store.description}
                  onChange={(e) => store.setDescription(e.target.value)}
                  placeholder="Optional description"
                  className="w-full rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-gray-200 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-gray-500 mb-1 block">Timeframe</label>
                  <select
                    value={store.timeframe}
                    onChange={(e) => store.setTimeframe(e.target.value)}
                    className="w-full rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-gray-200 focus:border-blue-500 focus:outline-none"
                  >
                    {TIMEFRAMES.map((tf) => (
                      <option key={tf} value={tf}>
                        {tf}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 mb-1 block">Segment</label>
                  <select
                    value={store.segment}
                    onChange={(e) => store.setSegment(e.target.value)}
                    className="w-full rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-gray-200 focus:border-blue-500 focus:outline-none"
                  >
                    {SEGMENTS.map((seg) => (
                      <option key={seg} value={seg}>
                        {seg}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Templates */}
          <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
            <StrategyTemplates onLoadTemplate={store.loadTemplate} />
          </div>

          {/* Saved strategies */}
          {store.savedStrategies.length > 0 && (
            <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                Saved Strategies
              </h3>
              <div className="space-y-2 max-h-[240px] overflow-y-auto">
                {store.savedStrategies.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between rounded-lg border border-gray-700/60 bg-gray-800/30 p-2.5 group"
                  >
                    <button
                      onClick={() => store.loadStrategy(s)}
                      className="flex-1 text-left min-w-0"
                    >
                      <div className="flex items-center gap-1.5">
                        <FolderOpen size={12} className="text-gray-500 shrink-0" />
                        <span className="text-xs font-medium text-gray-300 truncate group-hover:text-blue-300 transition-colors">
                          {s.name}
                        </span>
                      </div>
                      <span className="text-[10px] text-gray-600 ml-[18px]">
                        {s.timeframe} | {s.segment}
                      </span>
                    </button>
                    <button
                      onClick={() => store.deleteStrategy(s.id)}
                      className="text-gray-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 shrink-0 ml-2"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Chat drawer (slides in from the right) */}
      <StrategyChat
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        sectionKey="strategy-chat"
        title="Strategy Chat"
        placeholder="Ask about your strategy..."
        snapshot={{
          mode: store.mode,
          name: store.name || '(untitled)',
          description: store.description || '',
          timeframe: store.timeframe,
          segment: store.segment,
          code: store.mode === 'script' ? store.code : '',
          indicators: store.mode === 'visual' ? store.indicators : [],
          entryRules: store.mode === 'visual' ? store.entryRules : [],
          exitRules: store.mode === 'visual' ? store.exitRules : [],
        }}
      />
    </div>
  );
}
