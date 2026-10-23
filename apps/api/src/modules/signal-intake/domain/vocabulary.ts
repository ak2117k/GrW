/**
 * The instrument vocabulary the free pre-filter and the rule parser match against.
 *
 * Indices (and their tip-channel aliases) and MCX commodities are fixed here; stocks come from the
 * `instruments` table (NSE/BSE cash, refreshed daily from the Angel master) at runtime. A symbol
 * shorter than 3 letters, or one that is also a common English / Hinglish word ("IT", "ONE", "SBI"
 * is fine, "GOOD" is not a listed symbol but "BEL" / "ABB" are), is only accepted next to a strike
 * or a CE/PE/FUT marker — see {@link AMBIGUOUS_SYMBOLS}.
 */

export type UnderlyingClass = 'INDEX' | 'STOCK' | 'COMMODITY';

/** The token `normalise` puts in place of a non-tradeable sector / broad index ("NIFTY IT"). */
export const SECTOR_INDEX_TOKEN = 'SECTORINDEX';

export interface Vocabulary {
  /** Upper-case token → canonical underlying name. */
  readonly names: ReadonlyMap<string, string>;
  /** Canonical name → its class. */
  readonly classOf: ReadonlyMap<string, UnderlyingClass>;
}

/**
 * Index underlyings WITH listed derivatives (the instrument master's `name`) and the aliases tip
 * channels use for them. Sector / broad indices without derivatives (Nifty IT, Pharma, Auto, Metal,
 * Realty, FMCG, PSU Bank, Midcap 100 …) are deliberately absent: `normalise` turns them into
 * {@link SECTOR_INDEX_TOKEN}, so "Nifty IT" can never resolve to NIFTY (prod 2026-10-23 false positive).
 */
export const INDEX_ALIASES: Readonly<Record<string, readonly string[]>> = {
  NIFTY: ['NIFTY', 'NIFTY50', 'NF'],
  BANKNIFTY: ['BANKNIFTY', 'BNF', 'BN', 'BANK NIFTY', 'NIFTYBANK', 'NIFTY BANK', 'BANKNIFT'],
  FINNIFTY: ['FINNIFTY', 'FN', 'FIN NIFTY', 'FINIFTY', 'NIFTY FIN SERVICE', 'NIFTY FIN SERVICES', 'NIFTY FINANCIAL SERVICES', 'NIFTY FIN', 'NIFTYFIN'],
  MIDCPNIFTY: ['MIDCPNIFTY', 'MIDCAPNIFTY', 'MIDCAP NIFTY', 'MIDCP NIFTY', 'NIFTY MIDCAP SELECT', 'NIFTY MID SELECT', 'MIDCAP SELECT', 'MIDCAPSELECT'],
  NIFTYNXT50: ['NIFTYNXT50', 'NIFTY NEXT 50', 'NIFTY NEXT50', 'NIFTYNEXT50', 'NIFTY NXT 50', 'NIFTY JUNIOR'],
  SENSEX: ['SENSEX', 'SX', 'BSE SENSEX'],
  BANKEX: ['BANKEX'],
};

export const COMMODITY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  CRUDEOIL: ['CRUDEOIL', 'CRUDE', 'CRUDE OIL', 'CRUDEOILM'],
  NATURALGAS: ['NATURALGAS', 'NATURAL GAS', 'NATGAS', 'NG'],
  GOLD: ['GOLD', 'GOLDM'],
  SILVER: ['SILVER', 'SILVERM'],
  COPPER: ['COPPER'],
  ZINC: ['ZINC'],
};

