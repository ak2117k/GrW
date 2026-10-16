/**
 * Hand-maintained short forms (spec §5.2) → NSE symbol. Curated aliases are kept
 * even when shared and regardless of length. Add only forms that, in Indian
 * financial copy, almost always mean the company.
 */
export const CURATED_ALIASES: Readonly<Record<string, string>> = {
  'L&T': 'LT',
  'M&M': 'M&M',
  RIL: 'RELIANCE',
  'Reliance Industries': 'RELIANCE',
  SBI: 'SBIN',
  HUL: 'HINDUNILVR',
  ITC: 'ITC',
  TCS: 'TCS',
  'HDFC Bank': 'HDFCBANK',
  'ICICI Bank': 'ICICIBANK',
  'Axis Bank': 'AXISBANK',
  'Kotak Mahindra Bank': 'KOTAKBANK',
  'Bajaj Finance': 'BAJFINANCE',
  'Bajaj Finserv': 'BAJAJFINSV',
  'Bajaj Auto': 'BAJAJ-AUTO',
  'Maruti Suzuki': 'MARUTI',
  'Sun Pharma': 'SUNPHARMA',
  "Dr Reddy's": 'DRREDDY',
  ONGC: 'ONGC',
  NTPC: 'NTPC',
  BPCL: 'BPCL',
  HPCL: 'HINDPETRO',
  IOC: 'IOC',
  GAIL: 'GAIL',
  BHEL: 'BHEL',
  HAL: 'HAL',
  BEL: 'BEL',
  'Adani Ports': 'ADANIPORTS',
  'Adani Enterprises': 'ADANIENT',
  // Tata Motors demerger (2025): the specific forms name ONE successor. The bare
  // parent name is ambiguous — see AMBIGUOUS_ALIASES.
  'Tata Motors Passenger Vehicles': 'TMPV',
  'Tata Motors PV': 'TMPV',
  'Jaguar Land Rover': 'TMPV',
  JLR: 'TMPV',
  'Tata Motors CV': 'TMCV',
  'Tata Motors Commercial Vehicles': 'TMCV',
};

/**
 * Parent names a demerger left AMBIGUOUS → EVERY successor symbol. Without this the
 * name follows whichever company kept it in EQUITY_L: after the Tata Motors demerger
 * the CV business (TMCV) is "Tata Motors Limited", so every "Tata Motors" headline —
 * many of them about JLR and passenger cars (TMPV) — would land on TMCV alone and
 * never reach a TMPV position. Tagging BOTH is the conservative choice: the judge
 * reads the title and can tell them apart, a missed own-instrument headline cannot
 * be recovered, and a headline alone is never a reason for EXIT_NOW (prompt v9; the
 * exit-discipline gate is price-based). The longer specific forms in CURATED_ALIASES
 * still win (longest match). Revisit when the media settles on the new names.
 */
export const AMBIGUOUS_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'Tata Motors': ['TMCV', 'TMPV'],
  'Tata Motors Limited': ['TMCV', 'TMPV'],
};

/** Single words that are company names AND ordinary words (spec §5.2 guard). Compared case-insensitively. */
export const COMMON_WORD_BLOCKLIST: ReadonlySet<string> = new Set([
  'bharat', 'indian', 'india', 'national', 'gold', 'power', 'global', 'capital', 'finance', 'energy', 'industries',
  'united', 'standard', 'general', 'premier', 'supreme', 'century', 'future', 'reliance', 'eastern', 'western',
  'southern', 'northern', 'central', 'oriental', 'universal', 'hindustan', 'pioneer', 'triveni', 'vision', 'galaxy',
  'phoenix', 'apollo', 'mangalam', 'shree', 'kingfisher', 'paramount', 'infinity', 'success', 'motors', 'steel',
]);

/** Aliases removed on review of observe-mode false positives (spec §17 M2). Exact text. */
export const BLOCKED_ALIASES: ReadonlySet<string> = new Set<string>([]);
