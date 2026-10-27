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
  /** NSE cash symbols, sorted (the loose-name match: prefix / one-letter-off). */
  readonly stocks?: readonly string[];
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
  // Channel nicknames seen in prod (2026-10-26): "#HEL 4700 PE" is HAL; Ather posts as "ATHER ENERGY".
  HEL: 'HAL',
  'ATHER ENERGY': 'ATHERENERG',
  ATHER: 'ATHERENERG',
  // "KPIT TECH 540CE" (2026-10-27) read as TECH-EQ, a different cash line with no options.
  'KPIT TECH': 'KPITTECH',
  KPIT: 'KPITTECH',
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
  const cash = [...classOf.entries()].filter(([, c]) => c === 'STOCK').map(([n]) => n).sort();
  return { names, classOf, stocks: cash };
}

/**
 * Tip channels write company names, nicknames and typos, not tickers (prod 2026-10-27: "MV ELECTRO",
 * "ATHER ENERGY", "SONACOM", "SEJAL GLASS", "Acutsas Chemical" were all NOISE). Words that look like
 * a stock but are ordinary words never match; the prefix / one-letter rules need a market word nearby.
 */
export const LOOSE_STOPWORDS: ReadonlySet<string> = new Set([
  'MARKET', 'MARKETS', 'GLOBAL', 'STRONG', 'STRONGER', 'SOLID', 'SUPER', 'GREAT', 'EXCELLENT', 'RESULT', 'RESULTS', 'BREAKOUT', 'BREAKDOWN',
  'OPENING', 'CLOSING', 'PROFIT', 'PROFITS', 'TRADE', 'TRADES', 'TRADER', 'TRADERS', 'TRADING', 'TODAY', 'STOCK', 'STOCKS', 'SHARE', 'SHARES',
  'INDIA', 'INDIAN', 'ENERGY', 'POWER', 'BANKS', 'METAL', 'METALS', 'PHARMA', 'AUTO', 'REALTY', 'MOMENTUM', 'POSSIBLE', 'LOOKS', 'LOOKING',
  'ABOVE', 'BELOW', 'SUPPORT', 'RESISTANCE', 'TARGET', 'LEVEL', 'LEVELS', 'ACTIVE', 'PRICE', 'ACTION', 'BOOKING', 'BOOK', 'BUYING',
  'SELLING', 'PRESSURE', 'BULLISH', 'BEARISH', 'VOLATILE', 'HIGHLY', 'AFTER', 'BEFORE', 'GUYS', 'MORNING', 'EVENING', 'NIGHT', 'WEEKEND',
  'SALE', 'OFFER', 'DIWALI', 'PRIME', 'GROUP', 'MEMBER', 'MEMBERSHIP', 'EARNINGS', 'RADAR', 'WATCH', 'WATCHLIST', 'LIMITED', 'CHEMICAL',
  'CHEMICALS', 'GLASS', 'INDUSTRIES', 'ENTERPRISES', 'HOLDINGS', 'FINANCE', 'FINANCIAL', 'SERVICES', 'TECHNOLOGIES', 'SYSTEMS', 'PHARMACEUTICALS',
  'ELECTRIC', 'ELECTRICALS', 'MOTORS', 'STEEL', 'CEMENT', 'TEXTILES', 'INFRA', 'PROJECTS', 'PORTS', 'CAPITAL', 'VENTURES', 'THOUGHTS',
  'EXCELLE', 'EXCEL', 'GLOBE', 'SMART', 'SAFE', 'RALLY', 'CRASH', 'FALLS', 'ORDER', 'ORDERS', 'BONUS', 'SPLIT', 'DIVIDEND', 'LISTING',
  'ELECTION', 'BRAZIL', 'CHINA', 'JAPAN', 'EUROPE', 'AMERICA', 'DOLLAR', 'BONDS', 'YIELD', 'YIELDS', 'CURRENT', 'FIRE', 'BOUNCE',
  'GOOD', 'BEST', 'WINNER', 'LEADER', 'GROWTH', 'VALUE', 'QUALITY', 'FOCUS', 'TARGETS', 'SIGNAL', 'ALERT', 'UPDATE', 'TECH',
]);

/** Words that finish a company name after its symbol. */
const COMPANY_TAIL: ReadonlySet<string> = new Set([
  'LTD', 'LIMITED', 'TECH', 'TECHNOLOGY', 'TECHNOLOGIES', 'INDUSTRIES', 'INDS', 'CHEMICAL', 'CHEMICALS', 'GLASS', 'LABS', 'ENTERPRISES', 'CORP',
  'CORPORATION', 'ENERGY', 'PHARMA', 'FINANCE', 'INFRA',
]);

