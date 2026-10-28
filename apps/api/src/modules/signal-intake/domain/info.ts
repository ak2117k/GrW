import { AD_RE, hasStrikePair, instrumentHits, RECAP_RE, type PrefilterResult } from './prefilter';
import { isNumber, normalise, type Normalised } from './text';
import { hasTradeInstruction, viewReason } from './view';
import { AMBIGUOUS_SYMBOLS, LOOSE_STOPWORDS, SECTOR_INDEX_TOKEN, type Vocabulary } from './vocabulary';

/**
 * INFO / RECAP / NOISE for posts that are not a trade call (owner 2026-10-24: "these contain information
 * about NIFTY and crude, and OI — differentiate messages which contain info from actual noise").
 *
 * - INFO  = market information: a view, levels, an OI/PCR observation, a macro link, a conditional
 *           scenario. Needs a market ENTITY (index / stock / commodity incl. Hinglish aliases, or an
 *           OI note on an index-range strike) AND market CONTENT (a level, OI words, bias words, or a
 *           conditional "agar/if … toh/then").
 * - RECAP = the channel's own results of past calls (a recap header or P&L words AND a named contract
 *           with a price move) — kept to score the channel's claims later, never a signal.
 * - NOISE = greetings, ads, membership, P&L brags without calls, links-only, emoji-only, empty.
 *           Ad vocabulary wins unless the post ALSO carries concrete market content.
 *
 * Deterministic and free. {@link analyseInfo} also extracts structured items (one per underlying) for
 * channel_infos; the cheap-LLM fallback runs only when this says INFO but no item got a bias.
 */

export type InfoBias = 'BULL' | 'BEAR' | 'NEUTRAL';
export type InfoHorizon = 'INTRADAY' | 'DAYS' | 'WEEKS' | 'MONTHS';
export type InfoDirection = 'UP' | 'DOWN';

export interface InfoOi {
  strike: number;
  side: 'CE' | 'PE';
  note: string;
}

export interface InfoCondition {
  /** The driver of the scenario ('CRUDE', 'NIFTY', 'GOLD' …). */
  driver: string;
  direction: InfoDirection | null;
}

/**
 * What kind of information (owner 2026-10-27): a VIEW on an instrument (the default), a CATALYST
 * (results / orders / a gap), a WATCH (a breakout level or a momentum list to keep an eye on), MACRO
 * (global news, scored against NIFTY) or a MARKET-wide view with no instrument named (also NIFTY).
 */
export type InfoKind = 'VIEW' | 'CATALYST' | 'WATCH' | 'MACRO' | 'MARKET';
export const INFO_KINDS: readonly InfoKind[] = ['VIEW', 'CATALYST', 'WATCH', 'MACRO', 'MARKET'];

export interface InfoItem {
  underlying: string;
  bias: InfoBias | null;
  levels: number[];
  targetLevel: number | null;
  oi: InfoOi | null;
  condition: InfoCondition | null;
  horizon: InfoHorizon | null;
  /** Absent on items stored before 2026-10-27 (read as VIEW). */
  kind?: InfoKind;
}

/** Last close per underlying (the reference for "X se dur nahi" = towards X). */
export type RefPrices = ReadonlyMap<string, number>;

export interface InfoAnalysis {
  /** The detector: entity AND market content. */
  isInfo: boolean;
  items: InfoItem[];
  /** What made it INFO (for the stored reason). */
  reasons: string[];
  confidence: number;
  /** An index item has a target but no bias yet: a reference price would decide it. */
  wantsRefs: boolean;
}

export interface CommentaryClass {
  kind: 'INFO' | 'RECAP' | 'NOISE';
  reason: string;
  items: InfoItem[];
  confidence: number;
  /** The detector said INFO but the rule extractor found no bias for any item: the cheap-LLM fallback may run. */
  needsLlm: boolean;
  /** Re-run with reference prices (see {@link InfoAnalysis.wantsRefs}). */
  wantsRefs: boolean;
  /** NOISE the rules could not place but that talks about the market: the cheap LLM decides INFO / NOISE. */
  unsure?: boolean;
}

// ─── Lexicon (normalised, upper-case tokens) ────────────────────────────────

/** Entity aliases outside the trading vocabulary, applied to the raw upper-case text before `normalise`. */
const INFO_ALIASES: Array<[RegExp, string]> = [
  [/\bU\.?\s?S\.?\s+OIL\b|\bUSOIL\b|\b(?:WTI|BRENT|NYMEX)(?:\s+CRUDE)?(?:\s+OIL)?\b/g, ' CRUDEOIL '],
  [/\bCRUDE\s+OIL\b/g, ' CRUDEOIL '],
  [/\bOIL\s+PRICES?\b/g, ' CRUDEOIL '],
  // A lone "oil" is crude in chatter; "OIL INDIA" / "OIL 450 CE" stay the stock.
  [/(?<!CRUDE)\bOIL\b(?!\s+INDIA\b)(?!\s*\d)/g, ' CRUDEOIL '],
  [/\bCL\b(?=\s*\$?\s*\d)/g, ' CRUDEOIL '],
];

/** Words that are never a stock in chatter unless a contract sits beside them. */
const INFO_STOPWORDS: ReadonlySet<string> = new Set([
  'ALL', 'ARE', 'THE', 'FOR', 'YOU', 'SEE', 'REAL', 'TEST', 'HAI', 'THA', 'NAHI', 'SAB', 'AUR', 'JATA', 'PUT', 'CALL', 'HIGH', 'LOW',
  'KAL', 'AAJ', 'BHI', 'WALA', 'LIYE', 'DEKHO', 'MATLAB', 'AISE', 'RAHA', 'TOH', 'AGAR', 'WILL', 'WANT', 'KEEP', 'RISING', 'NEXT', 'FEW',
  'MONTHS', 'HEAVY', 'DUR', 'PANIC', 'BRUTAL', 'TENSION', 'GOOD', 'GREAT', 'WEEKEND', 'MORNING', 'NIGHT', 'OPEN', 'LIVE', 'BIG', 'OFFER',
]);

