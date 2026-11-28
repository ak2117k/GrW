import type { ExpiryHint } from './types';
import { multiWordAliases, resolveLooseNames, SECTOR_INDEX_TOKEN, type Vocabulary } from './vocabulary';

/**
 * Text normalisation shared by the pre-filter, the rule parser and the update detector. Everything
 * is deterministic and free: upper-case, the tip-channel emoji turned into the words they stand for,
 * synonyms folded ("STOP LOSS" → SL, "TARGET" / "T1" / 🎯 → TGT), multi-word underlyings joined
 * ("BANK NIFTY" → BANKNIFTY), fused contracts split ("950CE" → "950 CE") and explicit expiries lifted
 * out into an {@link ExpiryHint}.
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** Three-letter months only (Angel tradingsymbols). */
const MON3_RE = MONTHS.join('|');
/** A month written short or in full ("DEC", "DECEMBER", "SEPT", "SEPTEMBER"). */
const MONTH_RE = 'JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUNE?|JULY?|AUG(?:UST)?|SEP(?:T(?:EMBER)?)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?';
/** A month that is never an ordinary word before a number: no "MAY" (you may 20 …), no Hinglish "MAR". */
const MONTH_WORD_RE = 'JAN(?:UARY)?|FEB(?:RUARY)?|MARCH|APR(?:IL)?|JUNE?|JULY?|AUG(?:UST)?|SEP(?:T(?:EMBER)?)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?';
/** A strike + option type right before / after a word ("25700 PE", "25700PE"). */
const CONTRACT_AFTER = '(?=\\s*\\d{2,6}(?:\\.\\d+)?\\s*(?:CE|PE)\\b)';
const EXPIRY_AFTER = '(?=\\s*(?:EXPIRY|EXP)\\b)';

const EMOJI: Array<[RegExp, string]> = [
  [/🎯/gu, ' TGT '],
  [/[🛑⛔🚫]/gu, ' SL '],
  [/[✅✔☑]/gu, ' DONE '],
  [/[📈🟢⬆🔼]/gu, ' '],
  [/[📉🔴⬇🔽]/gu, ' '],
];

const SYNONYMS: Array<[RegExp, string]> = [
  [/\bSTOP\s*-?\s*LOSS(ES)?\b|\bS\s*\/\s*L\b|\bS\.L\.?(?=\s|\d|$)|\bSTOPLOSS\b|\bSTPLS\b|\bSTOP\b(?=\s*[:\-@]?\s*\d)/g, ' SL '],
  [/\bSL\s*[:\-=]+/g, ' SL '],
  [/\bT\s*([1-5])\b\s*[:\-=]?/g, ' TGT$1 '],
  [/\b(TARGETS?|TGTS?|TRGTS?|TRGT|TARGT|TAREGT|TG|TP|TRG)\b\s*[:\-=]*/g, ' TGT '],
  [/\b(\d+)\s*(CALLS?)\b/g, '$1 CE'],
  [/\b(\d+)\s*(PUTS?)\b/g, '$1 PE'],
  [/\bFUTURES?\b/g, ' FUT '],
  [/\bABV\b|\bABOVE\s*:/g, ' ABOVE '],
  [/\bBLW\b|\bBELOW\s*:/g, ' BELOW '],
  [/\bKE\s+UPAR\b|\bKE\s+UPER\b|\bUPAR\b|\bUPER\b/g, ' ABOVE '],
  [/\bKE\s+NEECHE\b|\bNEECHE\b|\bNICHE\b/g, ' BELOW '],
  [/\bKHARIDO\b|\bKHAREEDO\b|\bLE\s*LO\b|\bLELO\b|\bBUYING\b/g, ' BUY '],
  [/\bBECHO\b|\bBECH\s*DO\b/g, ' SELL '],
  [/\bHERO\s*-?\s*ZERO\b/g, ' HEROZERO '],
  [/\bCOST\s+TO\s+COST\b/g, ' CTC '],
  // Stock Gainers' "SUPPORT 3 VUEW 15" (prod 2026-11-20): a typo of its VIEW (= target) word.
  [/\bVUEW\b/g, ' VIEW '],
];

export interface Normalised {
  /** Upper-case, single-spaced, punctuation split out. */
  text: string;
  tokens: string[];
  expiry: ExpiryHint | null;
}

/**
 * Non-tradeable NSE sector / broad indices (no F&O). Tradeable ones (NIFTY BANK, NIFTY FIN SERVICE,
 * NIFTY MIDCAP SELECT, NIFTY NEXT 50) are vocabulary aliases instead. "BANK NIFTY IT …" is not one.
 */
