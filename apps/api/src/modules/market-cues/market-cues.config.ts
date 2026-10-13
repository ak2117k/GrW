/**
 * Market-cues configuration, read through ConfigService. Every key is
 * documented in `deploy/env/api.env.example`.
 *
 * MASTER SWITCH DEFAULTS OFF: nothing is fetched unless the owner sets
 * MARKET_CUES_ENABLED=true. The per-source switches default ON beneath it, so
 * enabling the master turns on every source, and one bad source can be turned
 * off on its own.
 */
export interface MarketCuesUrls {
  /** `{symbol}` is replaced (URL-encoded). */
  yahooChart: string;
  /** `{symbols}` is replaced with `%7C`-joined CNBC symbols. */
  cnbcQuote: string;
  nseFiiDii: string;
  nsdlFpi: string;
  /** `{DDMMYYYY}` is replaced with the session date. */
  nseParticipantOi: string;
  nseIx: string;
  nseMarketStatus: string;
  nseNiftyFutures: string;
  nsePreOpen: string;
}

export interface MarketCuesConfig {
  enabled: boolean;
  sources: { us: boolean; commodities: boolean; fii: boolean; fiiOi: boolean; gift: boolean; preOpen: boolean };
  timeoutMs: number;
  userAgent: string;
  accept: string;
  retryDelayMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  urls: MarketCuesUrls;
}

export const MARKET_CUES_DEFAULT_URLS: MarketCuesUrls = {
  yahooChart: 'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=5d&interval=1d',
  cnbcQuote:
    'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols={symbols}' +
    '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json',
  nseFiiDii: 'https://www.nseindia.com/api/fiidiiTradeReact',
  nsdlFpi: 'https://www.fpi.nsdl.co.in/web/Reports/Latest.aspx',
  nseParticipantOi: 'https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_{DDMMYYYY}.csv',
  nseIx: 'https://www.nseix.com/api/market-rate?type=derivative',
  nseMarketStatus: 'https://www.nseindia.com/api/marketStatus',
  nseNiftyFutures: 'https://www.nseindia.com/api/liveEquity-derivatives?index=nse50_fut',
  nsePreOpen: 'https://www.nseindia.com/api/market-data-pre-open?key=FO',
};

export const MARKET_CUES_DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const URL_ENV: Record<keyof MarketCuesUrls, string> = {
  yahooChart: 'MARKET_CUES_YAHOO_CHART_URL',
  cnbcQuote: 'MARKET_CUES_CNBC_QUOTE_URL',
  nseFiiDii: 'MARKET_CUES_NSE_FIIDII_URL',
  nsdlFpi: 'MARKET_CUES_NSDL_FPI_URL',
  nseParticipantOi: 'MARKET_CUES_NSE_PARTICIPANT_OI_URL',
  nseIx: 'MARKET_CUES_NSEIX_URL',
  nseMarketStatus: 'MARKET_CUES_NSE_MARKET_STATUS_URL',
  nseNiftyFutures: 'MARKET_CUES_NSE_NIFTY_FUTURES_URL',
  nsePreOpen: 'MARKET_CUES_NSE_PREOPEN_URL',
};

export function readMarketCuesConfig(get: (key: string) => string | undefined): MarketCuesConfig {
  const str = (k: string) => {
    const v = get(k);
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  const on = (k: string) => str(k)?.toLowerCase() !== 'false';
  const num = (k: string, d: number, min: number) => {
    const n = Number(str(k));
    return Number.isFinite(n) && n >= min ? n : d;
  };
  const urls = { ...MARKET_CUES_DEFAULT_URLS };
  for (const key of Object.keys(URL_ENV) as Array<keyof MarketCuesUrls>) {
    const v = str(URL_ENV[key]);
    if (v) urls[key] = v;
  }
  return {
    enabled: str('MARKET_CUES_ENABLED')?.toLowerCase() === 'true',
    sources: {
      us: on('MARKET_CUES_US'),
      commodities: on('MARKET_CUES_COMMODITIES'),
      fii: on('MARKET_CUES_FII'),
      fiiOi: on('MARKET_CUES_FII_OI'),
      gift: on('MARKET_CUES_GIFT'),
      preOpen: on('MARKET_CUES_PREOPEN'),
    },
    timeoutMs: num('MARKET_CUES_TIMEOUT_MS', 10_000, 500),
    userAgent: str('MARKET_CUES_USER_AGENT') ?? MARKET_CUES_DEFAULT_UA,
    accept: str('MARKET_CUES_ACCEPT') ?? 'application/json',
    retryDelayMs: num('MARKET_CUES_RETRY_DELAY_MS', 2_000, 0),
    backoffBaseMs: num('MARKET_CUES_BACKOFF_MS', 5 * 60_000, 0),
    backoffMaxMs: num('MARKET_CUES_BACKOFF_MAX_MS', 60 * 60_000, 0),
    urls,
  };
}