const BULL_WORDS: ReadonlySet<string> = new Set([
  'BULLISH', 'RALLY', 'BREAKOUT', 'UPSIDE', 'UPMOVE', 'BADHEGA', 'BADHEGI', 'BADEGA', 'BHAGEGA', 'BHAGEGI', 'UCHHLEGA', 'UCHLEGA',
  'CHADHEGA', 'CHADEGA', 'CHADHEGI', 'TEJI', 'TEZI', 'BOUNCE', 'SKYROCKET', 'BUYING',
]);
const BEAR_WORDS: ReadonlySet<string> = new Set([
  'BEARISH', 'PANIC', 'SELLING', 'SELLOFF', 'CRASH', 'CRASHED', 'BREAKDOWN', 'DOWNSIDE', 'GIREGA', 'GIREGI', 'GIRAWAT', 'GIRNA',
  'TOOTEGA', 'TUTEGA', 'TOOTEGI', 'TUTEGI', 'TODEGA', 'TODEGI', 'MANDI', 'DUMP', 'BLOODBATH', 'CORRECTION', 'WEAK', 'WEAKNESS',
  'BRUTAL', 'PLUNGE', 'FALL',
]);
const NEUTRAL_WORDS: ReadonlySet<string> = new Set(['SIDEWAYS', 'RANGEBOUND', 'CONSOLIDATION', 'CONSOLIDATING', 'CHOPPY']);
const STRUCT_WORDS: ReadonlySet<string> = new Set(['SUPPORT', 'SUPPORTS', 'RESISTANCE', 'RESISTANCES', 'HURDLE', 'PIVOT', 'ZONE', 'DEMAND', 'SUPPLY']);
const BULL_BIGRAMS = ['SHORT COVERING', 'BREAK OUT', 'GO UP', 'GOING UP', 'MOVE UP', 'ABOVE FAKNE', 'ABOVE PHEKNE', 'ABOVE FEKNE', 'ABOVE JAYEGA', 'ON FIRE', 'GAP UP', 'CURRENT LAG', 'UPPER CIRCUIT'];
const BEAR_BIGRAMS = ['SELL OFF', 'BREAK DOWN', 'GO DOWN', 'GOING DOWN', 'BELOW FAKNE', 'BELOW JAYEGA', 'BLOOD BATH', 'GAP DOWN', 'LOWER CIRCUIT'];
const NEUTRAL_BIGRAMS = ['RANGE BOUND'];

const OI_WORDS: ReadonlySet<string> = new Set(['OI', 'PCR', 'WRITING', 'WRITERS', 'BUILDUP']);
const HEAVY_WORDS: ReadonlySet<string> = new Set([
  'HEAVY', 'HUGE', 'BIG', 'HIGH', 'HIGHEST', 'MAX', 'MAXIMUM', 'ZYADA', 'JYADA', 'BAHUT', 'MASSIVE', 'WRITING', 'WRITERS', 'WALL', 'ADDED', 'ADDITION', 'BUILDUP',
]);
const PUT_WORDS: ReadonlySet<string> = new Set(['PUT', 'PUTS']);
const CALL_WORDS: ReadonlySet<string> = new Set(['CALL', 'CALLS']);

/** "towards X": a target phrase. */
const TARGET_WORDS: ReadonlySet<string> = new Set(['TGT', 'TAK', 'TOWARDS', 'AAYEGA', 'AYEGA', 'AAEGA', 'JAYEGA', 'JAEGA', 'JAYEGI', 'MILEGA']);
const TARGET_BIGRAMS = ['DUR NAHI', 'DUR NHI', 'DUR NAHIN', 'DOOR NAHI', 'DOOR NAHIN', 'DOOR NHI'];

const UP_WORDS: ReadonlySet<string> = new Set([
  'RISING', 'RISE', 'RISES', 'UP', 'BADHTA', 'BADHA', 'CHADHTA', 'HIGHER', 'ABOVE', 'BULLISH', 'RALLY', 'SPIKE', 'SPIKES', 'SURGE', 'JUMP', 'JUMPS',
  'BADHEGA', 'CHADHEGA',
]);
const DOWN_WORDS: ReadonlySet<string> = new Set([
  'FALLING', 'FALL', 'FALLS', 'DOWN', 'GIRTA', 'GIRA', 'LOWER', 'BELOW', 'BEARISH', 'CRASH', 'CRASHES', 'TOOTA', 'TUTA', 'TOOTEGA', 'GIREGA', 'BREAKS',
]);

const IF_WORDS: ReadonlySet<string> = new Set(['IF', 'AGAR', 'AGR', 'INCASE']);
const THEN_WORDS: ReadonlySet<string> = new Set(['THEN', 'THN', 'TOH', 'TOU', 'TAB']);

/** A number followed by one of these is not a price level ("1000 points", "3 lots", "20 %"). */
const NOT_LEVEL_AFTER: ReadonlySet<string> = new Set([
  'POINTS', 'POINT', 'PTS', 'PT', '%', 'X', 'LAKH', 'LAKHS', 'CR', 'CRORE', 'CRORES', 'K', 'DAYS', 'DAY', 'WEEKS', 'MONTHS', 'YEARS', 'AM', 'PM',
  'MIN', 'MINS', 'HRS', 'LOT', 'LOTS', 'QTY', 'SHARES', 'MEMBERS', 'PEOPLE',
]);
const NOT_LEVEL_BEFORE: ReadonlySet<string> = new Set(['PCR', 'VIX', 'LOT', 'LOTS', 'QTY', 'RATIO', 'UPDATE', 'NO', 'BATCH', 'LAST']);

/** Plausible levels of each index (a "1000" next to NIFTY is a move size, not a level). */
const INDEX_RANGE: Readonly<Record<string, readonly [number, number]>> = {
  NIFTY: [15_000, 35_000],
  BANKNIFTY: [35_000, 75_000],
  FINNIFTY: [15_000, 35_000],
  MIDCPNIFTY: [8_000, 20_000],
  NIFTYNXT50: [45_000, 95_000],
  SENSEX: [55_000, 110_000],
  BANKEX: [40_000, 95_000],
};