export const SECTOR_INDEX_RE = new RegExp(
  '(?<!(BANK|FIN|MIDCAP|MIDCP)\\s*)\\b(NIFTY|CNX)\\s*(' +
    [
      'IT', 'PHARMA', 'AUTO', 'METALS?', 'REALTY', 'FMCG', 'PSU\\s*BANK', 'PVT\\s*BANK', 'PRIVATE\\s*BANK', 'MEDIA', 'ENERGY',
      'INFRA(STRUCTURE)?', 'C?PSE', 'COMMODITIES', 'CONSUMPTION', 'HEALTH\\s*CARE', 'OIL\\s*(&|AND)?\\s*GAS', 'MNC',
      'SERVICES\\s+SECTOR', 'DEFENCE', 'INDIA\\s+DEFENCE', 'CHEMICALS', 'CONSUMER\\s+DURABLES', 'TOURISM', 'DIGITAL', 'MANUFACTURING',
      'MIDCAP(?!\\s*SELECT)(\\s*(50|100|150))?', 'SMALL\\s*CAP(\\s*(50|100|250))?', 'MID\\s*SMALL\\s*CAP(\\s*400)?', 'ALPHA\\s*50',
    ].join('|') +
    ')\\b',
  'g',
);

const monthIdx =(m: string) => MONTHS.indexOf(m.slice(0, 3)) + 1;

function yearOf(y: string | undefined): number | null {
  if (!y) return null;
  const n = Number(y);
  if (!Number.isFinite(n)) return null;
  if (y.length === 2) return 2000 + n;
  return n >= 2020 && n <= 2099 ? n : null;
}