/** Common stock aliases on tip channels (target = NSE cash symbol). */
export const STOCK_ALIASES: Readonly<Record<string, string>> = {
  'TATA MOTORS': 'TATAMOTORS',
  'TATA STEEL': 'TATASTEEL',
  'TATA POWER': 'TATAPOWER',
  'BAJAJ FINANCE': 'BAJFINANCE',
  BAJAJFINANCE: 'BAJFINANCE',
  'BAJAJ FINSERV': 'BAJAJFINSV',
  'HDFC BANK': 'HDFCBANK',
  'ICICI BANK': 'ICICIBANK',
  'AXIS BANK': 'AXISBANK',
  'KOTAK BANK': 'KOTAKBANK',
  'SBI': 'SBIN',
  'STATE BANK': 'SBIN',
  'M&M': 'M&M',
  'L&T': 'LT',
  'HINDUSTAN UNILEVER': 'HINDUNILVR',
  RIL: 'RELIANCE',
  'ADANI ENT': 'ADANIENT',
  'ADANI PORTS': 'ADANIPORTS',
  INFOSYS: 'INFY',
  'SUN PHARMA': 'SUNPHARMA',
  'MARUTI SUZUKI': 'MARUTI',
};

/**
 * Listed symbols that are also ordinary words in tip-channel chatter. They count as an instrument
 * only when a strike / CE / PE / FUT sits right next to them, never on their own.
 */
export const AMBIGUOUS_SYMBOLS: ReadonlySet<string> = new Set([
  'IT', 'ONE', 'GOOD', 'BEST', 'GAIN', 'TRADE', 'TARGET', 'SAFE', 'HOLD', 'NEXT', 'JUST', 'EASY',
  'SUN', 'BEL', 'ABB', 'ALL', 'NEW', 'NOW', 'SL', 'PE', 'CE', 'BUY', 'SELL', 'LIFE', 'MAN',
  'MOTOR', 'POWER', 'BANK', 'TODAY', 'LOVE', 'HAPPY', 'DAY', 'BIG', 'CASH', 'FUT', 'CALL', 'PUT',
  'KEY', 'TIME', 'HOT', 'STAR', 'FIRST', 'ZERO', 'HERO', 'JOIN', 'VIP', 'FREE', 'OK', 'NG', 'SX', 'FN', 'BN', 'NF',
  'MCX', 'BSE', 'NSE', 'RAIN', 'IDEA', 'INDIA', 'LUX', 'HOME', 'GLOBAL', 'ANY', 'TOP', 'UP', 'DOWN', 'CUT', 'NO',
  'LEVEL', 'RANGE', 'GREAT', 'MAX', 'EXIT', 'ENTRY', 'PRICE', 'ONLY', 'AT', 'TO', 'LINK', 'DONE', 'HIT', 'BOOK',
]);

/** Build the vocabulary from the static index/commodity lists plus the cash symbols in `stocks`. */
export function buildVocabulary(stocks: Iterable<string>): Vocabulary {
  const names = new Map<string, string>();
  const classOf = new Map<string, UnderlyingClass>();
  for (const raw of stocks) {
    const s = String(raw ?? '').trim().toUpperCase().replace(/-(EQ|BE|BZ|SM|ST)$/, '');
    if (!/^[A-Z][A-Z0-9&-]{1,19}$/.test(s)) continue;
    names.set(s, s);
    classOf.set(s, 'STOCK');
  }
  for (const [alias, sym] of Object.entries(STOCK_ALIASES)) {
    names.set(alias, sym);
    names.set(sym, sym);
    classOf.set(sym, 'STOCK');
  }
  for (const [name, aliases] of Object.entries(COMMODITY_ALIASES)) {
    classOf.set(name, 'COMMODITY');
    for (const a of aliases) names.set(a, name);
  }
  // Indices last: an index alias always wins over a same-spelled stock.
  for (const [name, aliases] of Object.entries(INDEX_ALIASES)) {
    classOf.set(name, 'INDEX');
    for (const a of aliases) names.set(a, name);
  }
  return { names, classOf };
}

/** Multi-word aliases, longest first, for joining before tokenising ("BANK NIFTY" → "BANKNIFTY"). */
export function multiWordAliases(v: Vocabulary): Array<[string, string]> {
  return [...v.names.entries()]
    .filter(([k]) => k.includes(' '))
    .sort((a, b) => b[0].length - a[0].length);
}
