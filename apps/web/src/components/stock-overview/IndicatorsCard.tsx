import clsx from 'clsx';
import { useIndicators } from '@/hooks/useIndicators';
import { Card } from './_shared';

interface Props {
  token: string;
  exchange: string;
  timeframe: string;
}

/**
 * Card 4: Five indicator chips for the current (instrument, timeframe).
 *
 * Backend computes indicator alignment in the SETUP direction when called
 * from analyze(); when called standalone (no setup), the alignment is
 * relative to the most recent close-vs-prev-close direction. The chip
 * borders are tinted by alignment (1 = aligned/green, -1 = opposed/red,
 * 0 = neutral/zinc).
 */
export default function IndicatorsCard({ token, exchange, timeframe }: Props) {
  const { indicators: ind, loading } = useIndicators(token, exchange, timeframe);

  if (!ind && loading) {
    return (
      <Card title="Indicators">
        <p className="text-sm text-zinc-500">Loading...</p>
      </Card>
    );
  }
  if (!ind) {
    return (
      <Card title="Indicators">
        <p className="text-sm text-zinc-500">
          Indicators unavailable (need at least 30 candles).
        </p>
      </Card>
    );
  }

  return (
    <Card title="Indicators">
      <div className="flex flex-wrap gap-2">
        <Chip
          label="RSI14"
          value={ind.rsi14 !== null ? ind.rsi14.toFixed(1) : '—'}
          alignment={ind.alignment.rsi}
        />
        <Chip
          label="MACD-H"
          value={
            ind.macdHistogram !== null
              ? `${ind.macdHistogram >= 0 ? '+' : ''}${ind.macdHistogram.toFixed(2)}`
              : '—'
          }
          alignment={ind.alignment.macd}
        />
        <Chip
          label="EMA9/21"
          value={
            ind.ema9 != null && ind.ema21 != null
              ? ind.ema9 > ind.ema21
                ? '↑ above'
                : ind.ema9 < ind.ema21
                  ? '↓ below'
                  : '= equal'
              : '—'
          }
          alignment={ind.alignment.ema}
        />
        <Chip
          label="BB pos"
          value={ind.bollingerPosition !== null ? ind.bollingerPosition.toFixed(2) : '—'}
          alignment={ind.alignment.bollinger}
        />
        <Chip
          label="ROC10"
          value={
            ind.roc10 !== null
              ? `${ind.roc10 >= 0 ? '+' : ''}${ind.roc10.toFixed(1)}%`
              : '—'
          }
          alignment={ind.alignment.momentum}
        />
      </div>
      <div className="text-xs text-zinc-500 mt-3">
        Agreement: <span className="tabular-nums text-zinc-300">{ind.agreement}</span> / 5
      </div>
    </Card>
  );
}

function Chip({
  label,
  value,
  alignment,
}: {
  label: string;
  value: string;
  alignment: 1 | 0 | -1;
}) {
  const tone =
    alignment === 1
      ? 'border-emerald-700 bg-emerald-500/5 text-emerald-300'
      : alignment === -1
        ? 'border-red-700 bg-red-500/5 text-red-300'
        : 'border-zinc-700 text-zinc-300';
  return (
    <div
      className={clsx(
        'px-2.5 py-1.5 rounded-md border text-xs flex items-center gap-2',
        tone,
      )}
    >
      <span className="text-zinc-500 uppercase tracking-wider text-[10px]">{label}</span>
      <span className="tabular-nums font-medium">{value}</span>
    </div>
  );
}