export function normalise(raw: string, vocab: Vocabulary): Normalised {
  // NFKC folds the "fancy font" letters tip channels post in (𝗕𝘂𝘆 𝟭𝟳 → Buy 17; prod 2026-10-26 crude call read as NOISE).
  let s = ` ${String(raw ?? '').normalize('NFKC')} `.toUpperCase();
  // A boilerplate disclaimer ("Above calls are Not Buy or Sell Levels …") carries action words of its own; drop it.
  s = s.replace(/\bDISCLAIMER\b[\s\S]*$|\bABOVE\s+CALLS?\s+ARE\s+NOT\s+BUY\b[\s\S]*$/, ' ');
  for (const [re, to] of EMOJI) s = s.replace(re, to);
  // URLs, @handles and long digit runs (phones, order ids) carry no price.
  s = s.replace(/HTTPS?:\/\/\S+|T\.ME\/\S+|WWW\.\S+/g, ' LINK ');
  s = s.replace(/₹|\bRS\.?(?=\s*\d)|\bINR(?=\s*\d)/g, ' ');
  // Sector / broad indices with no derivatives ("NIFTY IT", "NIFTY PSU BANK") are one non-instrument
  // token, BEFORE the alias join, so their "NIFTY" never reads as the NIFTY index.
  s = s.replace(SECTOR_INDEX_RE, ` ${SECTOR_INDEX_TOKEN} `);
  // Indian thousands separator inside a strike ("24,000 CE") — only next to CE/PE/FUT so "TGT 140,160" survives.
  s = s.replace(/\b(\d{1,2}),(\d{3})(?=\s*(CE|PE|FUT)\b)/g, '$1$2');

  const lifted = liftExpiry(s);
  s = lifted.s;
  const expiry = lifted.expiry;

  // Durations ('2-3 weeks', '5 days') are not prices; keep the unit as a horizon word.
  s = s.replace(/\b\d+(?:\s*(?:-|TO)\s*\d+)?\s*(DAYS?|WEEKS?|MONTHS?|SESSIONS?|HRS?|HOURS?|MINS?|MINUTES?)\b/g, ' $1 ');
  for (const [re, to] of SYNONYMS) s = s.replace(re, to);

  for (const [alias, name] of multiWordAliases(vocab)) {
    s = s.replace(new RegExp(`(^|[^A-Z0-9&])${escapeRe(alias).replace(/ /g, '\\s+')}(?=$|[^A-Z0-9&])`, 'g'), `$1${name}`);
  }
  // Fused contract tokens: TATAMOTORS950CE / BNF52000PE / NIFTYFUT / 24000CE.
  s = s.replace(/\b([A-Z&]{2,}?)(\d{2,6}(?:\.\d+)?)(CE|PE)\b/g, '$1 $2 $3');
  s = s.replace(/(\d)(CE|PE|FUT)\b/g, '$1 $2');
  // "SUNPHARMA 1920 ce.47" (prod 2026-11-09): the premium glued to the contract by a dot.
  s = s.replace(/(\d\s*)(CE|PE)\.(?=\d)/g, '$1$2 ');
  s = s.replace(/\b([A-Z&]{3,})FUT\b/g, '$1 FUT');
  // Number ranges "300-310" / "300 TO 310" become a TO token; any other dash is a separator.
  s = s.replace(/(\d)\s*(?:-|–|—|~|\bTO\b)\s*(?=\d)/g, '$1 TO ');
  s = s.replace(/(\d)\s*\/\s*(?=\d)/g, '$1 / ');
  s = s.replace(/(^|\s)[-–—]+(?=\s|$)/g, ' ');
  s = s.replace(/[-–—](?![\d])/g, ' ');
  s = s.replace(/(\d)\.(?!\d)/g, '$1 ');
  s = s.replace(/[@]/g, ' AT ');
  s = s.replace(/[^A-Z0-9&.%\- /]/g, ' ');
  s = s.replace(/(^|\s)\.+|\.+(?=\s|$)/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  const tokens = s ? resolveLooseNames(s.split(' '), vocab) : [];
  return { text: tokens.join(' '), tokens, expiry };
}

/**
 * The expiry the post names, from the raw text alone (no vocabulary): the same reading {@link normalise} does.
 * Used when a parser that is not the rule parser (the LLM) returned no expiry (audit 2026-11-28: Mr P
 * "Btst / Positional (December 29)" came back from the model with expiry null and was traded on the weekly).
 */
export function expiryHintOfText(raw: string | null | undefined): ExpiryHint | null {
  let s = ` ${String(raw ?? '').normalize('NFKC')} `.toUpperCase();
  s = s.replace(/\bDISCLAIMER\b[\s\S]*$|\bABOVE\s+CALLS?\s+ARE\s+NOT\s+BUY\b[\s\S]*$/, ' ');
  s = s.replace(/HTTPS?:\/\/\S+|T\.ME\/\S+|WWW\.\S+/g, ' LINK ');
  s = s.replace(/\b(\d{1,2}),(\d{3})(?=\s*(CE|PE|FUT)\b)/g, '$1$2');
  return liftExpiry(s).expiry;
}

/**
 * Lifts the written expiry out of an upper-cased post. Dates and named months win over relative words; the first
 * of each kind wins. Date / month words are blanked so their numbers are never read as prices; the word EXPIRY
 * itself stays (the rule parser tags it).
 */
function liftExpiry(input: string): { s: string; expiry: ExpiryHint | null } {
  let s = input;
  let named: ExpiryHint | null = null;
  let relative: ExpiryHint['relative'];
  const name = (h: ExpiryHint) => void (named ??= h);
  const rel = (r: NonNullable<ExpiryHint['relative']>) => void (relative ??= r);

  // Angel tradingsymbol: NIFTY28OCT2624000CE → NIFTY 24000 CE + expiry.
  s = s.replace(new RegExp(`\\b([A-Z&]+?)(\\d{2})(${MON3_RE})(\\d{2})(\\d{2,6}(?:\\.\\d+)?)(CE|PE)\\b`, 'g'), (_m, u, d, mo, y, k, t) => {
    name({ day: Number(d), month: monthIdx(mo), year: yearOf(y) });
    return ` ${u} ${k} ${t} `;
  });
  // "26 DECEX" / "01 DECEXP" (the fancy-font "DEC𝗘𝘅" after NFKC): the month glued to EX(P).
  s = s.replace(new RegExp(`\\b(\\d{1,2}(?:ST|ND|RD|TH)?\\s*[-/ ]?\\s*(?:${MONTH_RE}))(?:EXPIRY|EXP|EX)\\b`, 'g'), '$1 EXPIRY');
  // "28 OCT", "28OCT", "28-OCT-26", "28TH OCT", "29 DECEMBER 2026" — a day + month is an expiry.
  s = s.replace(new RegExp(`\\b(\\d{1,2})(?:ST|ND|RD|TH)?\\s*[-/ ]?\\s*(${MONTH_RE})\\b(?:\\s*[-/ ]?\\s*'?(\\d{4}|\\d{2})\\b(?!\\s*(CE|PE)))?`, 'g'), (m, d, mo, y) => {
    const day = Number(d);
    if (day < 1 || day > 31) return m;
    name({ day, month: monthIdx(mo), year: yearOf(y) });
    return ' ';
  });
  // "DECEMBER 29", "DEC 29TH, 2026" — month first (not a strike: "DEC 24000 CE" has more digits; not "OCT 25 CE").
  s = s.replace(
    new RegExp(`\\b(${MONTH_WORD_RE})\\s*[-/ ]?\\s*(\\d{1,2})(?:ST|ND|RD|TH)?\\b(?:\\s*,?\\s*(\\d{4})\\b)?(?!\\s*(?:[-/.]\\s*\\d|CE\\b|PE\\b|FUT\\b|%|TO\\b))`, 'g'),
    (m, mo, d, y) => {
      const day = Number(d);
      if (day < 1 || day > 31) return m;
      name({ day, month: monthIdx(mo), year: yearOf(y) });
      return ' ';
    },
  );
  // "NIFTY OCT 24000 CE" / "NOV FUT" — a bare month next to a contract is that month's expiry.
  s = s.replace(new RegExp(`\\b(${MONTH_RE})\\b(?=\\s*(\\d{2,6}(\\.\\d+)?\\s*(CE|PE)|FUT)\\b)`, 'g'), (_m, mo) => {
    name({ day: null, month: monthIdx(mo), year: null });
    return ' ';
  });
  // "DEC EXPIRY", "NOVEMBER EXPIRY", "DEC MONTHLY EXPIRY" — a month named as the expiry.
  s = s.replace(new RegExp(`\\b(${MONTH_RE})\\b(?=\\s*(?:MONTHLY\\s*)?(?:EXPIRY|EXP)\\b)`, 'g'), (_m, mo) => {
    name({ day: null, month: monthIdx(mo), year: null });
    return ' ';
  });
  // "EXPIRY - DECEMBER" (MCX COMMODITY's footer).
  s = s.replace(new RegExp(`(\\bEXPIRY\\s*[:\\-=]*\\s*)(${MONTH_WORD_RE})\\b(?!\\s*\\d)`, 'g'), (_m, pre, mo) => {
    name({ day: null, month: monthIdx(mo), year: null });
    return `${pre} `;
  });

  // Relative words, anchored on the word EXPIRY or on the contract itself (a bare "next week" / "monthly plan" is not one).
  s = s.replace(/\b(?:NEXT|AGLE|AGLI|AGLA)\s+(?:WEEK(?:LY)?\s+|HAFTE\s+(?:KI\s+|KA\s+|WALI\s+)?)?(?:KI\s+|WALI\s+)?(?=EXPIRY\b|EXP\b)/g, () => {
    rel('NEXT');
    return ' ';
  });
  s = s.replace(/\b(?:THIS|CURRENT|IS|ISI)\s+(?:WEEK(?:LY)?\s+|HAFTE\s+(?:KI\s+)?)?(?:KI\s+)?(?=EXPIRY\b|EXP\b)/g, () => {
    rel('CURRENT');
    return ' ';
  });
  s = s.replace(/\b(?:MAHINE|MAHINA|MAHEENE)\s+(?:KI\s+|WALI\s+|KA\s+)?(?=EXPIRY\b)/g, () => {
    rel('MONTHLY');
    return ' ';
  });
  for (const [word, r] of [['MONTHLY', 'MONTHLY'], ['WEEKLY', 'WEEKLY']] as const) {
    s = s.replace(new RegExp(`\\b${word}\\b(?:${EXPIRY_AFTER}|${CONTRACT_AFTER})`, 'g'), () => {
      rel(r);
      return ' ';
    });
    s = s.replace(new RegExp(`(\\d\\s*(?:CE|PE)\\s+)${word}\\b`, 'g'), (_m, pre) => {
      rel(r);
      return `${pre} `;
    });
  }

  const expiry: ExpiryHint | null = named ?? (relative ? { day: null, month: 0, year: null, relative } : null);
  return { s, expiry };
}

export const isNumber = (t: string): boolean => /^\d+(\.\d+)?$/.test(t);

/** A token that can be a price: 0.05 … 999999, not a phone/order id (≥ 7 digits), not a percent. */
export function isPriceLike(tokens: readonly string[], i: number): boolean {
  const t = tokens[i];
  if (!isNumber(t)) return false;
  if (t.replace('.', '').length >= 7) return false;
  if (tokens[i + 1] === '%') return false;
  const v = Number(t);
  return v >= 0.05 && v <= 999_999;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
