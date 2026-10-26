import type { ExpiryHint } from './types';
import { multiWordAliases, SECTOR_INDEX_TOKEN, type Vocabulary } from './vocabulary';

/**
 * Text normalisation shared by the pre-filter, the rule parser and the update detector. Everything
 * is deterministic and free: upper-case, the tip-channel emoji turned into the words they stand for,
 * synonyms folded ("STOP LOSS" → SL, "TARGET" / "T1" / 🎯 → TGT), multi-word underlyings joined
 * ("BANK NIFTY" → BANKNIFTY), fused contracts split ("950CE" → "950 CE") and explicit expiries lifted
 * out into an {@link ExpiryHint}.
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTH_RE = 'JAN|FEB|MAR|APR|MAY|JUNE?|JULY?|AUG|SEPT?|OCT|NOV|DEC';

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

  // Angel tradingsymbol: NIFTY28OCT2624000CE → NIFTY 24000 CE + expiry.
  let expiry: ExpiryHint | null = null;
  s = s.replace(new RegExp(`\\b([A-Z&]+?)(\\d{2})(${MONTH_RE})(\\d{2})(\\d{2,6}(?:\\.\\d+)?)(CE|PE)\\b`, 'g'), (_m, u, d, mo, y, k, t) => {
    expiry ??= { day: Number(d), month: monthIdx(mo), year: yearOf(y) };
    return ` ${u} ${k} ${t} `;
  });
  // "28 OCT", "28OCT", "28-OCT-26", "28TH OCT" — a day + month is an expiry.
  s = s.replace(new RegExp(`\\b(\\d{1,2})(?:ST|ND|RD|TH)?\\s*[-/ ]?\\s*(${MONTH_RE})\\b(?:\\s*[-/ ]?\\s*'?(\\d{4}|\\d{2})\\b(?!\\s*(CE|PE)))?`, 'g'), (_m, d, mo, y) => {
    const day = Number(d);
    if (day < 1 || day > 31) return _m;
    expiry ??= { day, month: monthIdx(mo), year: yearOf(y) };
    return ' ';
  });
  // "NIFTY OCT 24000 CE" / "NOV FUT" — a bare month next to a contract is that month's expiry.
  s = s.replace(new RegExp(`\\b(${MONTH_RE})\\b(?=\\s*(\\d{2,6}(\\.\\d+)?\\s*(CE|PE)|FUT)\\b)`, 'g'), (_m, mo) => {
    expiry ??= { day: null, month: monthIdx(mo), year: null };
    return ' ';
  });

  // Durations ('2-3 weeks', '5 days') are not prices; keep the unit as a horizon word.
  s = s.replace(/\b\d+(?:\s*(?:-|TO)\s*\d+)?\s*(DAYS?|WEEKS?|MONTHS?|SESSIONS?|HRS?|HOURS?|MINS?|MINUTES?)\b/g, ' $1 ');
  for (const [re, to] of SYNONYMS) s = s.replace(re, to);

  for (const [alias, name] of multiWordAliases(vocab)) {
    s = s.replace(new RegExp(`(^|[^A-Z0-9&])${escapeRe(alias).replace(/ /g, '\\s+')}(?=$|[^A-Z0-9&])`, 'g'), `$1${name}`);
  }
  // Fused contract tokens: TATAMOTORS950CE / BNF52000PE / NIFTYFUT / 24000CE.
  s = s.replace(/\b([A-Z&]{2,}?)(\d{2,6}(?:\.\d+)?)(CE|PE)\b/g, '$1 $2 $3');
  s = s.replace(/(\d)(CE|PE|FUT)\b/g, '$1 $2');
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
  return { text: s, tokens: s ? s.split(' ') : [], expiry };
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
