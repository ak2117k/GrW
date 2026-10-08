import type { HubCandleSource } from '../hub-candle-source';
import { isHubExchange } from '../hub.types';
import { isTimeframe, type CandlesResult } from './candle.types';

export interface ChartRequest {
  token: string;
  exchange: string;
  symbol: string;
  timeframe: string;
  from: Date;
  to: Date;
}

export interface ChartResponse {
  token: string;
  symbol: string;
  timeframe: string;
  candles: Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number }>;
  count: number;
  source: 'hub';
  incomplete: Array<{ from: string; to: string; reason: string }>;
}

function toChartResponse(req: ChartRequest, r: CandlesResult): ChartResponse {
  return {
    token: req.token,
    symbol: req.symbol,
    timeframe: req.timeframe,
    candles: r.candles.map((c) => ({
      timestamp: new Date(c.ts), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    })),
    count: r.candles.length,
    source: 'hub',
    incomplete: r.incomplete.map((i) => ({
      from: new Date(i.from).toISOString(), to: new Date(i.to).toISOString(), reason: i.reason,
    })),
  };
}

/**
 * SP1 M2 switch for GET /api/market-data/instruments/:token/candles. Returns
 * the hub's answer, or null to mean "use the legacy path": no hub in this
 * container, HUB_SERVES_CHARTS off, an exchange/timeframe the hub does not
 * serve, or any hub failure (revert-safe by construction).
 */
export async function serveChartFromHub(
  hub: HubCandleSource | null,
  req: ChartRequest,
  warn: (msg: string) => void,
): Promise<ChartResponse | null> {
  const exchange = req.exchange.toUpperCase();
  if (!hub || !hub.servesCharts() || !isHubExchange(exchange) || !isTimeframe(req.timeframe)) return null;
  try {
    const result = await hub.candles({ exchange, token: req.token, symbol: req.symbol }, req.timeframe, req.from, req.to);
    return toChartResponse(req, result);
  } catch (err) {
    warn(
      `Hub candles failed for ${exchange}:${req.token} ${req.timeframe}: ` +
        `${err instanceof Error ? err.message : String(err)}; using the legacy path`,
    );
    return null;
  }
}
