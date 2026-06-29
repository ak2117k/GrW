import { FileCode, ArrowRight } from 'lucide-react';
import { STRATEGY_TEMPLATES } from '@/stores/strategy-builder-store';
import { cn } from '@/utils/cn';

const TEMPLATE_META: Record<string, { desc: string; tags: string[] }> = {
  'RSI Reversal': {
    desc: 'Catches reversals at RSI extremes (oversold/overbought)',
    tags: ['Momentum', '15m'],
  },
  'EMA Crossover': {
    desc: 'Trend-following signals from fast/slow EMA crossover',
    tags: ['Trend', '1h'],
  },
  'MACD + RSI Combo': {
    desc: 'Combines MACD momentum with RSI confirmation',
    tags: ['Combo', '15m'],
  },
  'Bollinger Breakout': {
    desc: 'Breakout signals when price exits Bollinger Bands',
    tags: ['Volatility', '15m'],
  },
  'Supertrend Follow': {
    desc: 'Trend-following using Supertrend with ADX filter',
    tags: ['Trend', '15m'],
  },
  'VWAP Mean Reversion': {
    desc: 'Mean reversion trades at VWAP deviations',
    tags: ['Reversion', '5m'],
  },
};

interface StrategyTemplatesProps {
  onLoadTemplate: (name: string) => void;
}

export function StrategyTemplates({ onLoadTemplate }: StrategyTemplatesProps) {
  const templateNames = Object.keys(STRATEGY_TEMPLATES);

  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
        Templates
      </h3>
      <div className="space-y-2">
        {templateNames.map((name) => {
          const meta = TEMPLATE_META[name];
          return (
            <button
              key={name}
              onClick={() => onLoadTemplate(name)}
              className={cn(
                'w-full text-left rounded-lg border border-gray-700/60 bg-gray-800/30 p-3',
                'hover:border-blue-500/40 hover:bg-blue-500/5 transition-all group',
              )}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <FileCode size={14} className="text-gray-500 group-hover:text-blue-400 transition-colors" />
                  <span className="text-xs font-medium text-gray-200 group-hover:text-blue-300 transition-colors">
                    {name}
                  </span>
                </div>
                <ArrowRight size={12} className="text-gray-600 group-hover:text-blue-400 transition-colors" />
              </div>
              {meta && (
                <>
                  <p className="text-[10px] text-gray-500 ml-[22px]">{meta.desc}</p>
                  <div className="flex items-center gap-1.5 mt-1.5 ml-[22px]">
                    {meta.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full border border-gray-700/60 px-1.5 py-0.5 text-[9px] text-gray-500"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