/** A market word near a loose name makes it a stock mention (not chatter). */
const LOOSE_CONTEXT: ReadonlySet<string> = new Set([
  'CMP', 'RESULT', 'RESULTS', 'BREAKOUT', 'BREAKDOWN', 'GAP', 'SUPPORT', 'RESISTANCE', 'LOOKS', 'LOOKING', 'FIRE', 'RALLY', 'VIEW', 'BUY',
  'SELL', 'ABOVE', 'BELOW', 'TGT', 'FOR', 'ORDER', 'ORDERS', 'UPPER', 'LOWER', 'CIRCUIT', 'MOMENTUM', 'Q1', 'Q2', 'Q3', 'Q4', 'EARNINGS', 'PROFIT',
  'BONUS', 'SPLIT', 'DIVIDEND', 'BUYBACK', 'UPGRADE', 'DOWNGRADE', 'STRONG', 'WEAK', 'EXCELLENT', 'POOR', 'BUMPER', 'TARGET', 'FUT', 'CE', 'PE',
  'RADAR', 'WATCH', 'WATCHLIST', 'EARNINGS',
]);

/** At most one edit (substitution / insertion / deletion) between a and b. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** The one stock a loose word can only mean (a unique start, else a unique one-letter-off), or null. */
function looseStock(word: string, stocks: readonly string[]): string | null {
  if (word.length < 5 || !/^[A-Z]+$/.test(word) || LOOSE_STOPWORDS.has(word)) return null;
  const starts = stocks.filter((s) => s.startsWith(word) && s.length - word.length <= 4);
  if (starts.length === 1) return starts[0];
  if (starts.length > 1 || word.length < 6) return null;
  const near = stocks.filter((s) => s[0] === word[0] && withinOneEdit(s, word));
  return near.length === 1 ? near[0] : null;
}

/**
 * Tokens → tokens with company names / nicknames / typos replaced by their NSE symbol: two words
 * joined ("MV ELECTRO" → MVELECTRO; "ATHER ENERGY" → the 10-letter ATHERENERG), else — beside a
 * market word only — a unique start ("SONACOM" → SONACOMS) or one letter off ("ACUTSAS" → ACUTAAS).
 */
export function resolveLooseNames(tokens: readonly string[], v: Vocabulary): string[] {
  const stocks = v.stocks ?? [];
  if (stocks.length === 0) return [...tokens];
  const out: string[] = [];
  const isStock = (s: string) => v.classOf.get(v.names.get(s) ?? '') === 'STOCK';
  const word = (s: string | undefined) => !!s && /^[A-Z&]{2,}$/.test(s);
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    const aClass = v.classOf.get(v.names.get(a) ?? '');
    // Only a REAL symbol is accepted as the join, so this is strict on its own; an index / commodity
    // word ("NIFTY BANK" is an alias already) never starts one.
    if (word(a) && word(b) && aClass !== 'INDEX' && aClass !== 'COMMODITY') {
      const joined = `${a}${b}`;
      // The 10-letter cut must keep part of the second word: ATHERENERG + ON cut back to ATHERENERG is no join.
      const hit = [joined, joined.slice(0, 10)].find((j) => j.length >= 5 && j !== a && isStock(j));
      if (hit) {
        out.push(v.names.get(hit) as string);
        i++;
        continue;
      }
    }
    // The rest of a company name after its symbol ("NAZARA TECH", "KROSS LTD"): TECH is a symbol of its own.
    const prev = out[out.length - 1];
    if (prev && isStock(prev) && COMPANY_TAIL.has(a)) continue;
    if (word(a) && !v.names.has(a)) {
      const near = tokens.slice(Math.max(0, i - 3), i + 4).some((t) => LOOSE_CONTEXT.has(t));
      const hit = near ? looseStock(a, stocks) : null;
      if (hit) {
        out.push(hit);
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

/** Multi-word aliases, longest first, for joining before tokenising ("BANK NIFTY" → "BANKNIFTY"). */
export function multiWordAliases(v: Vocabulary): Array<[string, string]> {
  return [...v.names.entries()]
    .filter(([k]) => k.includes(' '))
    .sort((a, b) => b[0].length - a[0].length);
}
