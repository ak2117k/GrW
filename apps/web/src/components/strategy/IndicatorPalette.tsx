import { INDICATOR_DEFS, type IndicatorDef } from '@/stores/strategy-builder-store';
import { cn } from '@/utils/cn';
import {
  TrendingUp,
  Activity,
  BarChart3,
  Target,
  Waves,
  ArrowUpDown,
  Gauge,
  Zap,
  LineChart,
} from 'lucide-react';

const ICON_MAP: Record<string, React.ReactNode> = {
  RSI: <Gauge size={14} />,
  EMA: <TrendingUp size={14} />,
  SMA: <LineChart size={14} />,
  MACD: <Activity size={14} />,
  VWAP: <BarChart3 size={14} />,
  'Bollinger Bands': <Waves size={14} />,
  ATR: <ArrowUpDown size={14} />,
  Supertrend: <Zap size={14} />,
  ADX: <Target size={14} />,
};

interface IndicatorPaletteProps {
  mode: 'script' | 'visual';
  onInsertCode: (snippet: string) => void;
  onAddIndicator: (def: IndicatorDef) => void;
}

export function IndicatorPalette({ mode, onInsertCode, onAddIndicator }: IndicatorPaletteProps) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
        Available Indicators
      </h3>
      <div className="grid grid-cols-3 gap-2">
        {INDICATOR_DEFS.map((def) => (
          <button
            key={def.name}
            onClick={() => {
              if (mode === 'script') {
                onInsertCode(`${def.shortName.toLowerCase()} = ${def.snippet}`);
              } else {
                onAddIndicator(def);
              }
            }}
            title={def.description}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border border-gray-700/60 bg-gray-800/40 px-2.5 py-2',
              'text-xs font-medium text-gray-300 transition-all',
              'hover:border-blue-500/40 hover:bg-blue-500/10 hover:text-blue-300',
              'active:scale-95',
            )}
          >
            <span className="text-gray-500 shrink-0">
              {ICON_MAP[def.name] ?? <Activity size={14} />}
            </span>
            <span>{def.shortName}</span>
          </button>
        ))}
      </div>

      {/* Legend */}
      <div className="mt-3 space-y-1.5">
        {INDICATOR_DEFS.map((def) => (
          <div key={def.name} className="flex items-start gap-2">
            <span className="text-[10px] font-mono text-blue-400 shrink-0 w-[78px] text-right">
              {def.shortName}
            </span>
            <span className="text-[10px] text-gray-600 leading-tight">
              {def.description}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
