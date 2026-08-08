import type { SourceState, TradePlan } from '@/hooks/useChartContext';
import SetupContextCard, { type AnalysisDto } from './SetupContextCard';
import LiveQuoteCard from './LiveQuoteCard';
import MarketDepthCard from './MarketDepthCard';
import IndicatorsCard from './IndicatorsCard';
import OptionsChainPreviewCard from './OptionsChainPreviewCard';
import SymbolNewsCard from './SymbolNewsCard';
import FundamentalsCard from './FundamentalsCard';

interface Props {
  token: string;
  exchange: string;
  symbol: string;
  timeframe: string;
  analysis: AnalysisDto | null;
  analysisLoading: boolean;
  /** The server's one trade plan — the same object the chart draws from. */
  tradePlan?: TradePlan | null;
  tradePlanSource?: SourceState;
}

/**
 * Scrollable info panel shown below the chart on /charts. Each card is
 * self-contained — its own hook, its own loading state — so a slow data
 * source (e.g. options chain) doesn't gate the cards above it.
 *
 * Cards (top → bottom):
 *   1. SetupContextCard          — live setup details + Market Context
 *                                  (lifted from the old floating AnalysisPanel)
 *   2. LiveQuoteCard              — LTP, OHLC, VWAP, day-range bar
 *   3. MarketDepthCard            — 5-level bid/ask ladder, REST poll 2s
 *   4. IndicatorsCard             — RSI/MACD/EMA/BB/ROC chips
 *   5. OptionsChainPreviewCard    — ATM ± 3 strikes (hides for cash-only)
 *   6. SymbolNewsCard             — last 10 symbol-tagged headlines
 *   7. FundamentalsCard           — Yahoo-sourced sector/valuation/earnings,
 *                                   24h API cache, hides for indices/MCX
 *
 * Symbol/timeframe switches: each card refetches via its own hook; nothing
 * is shared at the panel level.
 */
export default function StockOverviewPanel({
  token,
  exchange,
  symbol,
  timeframe,
  analysis,
  analysisLoading,
  tradePlan,
  tradePlanSource,
}: Props) {
  return (
    <div className="flex flex-col gap-4 p-4 max-w-full">
      <SetupContextCard
        analysis={analysis}
        loading={analysisLoading}
        tradePlan={tradePlan}
        tradePlanSource={tradePlanSource}
      />
      <LiveQuoteCard token={token} exchange={exchange} symbol={symbol} />
      <MarketDepthCard token={token} exchange={exchange} />
      <IndicatorsCard token={token} exchange={exchange} timeframe={timeframe} />
      <OptionsChainPreviewCard symbol={symbol} token={token} exchange={exchange} />
      <SymbolNewsCard symbol={symbol} />
      <FundamentalsCard symbol={symbol} exchange={exchange} />
    </div>
  );
}