const CALL_VERBS: ReadonlySet<string> = new Set(['BUY', 'SELL', 'LONG', 'SHORT', 'BTST', 'STBT', 'ACCUMULATE']);
const HYPE_RE =/\b(JACKPOT|ACCURACY|GUARANTEED?|SURE\s*SHOT|BUMPER)\b/;
const HORIZON_RES: Array<[InfoHorizon, RegExp]> = [
  ['MONTHS', /\b(MONTHS?|MONTHLY|LONG\s*TERM|YEARS?|QUARTERS?)\b/],
  ['WEEKS', /\b(WEEKS?|WEEKLY|SWING|POSITIONAL|HAFTE?)\b/],
  ['DAYS', /\b(DAYS?|TOMORROW|KAL|BTST|STBT|SESSIONS?)\b/],
  ['INTRADAY', /\b(TODAY|INTRADAY|AAJ)\b/],
];

const OPTION_BRAG_RE = /\b(DONE|HIT|ACHIEVED|\d+(\.\d+)?X|DOUBLE|TRIPLE|HOGYI|HOGAYI|HOGAYA|HOGYA|GYI)\b/;
const NO_BRAG_IF: ReadonlySet<string> = new Set(['BUY', 'SELL', 'ABOVE', 'BELOW', 'SL', 'LONG', 'SHORT']);

/** Results / orders / a gap: a company event that moves the stock. */
const CATALYST_RE = /\b(RESULTS?|Q[1-4]|EARNINGS|ORDERS?|BAGS|UPGRADES?|DOWNGRADES?|DIVIDEND|BONUS|SPLIT|BUYBACK|MERGER|ACQUISITION|GAP UP|GAP DOWN|UPPER CIRCUIT|LOWER CIRCUIT)\b/;
const CATALYST_BULL = /\b(STRONG|EXCELLENT|GOOD|SOLID|BUMPER|BEAT|BEATS|BEST|RECORD|STELLAR|GAP UP|UPPER CIRCUIT|UPGRADES?|WINS?|BAGS)\b/;
// "good results and stock is down" is two-sided (NEUTRAL), not a bull call.
const CATALYST_BEAR = /\b(WEAK|POOR|MISS|MISSES|DISAPPOINTING|BAD|GAP DOWN|LOWER CIRCUIT|DOWNGRADES?|LOSS|IS DOWN|STOCK DOWN|FALLS?|FELL)\b/;
/** Trader phrases that settle the direction outright (the words inside them would vote the other way). */
const MARKET_BEAR_RE = /\b(SELL ON RISE|SELL ON RALLY|SELL THE RISE|SELL EVERY BOUNCE|SELL IT)\b/;
const MARKET_BULL_RE = /\b(BUY ON DIPS?|BUY THE DIP|BUY EVERY DIP)\b/;
/** A level to watch / a list of names to keep an eye on. */
const WATCH_RE = /\b(BREAKOUT|BREAK OUT|BREAKDOWN|RADAR|WATCH ?LIST|KEEP AN EYE|MOMENTUM|POSSIBLE IN|LOOK OUT)\b/;
/** Global / macro news: no Indian instrument, but it can move NIFTY. */
const MACRO_RE = /\b(US|USA|AMERICA|AMERICAN|DOW|NASDAQ|S&P|FED|FOMC|RATE CUT|RATE HIKE|INFLATION|CPI|GDP|RECESSION|CHINA|CHINESE|JAPAN|NIKKEI|HANG SENG|EUROPE|BRAZIL|ETF|ELECTION|WAR|TARIFFS?|DOLLAR|DXY|BOND YIELDS?|GLOBAL MARKETS?|GIFT NIFTY|SGX|FIIS?|DIIS?)\b/;
/** A market-wide view with no instrument named. */
const MARKET_RE = /\b(MARKET|MARKETS|DALAL STREET|INDIA VIX|VIX|BULLISH DAY|BEARISH DAY|INDICES)\b/;
const MACRO_MOVE = /\b(CRASH|CRASHED|CRASHES|FALLS?|FELL|PLUNGE|PLUNGES|SLUMP|RALLY|RALLIES|SURGE|SURGES|JUMPS?|SOARS?|\d+(\.\d+)? ?%)/;

const RECAP_HEADER_RE =
  /\b(LIVE\s+ANALYSIS\s+OF|RECAP|TODAY'?S?\s+(RESULTS?|PERFORMANCE)|YESTERDAY'?S?\s+(CALLS?|RESULTS?|PERFORMANCE)|RESULTS?\s+OF\s+(THE\s+)?(DAY|WEEK|TODAY|YESTERDAY)|DAY\s+SUMMARY|TRADES?\s+OF\s+THE\s+DAY|PERFORMANCE\s+(REPORT|UPDATE)|CALLS?\s+(RESULT|STATUS))\b/;

// ─── Helpers ────────────────────────────────────────────────────────────────

const cleanNum = (t: string) => (isNumber(t) ? Number(t) : NaN);

export function driverName(underlying: string): string {
  return underlying === 'CRUDEOIL' ? 'CRUDE' : underlying;
}

/**
 * An index name for an un-named level by its size (NIFTY 15k–35k, BANKNIFTY 40k–65k, SENSEX 66k–100k),
 * on a multiple of 10: channels quote spot levels like 22480, not only strikes (2026-10-28 a "22480 se
 * pehle…" view was NOISE when this asked for the 50 / 100 strike grid).
 */
export function inferIndex(v: number): string | null {
  if (!Number.isInteger(v) || v % 10 !== 0) return null;
  if (v >= 15_000 && v <= 35_000) return 'NIFTY';
  if (v >= 40_000 && v <= 65_000) return 'BANKNIFTY';
  if (v > 65_000 && v <= 100_000) return 'SENSEX';
  return null;
}

function validLevel(underlying: string, v: number): boolean {
  if (!(v > 0)) return false;
  const r = INDEX_RANGE[underlying];
  if (r) return v >= r[0] && v <= r[1];
  return v >= 0.5;
}

