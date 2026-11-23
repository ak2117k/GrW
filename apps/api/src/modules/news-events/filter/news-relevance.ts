/**
 * News relevance filter (owner-approved 2026-11-23: "we need to keep only which are important").
 *
 * PURE — imports nothing. Every article is still STORED (keep-all-data rule); this only decides
 * whether a row is HIDDEN (`news_articles.filtered = true`) and why (`filter_reason`).
 *
 *   1. NSE filings: kept only for the owner's universe (F&O underlyings + the owner's open trackers
 *      + NEWS_FILTER_WATCHLIST); inside it, routine filing types are hidden, price-moving and
 *      generic ones ('General Updates' / 'Updates' / 'Press Release') kept.
 *   2. Other sources: listicles, quote pages and non-market gossip are hidden by conservative title
 *      rules; so is a TAGGED article whose tags are all empty and whose title has no market word.
 *      When unsure, keep.
 *
 * NEWS_FILTER=off   — nothing computed, nothing written (rows byte-for-byte as before).
 * NEWS_FILTER=observe (default) — the would-be reason is written to `filter_reason`, `filtered` stays false.
 * NEWS_FILTER=on    — `filtered = true` + reason; every reader skips the row.
 */

export type NewsFilterMode = 'off' | 'observe' | 'on';

export const NSE_ANNOUNCEMENTS_SOURCE = 'NSE Announcements';

/** Mode from env. Anything but the exact words `off` / `on` is `observe` (the safe middle). */
export function parseNewsFilterMode(env: Record<string, string | undefined> = process.env): NewsFilterMode {
  const raw = (env.NEWS_FILTER ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'on' || raw === 'observe') return raw;
  return 'observe';
}

/**
 * The `where` fragment every reader adds: `{ filtered: false }` only when the filter is `on`,
 * `{}` otherwise — so `off` / `observe` issue exactly the queries they issued before.
 * `includeFiltered` (audit) always returns `{}`.
 */
export function visibleNewsWhere(
  env: Record<string, string | undefined> = process.env,
  includeFiltered = false,
): { filtered?: false } {
  return !includeFiltered && parseNewsFilterMode(env) === 'on' ? { filtered: false } : {};
}

// ─── Data: NSE filing subjects ──────────────────────────────────────────────────

