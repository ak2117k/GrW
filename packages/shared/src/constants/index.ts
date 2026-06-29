// ============================================
// Trading Constants
// ============================================

// Indian market hours (IST)
export const MARKET_OPEN_HOUR = 9;
export const MARKET_OPEN_MINUTE = 15;
export const MARKET_CLOSE_HOUR = 15;
export const MARKET_CLOSE_MINUTE = 30;

// Pre-market session
export const PRE_MARKET_OPEN_HOUR = 9;
export const PRE_MARKET_OPEN_MINUTE = 0;

// MCX market hours
export const MCX_OPEN_HOUR = 9;
export const MCX_OPEN_MINUTE = 0;
export const MCX_CLOSE_HOUR = 23;
export const MCX_CLOSE_MINUTE = 30;

// Major indices tokens (Angel One)
export const INDICES = {
  NIFTY_50: { symbol: 'NIFTY', token: '99926000', exchange: 'NSE' },
  BANK_NIFTY: { symbol: 'BANKNIFTY', token: '99926009', exchange: 'NSE' },
  FIN_NIFTY: { symbol: 'FINNIFTY', token: '99926037', exchange: 'NSE' },
  SENSEX: { symbol: 'SENSEX', token: '99919000', exchange: 'BSE' },
  NIFTY_MIDCAP: { symbol: 'NIFTY MIDCAP 50', token: '99926025', exchange: 'NSE' },
  NIFTY_IT: { symbol: 'NIFTY IT', token: '99926013', exchange: 'NSE' },
} as const;

// Sector index tokens (Angel One NSE)
export const SECTOR_INDICES = {
  NIFTY_IT: { symbol: 'NIFTY IT', token: '99926013', exchange: 'NSE', sector: 'IT' },
  NIFTY_BANK: { symbol: 'NIFTY BANK', token: '99926009', exchange: 'NSE', sector: 'Banking' },
  NIFTY_PHARMA: { symbol: 'NIFTY PHARMA', token: '99926017', exchange: 'NSE', sector: 'Pharma' },
  NIFTY_AUTO: { symbol: 'NIFTY AUTO', token: '99926021', exchange: 'NSE', sector: 'Auto' },
  NIFTY_FMCG: { symbol: 'NIFTY FMCG', token: '99926015', exchange: 'NSE', sector: 'FMCG' },
  NIFTY_METAL: { symbol: 'NIFTY METAL', token: '99926023', exchange: 'NSE', sector: 'Metal' },
  NIFTY_ENERGY: { symbol: 'NIFTY ENERGY', token: '99926019', exchange: 'NSE', sector: 'Energy' },
  NIFTY_REALTY: { symbol: 'NIFTY REALTY', token: '99926027', exchange: 'NSE', sector: 'Realty' },
  NIFTY_INFRA: { symbol: 'NIFTY INFRA', token: '99926029', exchange: 'NSE', sector: 'Infra' },
  NIFTY_MEDIA: { symbol: 'NIFTY MEDIA', token: '99926031', exchange: 'NSE', sector: 'Media' },
  NIFTY_PSU_BANK: { symbol: 'NIFTY PSU BANK', token: '99926033', exchange: 'NSE', sector: 'PSU Bank' },
  NIFTY_PVT_BANK: { symbol: 'NIFTY PVT BANK', token: '99926035', exchange: 'NSE', sector: 'Pvt Bank' },
  NIFTY_FIN_SERVICE: { symbol: 'NIFTY FIN SERVICE', token: '99926011', exchange: 'NSE', sector: 'Fin Services' },
  NIFTY_HEALTHCARE: { symbol: 'NIFTY HEALTHCARE', token: '99926041', exchange: 'NSE', sector: 'Healthcare' },
  NIFTY_CONSUMER: { symbol: 'NIFTY CONSUMER', token: '99926039', exchange: 'NSE', sector: 'Consumer' },
} as const;

// Major stocks for watchlist/polling (Angel One NSE)
export const MAJOR_STOCKS = {
  RELIANCE: { symbol: 'RELIANCE', token: '2885', exchange: 'NSE' },
  TCS: { symbol: 'TCS', token: '11536', exchange: 'NSE' },
  HDFCBANK: { symbol: 'HDFCBANK', token: '1333', exchange: 'NSE' },
  INFY: { symbol: 'INFY', token: '1594', exchange: 'NSE' },
  ICICIBANK: { symbol: 'ICICIBANK', token: '4963', exchange: 'NSE' },
} as const;

// Major MCX commodity futures tokens (Angel One)
// These are current front-month contract tokens. MCX futures tokens change
// every month with contract expiry — the backend also tries to resolve them
// dynamically at startup. Update these when contracts roll over.
export const COMMODITIES: Record<string, { symbol: string; token: string; exchange: string; sector: string }> = {
  GOLD: { symbol: 'GOLD', token: '477904', exchange: 'MCX', sector: 'Gold' },         // GOLDM03APR26FUT
  SILVER: { symbol: 'SILVER', token: '457532', exchange: 'MCX', sector: 'Silver' },    // SILVER05MAY26FUT
  CRUDEOIL: { symbol: 'CRUDEOIL', token: '488290', exchange: 'MCX', sector: 'Crude Oil' },    // CRUDEOIL19MAY26FUT — rolled 2026-05-07 (April expired)
  NATURALGAS: { symbol: 'NATURALGAS', token: '538685', exchange: 'MCX', sector: 'Natural Gas' }, // NATURALGAS28JUL26FUT
  COPPER: { symbol: 'COPPER', token: '488791', exchange: 'MCX', sector: 'Copper' },     // COPPER30APR26FUT
};

// Candle timeframes
export const TIMEFRAMES = {
  ONE_MIN: '1m',
  FIVE_MIN: '5m',
  FIFTEEN_MIN: '15m',
  THIRTY_MIN: '30m',
  ONE_HOUR: '1h',
  FOUR_HOUR: '4h',
  DAILY: '1d',
  WEEKLY: '1w',
} as const;

// Risk management defaults
export const DEFAULT_MAX_DAILY_LOSS = 5000; // INR
export const DEFAULT_MAX_CAPITAL_PER_TRADE = 200000; // INR
export const DEFAULT_MAX_CONCURRENT_POSITIONS = 10;
export const DEFAULT_RISK_REWARD_RATIO = 2; // 1:2 minimum
export const DEFAULT_STOPLOSS_PERCENT = 2; // 2% of entry

// Angel One API limits
export const ANGEL_ONE_MAX_REQUESTS_PER_SEC = 10;
export const ANGEL_ONE_WEBSOCKET_MAX_TOKENS = 50;

// Application
export const API_PREFIX = '/api';
export const WS_NAMESPACE = '/ws';