function splitSegments(raw: string): string[] {
  return String(raw ?? '')
    .split(/\r?\n+|\s{2,}|[.!?।…]+(?=\s|$)|\s+(?:BUT|LEKIN|LEKEN|HOWEVER)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function infoNormalise(seg: string, vocab: Vocabulary): Normalised {
  let s = ` ${seg} `.toUpperCase();
  for (const [re, to] of INFO_ALIASES) s = s.replace(re, to);
  return normalise(s, vocab);
}

interface Mention {
  i: number;
  name: string;
}

function numberNear(t: readonly string[], i: number, k: number): boolean {
  for (let j = Math.max(0, i - k); j <= Math.min(t.length - 1, i + k); j++) if (j !== i && isNumber(t[j])) return true;
  return false;
}

function contractNext(t: readonly string[], i: number): boolean {
  if (t[i + 1] === 'FUT') return true;
  return isNumber(t[i + 1] ?? '') && (t[i + 2] === 'CE' || t[i + 2] === 'PE');
}

/** Named entities: vocabulary names; ambiguous / stop words only beside a number (index/commodity) or a contract (stock). */
function mentionsOf(t: readonly string[], vocab: Vocabulary): Mention[] {
  const out: Mention[] = [];
  for (let i = 0; i < t.length; i++) {
    const name = vocab.names.get(t[i]);
    if (!name) continue;
    const cls = vocab.classOf.get(name);
    if (AMBIGUOUS_SYMBOLS.has(t[i]) || INFO_STOPWORDS.has(t[i]) || LOOSE_STOPWORDS.has(t[i])) {
      if (cls === 'STOCK' ? !contractNext(t, i) : !numberNear(t, i, 3)) continue;
    }
    out.push({ i, name });
  }
  return out;
}

interface LevelTok {
  i: number;
  v: number;
}

function levelTokens(t: readonly string[]): LevelTok[] {
  const out: LevelTok[] = [];
  for (let i = 0; i < t.length; i++) {
    const v = cleanNum(t[i]);
    if (!Number.isFinite(v) || t[i].replace('.', '').length >= 7) continue;
    if (NOT_LEVEL_AFTER.has(t[i + 1] ?? '') || NOT_LEVEL_BEFORE.has(t[i - 1] ?? '')) continue;
    out.push({ i, v });
  }
  return out;
}

/** Index of each occurrence of a word set or a bigram list in the tokens. */
function hitsOf(t: readonly string[], words: ReadonlySet<string>, bigrams: readonly string[] = []): number[] {
  const out: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (words.has(t[i])) out.push(i);
    else if (i + 1 < t.length && bigrams.includes(`${t[i]} ${t[i + 1]}`)) out.push(i);
  }
  return out;
}

function nearestMention(mentions: readonly Mention[], i: number, ok: (m: Mention) => boolean = () => true): Mention | null {
  let best: Mention | null = null;
  let bestD = Infinity;
  for (const m of mentions) {
    if (!ok(m)) continue;
    const d = Math.abs(m.i - i);
    // Ties go to the mention BEFORE the word ("crude bullish, nifty bearish").
    if (d < bestD || (d === bestD && best !== null && m.i < best.i)) {
      best = m;
      bestD = d;
    }
  }
  return best;
}

function directionOfWords(t: readonly string[]): InfoDirection | null {
  const up = t.some((w) => UP_WORDS.has(w));
  const down = t.some((w) => DOWN_WORDS.has(w));
  if (up === down) return null;
  return up ? 'UP' : 'DOWN';
}

/**
 * "if … then …" → the condition starts after the IF word and ends at the THEN word. Without an IF word,
 * "X gaya toh Y" is a condition only when a NAMED entity precedes the "toh" and a level or an entity
 * follows it ("brent 95 ke upar gaya toh nifty 21500"). null when the part is not conditional.
 */
function splitConditional(t: readonly string[], vocab: Vocabulary): { condFrom: number; condTo: number } | null {
  const i = t.findIndex((w) => IF_WORDS.has(w));
  if (i >= 0) {
    let j = t.findIndex((w, k) => k > i && THEN_WORDS.has(w));
    // A bare "to" as "then" (Hinglish "agar 22000 toota to 21500"), never inside a number range.
    if (j < 0) j = t.findIndex((w, k) => k > i + 1 && w === 'TO' && !(isNumber(t[k - 1] ?? '') && isNumber(t[k + 1] ?? '')));
    return { condFrom: i + 1, condTo: j < 0 ? t.length : j };
  }
  const j = t.findIndex((w) => THEN_WORDS.has(w));
  if (j <= 0 || j >= t.length - 1) return null;
  const after = t.slice(j + 1);
  if (mentionsOf(t.slice(0, j), vocab).length === 0) return null;
  if (levelTokens(after).length === 0 && mentionsOf(after, vocab).length === 0) return null;
  return { condFrom: 0, condTo: j };
}

interface Votes {
  BULL: number;
  BEAR: number;
  NEUTRAL: number;
  STRUCT: number;
}

interface Draft {
  underlying: string;
  named: boolean;
  levels: number[];
  target: number | null;
  votes: Votes;
  oi: InfoOi | null;
  condition: (InfoCondition & { underlying: string }) | null;
  bias: InfoBias | null;
  biasFromWords: boolean;
}

const zeroVotes = (): Votes => ({ BULL: 0, BEAR: 0, NEUTRAL: 0, STRUCT: 0 });

// ─── Analysis ───────────────────────────────────────────────────────────────

/**
 * The detector + rule extractor. Per segment (lines, sentences, "but"), "if … then …" splits into a
 * condition (its entity is the scenario's driver) and a consequence (its items carry the condition).
 * Levels attach to the nearest named entity they are plausible for, else to the index their size
 * implies, else to the post's running entity. Bias: OI note (put-heavy → BULL, call-heavy → BEAR) >
 * bias words > a target vs the reference price > the crude ↔ index macro link > structure words
 * (support/resistance → NEUTRAL).
 */
export function analyseInfo(raw: string, vocab: Vocabulary, refs?: RefPrices): InfoAnalysis {
  const drafts = new Map<string, Draft>();
  /** Levels / votes found for a driver inside its own condition: merged only if the driver gets an item. */
  const condExtras = new Map<string, { levels: number[]; votes: Votes }>();
  const reasons = new Set<string>();
  let entity = false;
  let content = false;
  let carry: string | null = null;
  let postDriver: (InfoCondition & { underlying: string }) | null = null;
  const allText: string[] = [];
  /** Every segment's tokens ('|' between segments) and every owned level at its global index (the OI rule reads across sentences). */
  const allTokens: string[] = [];
  const ownedLevels: Array<{ gi: number; v: number; owner: string }> = [];

  const draftOf = (u: string, named: boolean): Draft => {
    let d = drafts.get(u);
    if (!d) {
      d = { underlying: u, named, levels: [], target: null, votes: zeroVotes(), oi: null, condition: null, bias: null, biasFromWords: false };
      drafts.set(u, d);
    }
    if (named) d.named = true;
    return d;
  };

  const ownerOf = (v: number, i: number, mentions: readonly Mention[], fallback: string | null): { name: string; named: boolean } | null => {
    const m = nearestMention(mentions, i, (x) => validLevel(x.name, v));
    if (m) return { name: m.name, named: true };
    const inferred = inferIndex(v);
    if (inferred) return { name: inferred, named: false };
    if (fallback && validLevel(fallback, v)) return { name: fallback, named: false };
    return null;
  };

  /** One part of a segment. `sink` collects into drafts, or into the driver's condition extras. */
  const processPart = (t: string[], offset: number, ctx: { fallback: string | null; condition: (InfoCondition & { underlying: string }) | null; condOf?: string }) => {
    if (t.length === 0) return;
    const mentions = mentionsOf(t, vocab);
    if (mentions.length) {
      entity = true;
      reasons.add('entity');
    }
    const touched = new Set<string>();
    const levelOwner = new Map<number, string>();
    const addLevel = (u: string, named: boolean, v: number) => {
      if (ctx.condOf && u === ctx.condOf) {
        const x = condExtras.get(u) ?? { levels: [], votes: zeroVotes() };
        if (!x.levels.includes(v)) x.levels.push(v);
        condExtras.set(u, x);
        return;
      }
      const d = draftOf(u, named);
      if (!d.levels.includes(v)) d.levels.push(v);
      touched.add(u);
    };

    const levels = levelTokens(t);
    for (const lv of levels) {
      const o = ownerOf(lv.v, lv.i, mentions, ctx.fallback);
      if (!o) continue;
      if (!o.named) {
        entity = true;
        reasons.add('entity');
      }
      content = true;
      reasons.add('level');
      levelOwner.set(lv.i, o.name);
      ownedLevels.push({ gi: offset + lv.i, v: lv.v, owner: o.name });
      addLevel(o.name, o.named, lv.v);
    }
    if (hitsOf(t, OI_WORDS, ['OPEN INTEREST', 'BUILD UP']).length) {
      content = true;
      reasons.add('oi');
    }

    // Bias / structure words → the nearest entity, else the part's level owner, else the running entity.
    const firstOwner = levels.map((lv) => levelOwner.get(lv.i)).find((x): x is string => !!x) ?? null;
    const vote = (i: number, k: keyof Votes) => {
      content = true;
      reasons.add(k === 'STRUCT' ? 'structure' : 'bias');
      const m = nearestMention(mentions, i);
      const u = m?.name ?? firstOwner ?? ctx.fallback;
      if (!u) return;
      if (ctx.condOf && u === ctx.condOf) {
        const x = condExtras.get(u) ?? { levels: [], votes: zeroVotes() };
        x.votes[k]++;
        condExtras.set(u, x);
        return;
      }
      draftOf(u, !!m).votes[k]++;
      touched.add(u);
    };
    for (const i of hitsOf(t, BULL_WORDS, BULL_BIGRAMS)) vote(i, 'BULL');
    for (const i of hitsOf(t, BEAR_WORDS, BEAR_BIGRAMS)) vote(i, 'BEAR');
    for (const i of hitsOf(t, NEUTRAL_WORDS, NEUTRAL_BIGRAMS)) vote(i, 'NEUTRAL');
    for (const i of hitsOf(t, STRUCT_WORDS)) vote(i, 'STRUCT');

    // Target phrase: the first level of the part before it, else the first after it.
    for (const p of hitsOf(t, TARGET_WORDS, TARGET_BIGRAMS)) {
      content = true;
      reasons.add('target');
      const before = levels.find((lv) => lv.i < p && levelOwner.has(lv.i));
      const after = levels.find((lv) => lv.i > p && levelOwner.has(lv.i));
      const lv = before ?? after;
      if (!lv) continue;
      const u = levelOwner.get(lv.i) as string;
      if (ctx.condOf && u === ctx.condOf) continue;
      const d = drafts.get(u);
      if (d && d.target === null) d.target = lv.v;
    }

    for (const u of touched) {
      const d = drafts.get(u);
      if (d && ctx.condition && ctx.condition.underlying !== u) d.condition ??= ctx.condition;
    }
    const lastMention = mentions[mentions.length - 1]?.name ?? null;
    carry = lastMention ?? [...touched].pop() ?? carry;
  };

  for (const seg of splitSegments(raw)) {
    const n = infoNormalise(seg, vocab);
    const t = n.tokens;
    if (t.length === 0) continue;
    allText.push(n.text);
    const base = allTokens.length;
    allTokens.push(...t, '|');
    const sc = splitConditional(t, vocab);
    if (!sc) {
      processPart(t, base, { fallback: carry, condition: postDriver });
      continue;
    }
    content = true;
    reasons.add('conditional');
    const cond = t.slice(sc.condFrom, sc.condTo);
    const cons = t.slice(sc.condTo + 1);
    const cm = mentionsOf(cond, vocab);
    const condLevels = levelTokens(cond);
    const driverU = cm[0]?.name ?? condLevels.map((lv) => inferIndex(lv.v)).find((x): x is string => !!x) ?? carry;
    let driver: (InfoCondition & { underlying: string }) | null = null;
    if (driverU) {
      entity = true;
      reasons.add('entity');
      driver = { driver: driverName(driverU), direction: directionOfWords(cond), underlying: driverU };
      postDriver ??= driver;
      processPart(cond, base + sc.condFrom, { fallback: driverU, condition: null, condOf: driverU });
    }
    if (cons.length) processPart(cons, base + sc.condTo + 1, { fallback: driverU, condition: driver });
    else if (driverU) carry = driverU;
  }

  // OI note (post-level: the OI word, the strike and the side often sit in different sentences): an OI
  // word + a heaviness word + an owned strike + a side (the nearest put/call word, else the CE/PE beside it).
  const oiAt = hitsOf(allTokens, OI_WORDS, ['OPEN INTEREST', 'BUILD UP']);
  const heavyAt = allTokens.findIndex((w) => HEAVY_WORDS.has(w) || /^\d+(\.\d+)?X$/.test(w));
  if (oiAt.length && heavyAt >= 0 && ownedLevels.length) {
    const s = ownedLevels.reduce((a, b) => (Math.abs(b.gi - oiAt[0]) < Math.abs(a.gi - oiAt[0]) ? b : a));
    const sideIdx = [...hitsOf(allTokens, PUT_WORDS), ...hitsOf(allTokens, CALL_WORDS)].sort((a, b) => Math.abs(a - s.gi) - Math.abs(b - s.gi))[0];
    const next = allTokens[s.gi + 1];
    const side: 'CE' | 'PE' | null = sideIdx !== undefined ? (PUT_WORDS.has(allTokens[sideIdx]) ? 'PE' : 'CE') : next === 'PE' ? 'PE' : next === 'CE' ? 'CE' : null;
    if (side) {
      entity = true;
      const d = draftOf(s.owner, false);
      const heavy = allTokens[heavyAt].toLowerCase();
      d.oi = { strike: s.v, side, note: `${side === 'PE' ? 'put' : 'call'} OI ${heavy} → ${side === 'PE' ? 'support' : 'resistance'}` };
      if (!d.levels.includes(s.v)) d.levels.push(s.v);
    }
  }

  // Merge a driver's own condition levels / votes into its item ("agar nifty 22000 tootega toh 21500").
  for (const [u, x] of condExtras) {
    const d = drafts.get(u);
    if (!d) continue;
    d.levels = [...x.levels.filter((v) => !d.levels.includes(v)), ...d.levels];
    for (const k of Object.keys(x.votes) as Array<keyof Votes>) d.votes[k] += x.votes[k];
  }

  // Bias resolution.
  let wantsRefs = false;
  for (const d of drafts.values()) {
    if (d.oi) {
      d.bias = d.oi.side === 'PE' ? 'BULL' : 'BEAR';
      d.biasFromWords = true;
    } else if (d.votes.BULL > d.votes.BEAR) {
      d.bias = 'BULL';
      d.biasFromWords = true;
    } else if (d.votes.BEAR > d.votes.BULL) {
      d.bias = 'BEAR';
      d.biasFromWords = true;
    } else if (d.votes.BULL > 0) d.bias = 'NEUTRAL'; // two-sided: "bullish above X, bearish below Y"
  }
  for (const d of drafts.values()) {
    if (d.bias !== null || d.target === null) continue;
    const ref = refs?.get(d.underlying);
    if (ref && ref > 0) {
      if (d.target > ref * 1.001) d.bias = 'BULL';
      else if (d.target < ref * 0.999) d.bias = 'BEAR';
    } else if (INDEX_RANGE[d.underlying] && !refs) wantsRefs = true;
  }
  // Macro link: crude up hurts Indian equity indices (and the reverse), only between items the post links.
  const isIndex = (u: string) => vocab.classOf.get(u) === 'INDEX' || !!INDEX_RANGE[u];
  for (const d of drafts.values()) {
    if (d.bias === null && isIndex(d.underlying) && d.condition?.driver === 'CRUDE' && d.condition.direction) {
      d.bias = d.condition.direction === 'UP' ? 'BEAR' : 'BULL';
    }
  }
  const crude = drafts.get('CRUDEOIL');
  if (crude && crude.bias === null) {
    const linked = [...drafts.values()].find((d) => isIndex(d.underlying) && d.condition?.driver === 'CRUDE' && (d.bias === 'BULL' || d.bias === 'BEAR'));
    if (linked) crude.bias = linked.bias === 'BEAR' ? 'BULL' : 'BEAR';
  }
  for (const d of drafts.values()) {
    if (!d.condition || d.condition.direction !== null) continue;
    const drv = drafts.get(d.condition.underlying);
    if (drv && (drv.bias === 'BULL' || drv.bias === 'BEAR')) d.condition = { ...d.condition, direction: drv.bias === 'BULL' ? 'UP' : 'DOWN' };
    else if (d.condition.driver === 'CRUDE' && isIndex(d.underlying) && (d.bias === 'BULL' || d.bias === 'BEAR')) {
      d.condition = { ...d.condition, direction: d.bias === 'BEAR' ? 'UP' : 'DOWN' };
    }
  }
  for (const d of drafts.values()) if (d.bias === null && (d.votes.NEUTRAL > 0 || d.votes.STRUCT > 0)) d.bias = 'NEUTRAL';

  const text = allText.join(' ');
  const horizon = HORIZON_RES.find(([, re]) => re.test(text))?.[0] ?? null;
  const kept = [...drafts.values()].filter((d) => d.levels.length > 0 || d.bias !== null || d.oi !== null);
  const items: InfoItem[] = kept.map((d) => ({
    underlying: d.underlying,
    bias: d.bias,
    levels: d.levels,
    targetLevel: d.target,
    oi: d.oi,
    condition: d.condition ? { driver: d.condition.driver, direction: d.condition.direction } : null,
    horizon,
  }));
  const named = kept.length > 0 && kept.every((d) => d.named);
  const worded = kept.length > 0 && kept.every((d) => d.biasFromWords);
  const confidence = Math.round(Math.min(0.85, 0.5 + (named ? 0.1 : 0) + (worded ? 0.15 : 0) + (items.length && items.every((i) => i.bias) ? 0.05 : 0)) * 100) / 100;
  return { isInfo: entity && content, items, reasons: [...reasons], confidence, wantsRefs };
}

/** RECAP: a recap header or P&L words AND a named contract with a price move / "done". */
export function recapReason(raw: string, norm: Normalised, vocab: Vocabulary): string | null {
  const header = RECAP_HEADER_RE.test(String(raw ?? '').toUpperCase());
  const brag = RECAP_RE.test(norm.text);
  // "22750 pe done target" / "22750 pe 3x hogyi" / "double hogyi put": an option the channel says paid,
  // with no entry instruction — a brag about a past call, never a view on the index.
  const tk = norm.tokens;
  const option = hasStrikePair(tk) || tk.some((w, i) => isNumber(w) && Number(w) >= 100 && tk.slice(i + 1).some((x) => x === 'PUT' || x === 'CALL'));
  if (option && OPTION_BRAG_RE.test(norm.text) && !tk.some((w) => NO_BRAG_IF.has(w))) return 'recap: an option the channel says paid';
  if (!header && !brag) return null;
  const t = norm.tokens;
  const contract = hasStrikePair(t) || instrumentHits(t, vocab).length > 0;
  const move = t.some((w, i) => w === 'TO' && isNumber(t[i - 1] ?? '') && isNumber(t[i + 1] ?? '')) || /\b(DONE|BOOKED|HIT|ACHIEVED)\b/.test(norm.text);
  if (!contract || !move) return null;
  return header ? 'recap: results of the channel\'s calls' : 'recap: P&L with named calls';
}

export const hasBias = (i: Pick<InfoItem, 'bias'>) => i.bias !== null;

/**
 * Class of a post the rule parser did not take and that is no update: INFO / RECAP / NOISE, or null
 * when none applies (the caller keeps its NOISE-by-prefilter / LLM-parse path). A post with an
 * explicit trade instruction (verb + SL/target) is never INFO.
 */
export function classifyCommentary(raw: string, pf: PrefilterResult, vocab: Vocabulary, refs?: RefPrices): CommentaryClass | null {
  const out = (kind: CommentaryClass['kind'], reason: string, a?: InfoAnalysis, needsLlm = false): CommentaryClass => ({
    kind,
    reason,
    items: a?.items ?? [],
    confidence: a?.confidence ?? 0,
    needsLlm,
    wantsRefs: a?.wantsRefs ?? false,
  });
  if (pf.reason === 'empty') return out('NOISE', 'empty');
  const recap = recapReason(raw, pf.norm, vocab);
  if (recap) return out('RECAP', recap);
  const t = pf.norm.tokens;
  if (pf.underlyings.length === 0 && t.includes(SECTOR_INDEX_TOKEN)) return out('INFO', 'sector index (no derivatives)');
  // A call (verb + SL/target), or a pre-filter positive with an explicit buy/sell verb ("buy only above
  // 24050"): the rule parser / LLM parse decides, never INFO.
  if (hasTradeInstruction(t) || (pf.pass && t.some((w) => CALL_VERBS.has(w)))) return null;
  const a = analyseInfo(raw, vocab, refs);
  if (AD_RE.test(pf.norm.text) || HYPE_RE.test(pf.norm.text)) {
    const concrete = a.items.some((i) => i.levels.length > 0 && (i.bias === 'BULL' || i.bias === 'BEAR' || i.oi !== null));
    return concrete ? out('INFO', 'info: ad with concrete market content', a) : out('NOISE', 'ad');
  }
  if (RECAP_RE.test(pf.norm.text)) return out('NOISE', 'pnl brag (no named calls)');
  const typed = stockEventItems(pf.norm, vocab, a);
  if (typed) return out('INFO', typed.reason, { ...a, items: typed.items });
  if (a.isInfo) return out('INFO', `info: ${a.reasons.join(', ')}`, { ...a, items: a.items.map((i) => ({ ...i, kind: i.kind ?? 'VIEW' })) }, !a.items.some(hasBias));
  const market = marketItem(pf.norm, a);
  if (market) return out('INFO', market.reason, { ...a, items: [market.item] });
  const view = viewReason(pf);
  if (view) return out('INFO', view, a);
  // A pre-filter positive goes to the LLM parse; anything else would be NOISE by default.
  const unsure = pf.pass ? null : unsureReason(pf, a);
  if (unsure) return { ...out('NOISE', unsure, a, true), unsure: true };
  return null;
}

/** Market words a view is written in that the rule lexicon has no bias or level for. */
const MARKET_TALK: ReadonlySet<string> = new Set([
  'SECTOR', 'SECTORS', 'OPEN', 'OPENED', 'OPENING', 'FLAT', 'GAP', 'GAPUP', 'GAPDOWN', 'SUPPORT', 'RESISTANCE',
  'ABOVE', 'BELOW', 'OI', 'PCR', 'TREND', 'TRENDING', 'WEAKEST', 'STRONGEST', 'OUTPERFORM', 'UNDERPERFORM', 'LISTING', 'IPO',
]);

/**
 * Talk about the market the rules could not place ("Bank Nifty is the weakest sector now, followed by
 * Reliance", "crude oil down and nifty up", "focus on IT sector on Monday"): an instrument, an index
 * level, or a market word in a post of at least three words. The cheap LLM decides (owner 2026-10-28:
 * "there are quite information but they are being marked as noise"); without its answer the post stays NOISE.
 */
function unsureReason(pf: PrefilterResult, a: InfoAnalysis): string | null {
  const t = pf.norm.tokens;
  if (t.filter((w) => /^[A-Z]{2,}$/.test(w)).length < 3) return null;
  if (pf.underlyings.length > 0 || a.reasons.includes('entity')) return 'unsure: names an instrument';
  if (levelTokens(t).some((l) => inferIndex(l.v))) return 'unsure: an index level';
  const text = pf.norm.text;
  const word = t.find((w) => MARKET_TALK.has(w) || BULL_WORDS.has(w) || BEAR_WORDS.has(w));
  if (word) return `unsure: market word (${word.toLowerCase()})`;
  const re = [MARKET_RE, MACRO_RE, CATALYST_RE, WATCH_RE].find((r) => r.test(text));
  return re ? `unsure: market word (${(text.match(re) as RegExpMatchArray)[0].toLowerCase()})` : null;
}

/** Stocks named in the post, in order (ambiguous words only beside a contract). */
function stocksNamed(norm: Normalised, vocab: Vocabulary): string[] {
  return [...new Set(instrumentHits(norm.tokens, vocab).map((h) => h.name).filter((n) => vocab.classOf.get(n) === 'STOCK'))];
}

const blankItem = (underlying: string, bias: InfoBias | null, kind: InfoKind): InfoItem => ({
  underlying,
  bias,
  levels: [],
  targetLevel: null,
  oi: null,
  condition: null,
  horizon: null,
  kind,
});

/**
 * A CATALYST (results / orders / a gap) or a WATCH (a breakout level, a momentum list) on the stocks a
 * post names — one item per stock, the levels the rule extractor found kept. null when neither applies.
 */
function stockEventItems(norm: Normalised, vocab: Vocabulary, a: InfoAnalysis): { reason: string; items: InfoItem[] } | null {
  const stocks = stocksNamed(norm, vocab);
  if (stocks.length === 0) return null;
  const text = norm.text;
  const found = new Map(a.items.map((i) => [i.underlying, i]));
  const build = (kind: InfoKind, bias: InfoBias | null) =>
    stocks.map((s) => {
      const i = found.get(s);
      return i ? { ...i, bias: i.bias === 'BULL' || i.bias === 'BEAR' ? i.bias : bias ?? i.bias, kind } : blankItem(s, bias, kind);
    });
  if (CATALYST_RE.test(text)) {
    const bull = CATALYST_BULL.test(text);
    const bear = CATALYST_BEAR.test(text);
    const bias: InfoBias | null = bull === bear ? (bull ? 'NEUTRAL' : null) : bull ? 'BULL' : 'BEAR';
    return { reason: `catalyst: ${(text.match(CATALYST_RE) as RegExpMatchArray)[0].toLowerCase()}${bias ? ` (${bias.toLowerCase()})` : ''}`, items: build('CATALYST', bias) };
  }
  if (WATCH_RE.test(text)) {
    const bias: InfoBias = /\b(BREAKDOWN|BREAK DOWN|BELOW)\b/.test(text) ? 'BEAR' : 'BULL';
    return { reason: `watch: ${(text.match(WATCH_RE) as RegExpMatchArray)[0].toLowerCase()} (${stocks.length} name${stocks.length > 1 ? 's' : ''})`, items: build('WATCH', bias) };
  }
  return null;
}

/** Bull / bear words of a whole post; a word right after "AFTER" is the backdrop, not the view ("bullish day after gap down"). */
function postBias(t: readonly string[]): InfoBias | null {
  let bull = 0;
  let bear = 0;
  for (let i = 0; i < t.length; i++) {
    if (t.slice(Math.max(0, i - 3), i).includes('AFTER')) continue;
    const pair = i + 1 < t.length ? `${t[i]} ${t[i + 1]}` : '';
    if (BULL_WORDS.has(t[i]) || BULL_BIGRAMS.includes(pair)) bull++;
    else if (BEAR_WORDS.has(t[i]) || BEAR_BIGRAMS.includes(pair) || MACRO_BEAR.has(t[i])) bear++;
    else if (MACRO_BULL.has(t[i])) bull++;
  }
  if (bull === bear) return bull > 0 ? 'NEUTRAL' : null;
  return bull > bear ? 'BULL' : 'BEAR';
}
const MACRO_BEAR: ReadonlySet<string> = new Set(['FALLS', 'FELL', 'PLUNGES', 'SLUMP', 'CRASHES', 'SELLING', 'PRESSURE']);
const MACRO_BULL: ReadonlySet<string> = new Set(['RALLIES', 'SURGE', 'SURGES', 'JUMPS', 'SOARS']);

/**
 * No Indian instrument named: global / macro news (MACRO) or a market-wide view (MARKET), both read as
 * a view on NIFTY so the self-review can measure whether such posts ever lead it. null otherwise.
 */
function marketItem(norm: Normalised, a: InfoAnalysis): { reason: string; item: InfoItem } | null {
  if (a.items.length > 0) return null;
  const text = norm.text;
  const t = norm.tokens;
  if (MACRO_RE.test(text) && MACRO_MOVE.test(text)) {
    const bias = postBias(t);
    if (bias) return { reason: `macro: ${(text.match(MACRO_RE) as RegExpMatchArray)[0].toLowerCase()} (${bias.toLowerCase()}, read against NIFTY)`, item: blankItem('NIFTY', bias, 'MACRO') };
  }
  if (MARKET_RE.test(text)) {
    // Only the words beside the market word: a long pep-talk that happens to say "market" is not a view.
    // The market word itself, else the first word of a two-word one ("BULLISH DAY", "INDIA VIX").
    let at = t.findIndex((w) => MARKET_RE.test(w));
    if (at < 0) at = t.findIndex((w, i) => MARKET_RE.test(`${w} ${t[i + 1] ?? ''}`));
    // "don't miss IF market will crash" is a hypothetical, not a view.
    if (t.slice(Math.max(0, at - 2), at).some((w) => IF_WORDS.has(w))) return null;
    const near = t.slice(Math.max(0, at - 4), at + 6);
    const volatile = near.some((w) => w === 'VOLATILE' || w === 'VOLATILITY');
    const phrase: InfoBias | null = MARKET_BEAR_RE.test(text) ? 'BEAR' : MARKET_BULL_RE.test(text) ? 'BULL' : null;
    const bias = phrase ?? postBias(near) ?? (volatile ? 'NEUTRAL' : null);
    if (bias) return { reason: `market view (${bias.toLowerCase()}, read against NIFTY)`, item: blankItem('NIFTY', bias, 'MARKET') };
  }
  return null;
}

/** Stored items (jsonb) → InfoItem[]; anything malformed is dropped. */
export function asInfoItems(v: unknown): InfoItem[] {
  if (!Array.isArray(v)) return [];
  const out: InfoItem[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    if (typeof o.underlying !== 'string' || !o.underlying) continue;
    const bias = o.bias === 'BULL' || o.bias === 'BEAR' || o.bias === 'NEUTRAL' ? o.bias : null;
    const levels = Array.isArray(o.levels) ? o.levels.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
    const oi = o.oi && typeof o.oi === 'object' ? (o.oi as InfoOi) : null;
    const condition = o.condition && typeof o.condition === 'object' ? (o.condition as InfoCondition) : null;
    const horizon = ['INTRADAY', 'DAYS', 'WEEKS', 'MONTHS'].includes(String(o.horizon)) ? (o.horizon as InfoHorizon) : null;
    const target = Number(o.targetLevel);
    const kind = INFO_KINDS.includes(o.kind as InfoKind) ? (o.kind as InfoKind) : null;
    out.push({ underlying: o.underlying, bias, levels, targetLevel: Number.isFinite(target) && target > 0 ? target : null, oi, condition, horizon, ...(kind ? { kind } : {}) });
  }
  return out;
}