/** Routine filing types: hidden even for the owner's universe. */
export const NSE_ROUTINE_SUBJECTS: readonly RegExp[] = [
  /^analysts\/institutional investor meet/,
  /^copy of newspaper publication/,
  /^shareholders meeting/,
  /^esop\/esos\/esps/,
  /^options to purchase securities/,
  /^trading window/,
  /^trading plan under pit/,
  /^change in company secretary/,
  /^investor presentation/,
  /^committee meeting updates/,
  /^record date/,
  /^loss of share certificates?/,
  /^issue of duplicate share certificates?/,
  /^certificate under sebi \(depositories/,
  /^address change/,
  /^name change/,
  /^name and symbol change/,
  /^corrigendum/,
  /^amendment\(s\)/,
  /^amendment to aoa\/moa/,
  /^monitoring agency report/,
  /^statement of deviation/,
  /^integrated filing- governance/,
  /^extension of annual general meeting/,
  /^forfeiture/,
  /^conversion$/,
  /^giving guarantees/,
  /^change in auditors/,
  /^closure of trading window/,
  /^compliance certificate/,
  /^book closure/,
  /^notice of (agm|egm|postal ballot)/,
  /^postal ballot/,
  /^annual report/,
  /^reg\. 34 \(1\) annual report/,
  /^sebi \(sast\)/,
];

/** The generic filing types ('General Updates' / 'Updates' / 'Press Release'): kept for the universe ... */
export const NSE_GENERIC_SUBJECTS: readonly RegExp[] = [/^general updates/, /^updates$/, /^press release/];

/**
 * ... unless their TEXT is plainly one of the routine types above (replay 2026-11-23: HDFCBANK "Updates —
 * Grant of stock options", BAJAJ-AUTO "General Updates — Change in Corporate Office Address of Registrar and
 * Share Transfer Agent", YESBANK "Non-Participation Schedule of Analysts/Institutional Investors Conference").
 */
export const NSE_GENERIC_ROUTINE_TEXT_RES: readonly RegExp[] = [
  /\b(employee stock option|esop|esos|esps|stock options?|restricted stock units?|rsu|sbeb|sweat equity)\b/i,
  /\bregistrar (and|&) (share )?transfer agents?\b/i,
  /\bRTA\b/,
  /\b(analysts?|institutional investors?)\b.{0,40}\b(meet|conference|call)\b|\binvestors? (meet|conference)\b|\bcon(ference)?[. ]call\b/i,
  /\bnotice of (the )?(extra[- ]?ordinary |annual )?general meeting\b|\bpostal ballot\b/i,
  /\bregulation 7\s*\(2\)|\bprohibition of insider trading\b/i,
  /\bnewspaper (publication|advertisement)s?\b/i,
  /\btrading window\b/i,
  /\b(loss of|duplicate) share certificates?\b/i,
];

/** People-change filings: kept only when the text names a key role (CEO / CFO / MD / chairman / KMP ...). */
export const NSE_KEY_ROLE_SUBJECTS: readonly RegExp[] = [
  /^resignation of director\/kmp\/smp/,
  /^resignation$/,
  /^appointment/,
  /^change in director\(s\)/,
  /^cessation/,
  /^retirement/,
];

/** Allotment: kept only for a notable capital raise (QIP / preferential / warrants / rights / bonus / FPO). */
export const NSE_ALLOTMENT_SUBJECTS: readonly RegExp[] = [/^allotment of securities/];

/**
 * Documented for the reader; anything not routine / key-role / allotment is KEPT for the universe
 * (an unknown subject is kept — prefer keeping when unsure). This list is not consulted for a decision.
 */
export const NSE_PRICE_MOVING_SUBJECTS: readonly string[] = [
  'Outcome of Board Meeting', 'Bagging/Receiving of orders/contracts', 'Awarding of order(s)/contract(s)', 'Acquisition',
  'Amalgamation/Merger', 'Scheme of Arrangement', 'Demerger', 'Buyback', 'Public Announcement - Buyback of Shares',
  'Rights Issue', 'Credit Rating (all variants)', 'Corporate Insolvency Resolution Process',
  'Action(s) taken or orders passed', 'Action(s) initiated or orders passed',
  'Pendency of Litigation(s)/dispute(s) or the outcome impacting the Company', 'Change in Management', 'Spurt in Volume',
  'Price movement', 'News Verification', 'Rumour Verification', 'Commencement of commercial production/operations',
  'Capacity addition', 'Granting/withdrawal/.../suspension of key licenses/ regulatory approvals',
  'Disclosure under SEBI Takeover Regulations', 'Public Announcement-Open Offer', 'Qualified Institutional Placement',
  'Issue of Securities', 'Bonus', 'Fraud/Default/Arrest', 'Initiation of Forensic Audit', 'Disruption of Operations',
  'Strikes/Lockouts/Disturbances', 'Resignation of Statutory Auditor', 'Reasons for Delayed/Non-submission of Financial Results',
  'Sale or disposal', 'Diversification/Disinvestment', 'Agreements', 'Arrangements for strategic ... tie up',
  'Monthly Business Updates', 'Product launch', 'Disclosure of material issue', 'Integrated Filing- Financial',
  'General Updates / Updates / Press Release (generic: kept because the company is in the universe)',
];

export const KEY_ROLE_RE =
  /\b(managing director|joint managing director|deputy managing director|chief executive|ceo|chief financial|cfo|chief operating|coo|whole[- ]?time director|executive director|executive chairman|chairman|chairperson|key managerial|kmp|md(?:\s*&\s*ceo)?)\b/i;

/** A people-change filing that names only a non-key role (independent director, CS, a functional chief ...). */
export const NON_KEY_ROLE_RE =
  /\b(independent director|non[- ]executive|nominee director|additional director|company secretary|compliance officer|senior management|smp|head of|vice president|chief (?:of )?(?:vigilance|risk|compliance|information|technology|human|operations|marketing|business|digital|people|investment|internal audit|sustainability)\w*)\b/i;

export const NOTABLE_ALLOTMENT_RE =
  /\b(qualified institutions? placement|qip|preferential|warrants?|rights (issue|basis|equity)|bonus|further public offer|fpo|open offer)\b/i;

const EMPLOYEE_SCHEME_RE = /\b(esop|esos|esps|employee stock|employees? stock|stock option|sbeb)\b/i;

// ─── Data: other sources ────────────────────────────────────────────────────────

/** Quote / profile pages — no news in them. */
export const QUOTE_PAGE_RES: readonly RegExp[] = [
  /\bstock price,? news,? quote\b/i,
  /\bshare price live updates?\b/i,
  /\([A-Z][A-Z.]{0,6}\)\s+(stock|share) (price|quote)\b/,
  /^META_TITLE_QUOTE\b/, // a Yahoo quote page whose template never filled in (replay 2026-11-23)
];

/** Listicles ("5 Best American Stocks to Buy for 2027"). */
export const LISTICLE_RES: readonly RegExp[] = [
  /^(?:the\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:\S+\s+){0,3}(?:stocks|shares|etfs?|funds)\s+to\s+(?:buy|own|hold)\b/i,
  /\b(?:best|top|unstoppable|cheap|undervalued|magnificent|no-brainer|millionaire[- ]maker|high[- ]yield|dividend)\b(?:\s+\S+){0,4}?\s+(?:stocks|shares|etfs?)\s+to\s+(?:buy|own|hold)\b/i,
];

/**
 * Commodity feeds: their geopolitics / weather / policy stories (Iran, COP31, farm bill) move crude and
 * agri prices even with no tag, so the untagged rule never applies to them.
 */
export const UNTAGGED_RULE_EXEMPT_SOURCES: readonly string[] = ['Investing.com Commodities', 'Hindu BusinessLine Commodities', 'ET Commodities'];

/** Gossip openers / words: hidden only when the title also has no market word. */
export const GOSSIP_RES: readonly RegExp[] = [
  /^who (is|was)\b/i,
  /\b(girlfriend|boyfriend|dating|horoscope|zodiac|astrolog\w*|lottery|bigg boss|bollywood|recipe|celebrity|net worth)\b/i,
];

/**
 * Personal-life gossip ("... during affair with Nvidia CEO"): a company name or "CEO" does not save it —
 * only a hard money word (shares, earnings, IPO, a probe ...) does.
 */
export const HARD_GOSSIP_RES: readonly RegExp[] = [/\baffairs? with\b/i];
export const HARD_MARKET_RE =
  /\b(shares?|stocks?|ipo|earnings|results|profits?|revenues?|market cap\w*|valuation|probe|subpoena\w*|lawsuit|liable|investigation|sec|sebi)\b/i;

/**
 * Market vocabulary. Deliberately broad: it is the "keep" side of the gossip and untagged rules.
 * Word-bounded (`marketing` is not `market`).
 */
export const MARKET_VOCAB_RE = new RegExp(
  '\\b(' +
    [
      'stocks?', 'shares?', 'equit(?:y|ies)', 'markets?', 'sensex', 'nifty', 'nasdaq', 'dow', 's&p', 'wall street', 'dalal street',
      'ipos?', 'listing', 'listed', 'delist\\w*', 'earnings', 'results?', 'q[1-4](?:fy\\d{2})?', 'profits?', 'loss(?:es)?', 'revenues?',
      'sales', 'margins?', 'ebitda', 'guidance', 'dividends?', 'buybacks?', 'bonus', 'split',
      'rall(?:y|ies|ied)', 'slump\\w*', 'surg\\w*', 'plung\\w*', 'tumbl\\w*', 'jump\\w*', 'slid\\w*', 'slip\\w*', 'falls?', 'fell',
      'rises?', 'rose', 'gains?', 'soar\\w*', 'crash\\w*', 'record high', 'crore', 'billion', 'bn', 'trillion', 'valuation',
      'invest\\w*', 'funds?', 'funding', 'fundrais\\w*', 'raises?', 'raised', 'stake', 'acqui\\w*', 'mergers?', 'deals?', 'takeover',
      'open offer', 'sebi', 'rbi', 'fed', 'federal reserve', 'ecb', 'boj', 'opec\\+?', 'imf', 'gdp', 'inflation', 'cpi', 'wpi', 'pmi',
      'rate cuts?', 'rate hikes?', 'interest rates?', 'repo', 'yields?', 'bonds?', 'g-sec', 'treasur(?:y|ies)', 'rupee', 'dollar',
      'forex', 'currenc(?:y|ies)', 'crude', 'oil', 'brent', 'wti', 'gas', 'lng', 'gold', 'silver', 'copper', 'aluminium', 'zinc',
      'metals?', 'steel', 'wheat', 'rice', 'sugar', 'cotton', 'commodit\\w*', 'tariffs?', 'sanctions?', 'exports?', 'imports?',
      'duty', 'gst', 'tax\\w*', 'budget', 'fiscal', 'deficit', 'fiis?', 'fpis?', 'diis?', 'mutual funds?', 'sip', 'aum', 'etfs?',
      'banks?', 'banking', 'nbfcs?', 'insurers?', 'capex', 'orders?', 'contracts?', 'ceo', 'cfo', 'chairman', 'board',
      'layoffs?', 'job cuts', 'bankrupt\\w*', 'insolvency', 'defaults?', 'downgrade\\w*', 'upgrade\\w*', 'ratings?',
      'target price', 'brokerage', 'analysts?', 'outlook', 'forecasts?', 'econom\\w*', 'recession', 'demand', 'supply',
      'production', 'output', 'capacity', 'prices?', 'pricing', 'trade', 'trading', 'traders?', 'investors?', 'shareholders?',
      'regulator\\w*', 'antitrust', 'lawsuit', 'probe', 'fine[ds]?', 'penalty', 'subpoena\\w*',
      // Added after the 2026-11-23 replay: market stories the first list missed.
      'futures', 'options', 'derivatives?', 'mtf', 'anti-dumping', 'duties', 'broker\\w*', 'buyouts?', 'million', 'seeks?',
      'assets?', 'chips?', 'chipmakers?', 'semiconductors?', 'exchanges?', 'successor', 'reappoint\\w*', 'chief executives?',
      'show cause', 'dgca', 'trai', 'fssai', 'cci', 'licen[cs]es?', 'bills?', 'congress', 'senate', 'parliament',
      'government', 'govt', 'ministry', 'policy', 'war', 'missiles?', 'attacks?', 'strikes?', 'iran', 'russia', 'ukraine',
      'israel', 'china', 'gulf', 'hormuz', 'opec', 'energy', 'power', 'coal', 'morning bid', 'telecom', 'series [a-f]',
      'expan\\w*', 'growth', 'tata', 'nvidia', 'microsoft', 'apple', 'amazon', 'google', 'alphabet', 'meta', 'tesla',
      'openai', 'anthropic', 'sell-?offs?', 'mfs?', 'crypto\\w*', 'bitcoin',
    ].join('|') +
    ')\\b',
  'i',
);

// ─── Classifier ─────────────────────────────────────────────────────────────────

export interface NewsFilterInput {
  source: string;
  title: string;
  summary?: string | null;
  /** v2 tags as stored. */
  instruments: readonly string[];
  sectors: readonly string[];
  indices: readonly string[];
  markets: readonly string[];
  /** True when the v2 tagger ran on this row (tagVersion > 0). The untagged rule needs it. */
  tagged: boolean;
}

/**
 * The owner's universe, upper-case base symbols. `null` = not available (load failed / empty F&O
 * list): the universe rule is then SKIPPED (fail open), only the type rules apply.
 */
export type NewsUniverse = ReadonlySet<string> | null;

export interface NewsFilterVerdict { filtered: boolean; reason: string | null }

const KEEP: NewsFilterVerdict = { filtered: false, reason: null };
const hide = (reason: string): NewsFilterVerdict => ({ filtered: true, reason });

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

/** Minimal HTML-entity decode (feed titles keep `&amp;`, `&#x2018;`). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}

/** "SYMBOL: Subject — text" → parts (the NSE ingester's title format). */
export function parseNseTitle(title: string): { symbol: string; subject: string; text: string } | null {
  const m = /^([^:]+):\s+(.+?)(?:\s+—\s+([\s\S]*))?$/.exec(title.trim());
  if (!m) return null;
  return { symbol: m[1].trim().toUpperCase(), subject: m[2].trim(), text: (m[3] ?? '').trim() };
}

/** Same normalisation as `news-events/keys.ts` baseSymbol: strip a 1–3 char series suffix (`-EQ`, `-BE`). */
export function universeKey(raw: string): string {
  return String(raw ?? '').trim().toUpperCase().replace(/^(.+)-[A-Z0-9]{1,3}$/, '$1');
}

const DERIVATIVE_EXCHANGES: ReadonlySet<string> = new Set(['NFO', 'BFO', 'MCX', 'CDS', 'BCD', 'NCO']);
const DERIVATIVE_SYMBOL_RE = /^([A-Z&-]+?)\d{2}[A-Z]{3}\d{2}/;

/**
 * A trade tracker's universe key: a derivative's underlying name (`NIFTY25NOV2524000CE` → NIFTY,
 * `CRUDEOIL19NOV26FUT` → CRUDEOIL), else the cash symbol without its series (`SURANAT&P-EQ` → SURANAT&P).
 */
export function trackerUnderlying(symbol: string, exchange: string): string {
  const sym = String(symbol ?? '').trim().toUpperCase();
  if (DERIVATIVE_EXCHANGES.has(String(exchange ?? '').trim().toUpperCase())) {
    const m = DERIVATIVE_SYMBOL_RE.exec(sym);
    if (m) return m[1];
  }
  return universeKey(sym);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function slug(s: string): string {
  return norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
}

export function classifyNseFiling(title: string, summary: string | null | undefined, universe: NewsUniverse): NewsFilterVerdict {
  const p = parseNseTitle(title);
  if (!p) return KEEP;
  if (universe && !universe.has(universeKey(p.symbol))) return hide('nse_not_in_universe');
  const subject = norm(p.subject);
  // The exchange's text repeats the subject ("... informed the Exchange about Resignation of Director/KMP/SMP"):
  // drop that echo so a role word in the subject is not read as detail.
  const text = `${p.text} ${summary ?? ''}`.split(p.subject).join(' ');
  if (NSE_ROUTINE_SUBJECTS.some((re) => re.test(subject))) return hide(`nse_routine:${slug(p.subject)}`);
  if (NSE_GENERIC_SUBJECTS.some((re) => re.test(subject)) && NSE_GENERIC_ROUTINE_TEXT_RES.some((re) => re.test(text))) {
    return hide('nse_generic_routine_text');
  }
  // People changes: hidden only when the text NAMES a non-key role and no key role. Boilerplate with no
  // detail (most of these filings) is kept — it may be the MD.
  if (NSE_KEY_ROLE_SUBJECTS.some((re) => re.test(subject)) && NON_KEY_ROLE_RE.test(text) && !KEY_ROLE_RE.test(text)) {
    return hide(`nse_non_key_role:${slug(p.subject)}`);
  }
  if (NSE_ALLOTMENT_SUBJECTS.some((re) => re.test(subject)) && (!NOTABLE_ALLOTMENT_RE.test(text) || EMPLOYEE_SCHEME_RE.test(text))) {
    return hide('nse_routine_allotment');
  }
  return KEEP;
}

export function classifyOtherSource(a: NewsFilterInput): NewsFilterVerdict {
  const title = decodeEntities(a.title).replace(/\s+/g, ' ').trim();
  if (QUOTE_PAGE_RES.some((re) => re.test(title))) return hide('quote_page');
  // Only the headline proper: "Nifty IT jumps 2% - Key reasons | Top shares to buy" is news with a listicle tail.
  const head = title.split(' | ')[0];
  if (LISTICLE_RES.some((re) => re.test(head))) return hide('listicle');
  const marketWord = MARKET_VOCAB_RE.test(title);
  if (!marketWord && GOSSIP_RES.some((re) => re.test(title))) return hide('gossip');
  if (!HARD_MARKET_RE.test(title) && HARD_GOSSIP_RES.some((re) => re.test(title))) return hide('gossip');
  const untagged = a.instruments.length === 0 && a.sectors.length === 0 && a.indices.length === 0 && a.markets.length === 0;
  if (a.tagged && untagged && !marketWord && !UNTAGGED_RULE_EXEMPT_SOURCES.includes(a.source)) return hide('untagged_no_market_word');
  return KEEP;
}

/** The one decision. Pure. */
export function classifyNews(a: NewsFilterInput, universe: NewsUniverse): NewsFilterVerdict {
  return a.source === NSE_ANNOUNCEMENTS_SOURCE ? classifyNseFiling(a.title, a.summary, universe) : classifyOtherSource(a);
}

/**
 * The columns to write on insert for `mode`. `off` → `{}` (the insert is exactly what it was).
 * `observe` → only the would-be reason. `on` → `filtered` + reason.
 */
export function filterColumns(mode: NewsFilterMode, v: NewsFilterVerdict): { filtered?: boolean; filterReason?: string | null } {
  if (mode === 'off') return {};
  if (mode === 'observe') return { filterReason: v.reason };
  return { filtered: v.filtered, filterReason: v.reason };
}

/** Whether a freshly saved row should be pushed to the in-memory index / wake path. */
export function publishable(row: { filtered?: boolean | null }): boolean {
  return row.filtered !== true;
}
