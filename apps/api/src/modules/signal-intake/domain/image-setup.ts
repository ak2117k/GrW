import type { ExpiryHint, InstrumentKind, ParsedSignal, Side } from './types';
import type { Vocabulary } from './vocabulary';

/**
 * Trade setups drawn on chart SCREENSHOTS (owner 2026-11-02). Some channels ("Stock Wale Bhaiyaa
 * Learning Group") post the trade only as a phone screenshot of a TradingView-style chart with the
 * long/short POSITION TOOL drawn: entry at the boundary, stop box on one side, target box on the other.
 * The text reader never sees those levels. This module is the pure half of reading them: the vision
 * prompt + strict schema, a parser that tolerates a sloppy model reply, the code-side validation
 * (geometry, numbers, instrument) and the freshness gate a NEW_SETUP must pass before it may become a
 * normal parsed signal.
 */

export type ImageSetupKind = 'NEW_SETUP' | 'UPDATE' | 'RESULT' | 'NOT_A_SETUP';
export type ImageSetupTool = 'position_tool' | 'lines' | 'text' | 'none';

export interface ImageSetupInstrument {
  /** The instrument text as seen on the chart header ("NIFTY 03 NOV 2026 23200 PE · NSE FO"). */
  raw: string | null;
  underlying: string | null;
  /** YYYY-MM-DD, or the date text as seen when the model could not normalise it. */
  expiry: string | null;
  strike: number | null;
  optionType: 'CE' | 'PE' | null;
  exchange: string | null;
}

export interface ImageSetupExtraction {
  kind: ImageSetupKind;
  instrument: ImageSetupInstrument;
  side: Side | null;
  entry: number | null;
  stopLoss: number | null;
  targets: number[];
  currentPrice: number | null;
  chartTimeframe: string | null;
  /** HH:MM as seen on the phone's status bar (12 h clocks usually carry no AM/PM). */
  screenshotClock: string | null;
  tool: ImageSetupTool;
  confidence: number;
  notes: string;
}

export const IMAGE_SETUP_SYSTEM = [
  'You read ONE chart screenshot posted in an Indian stock-market Telegram channel (NSE/BSE/MCX; captions are English / Hinglish / emoji) and report the trade setup drawn on it.',
  'Return ONLY JSON matching the schema. Read every number from what is printed in the image — never estimate a level from where a line or box sits on the grid, never guess.',
  '',
  'Instrument: copy the chart header / symbol label text as seen into instrument.raw (e.g. "NIFTY 03 NOV 2026 23200 PE · NSE FO", "NIFTY261103P23350", "Nifty 50 Index"). underlying = the exchange name (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX, CRUDEOIL, GOLD, SILVER, NATURALGAS, or the NSE cash symbol). expiry = YYYY-MM-DD when a date is shown (also inside a compact symbol: NIFTY261103P23350 = 2026-11-03, 23350 PE), else null. strike and optionType (CE / PE) only for an option; null otherwise. exchange as shown (NSE FO, NFO, MCX, NSE …) or null.',
  'Foreign / CFD / forex / crypto charts (USOIL, "CFDs on WTI Crude Oil", XAUUSD, BTCUSD, US indices) are NOT Indian contracts: underlying = the symbol as shown (USOIL, XAUUSD, BTCUSD); never map them to CRUDEOIL / GOLD / NIFTY.',
  '',
  'The long/short POSITION TOOL (tool = "position_tool"): two stacked boxes that meet at the ENTRY line. Each edge carries a price LABEL on the right-hand price axis.',
  '- SHORT (side SELL): the RED / PINK box (the stop) is ABOVE the entry and the GREEN / TEAL box (the target) is BELOW it. stopLoss = the label at the TOP of the red/pink box; entry = the (usually grey) label at the boundary; target = the label at the BOTTOM of the green/teal box.',
  '- LONG (side BUY): the mirror — green/teal box ABOVE entry (target = its top label), red/pink box BELOW (stopLoss = its bottom label).',
  'Several position tools on one chart: report the most recent one (the right-most, nearest the current price) and mention the others in notes — never mix levels from two tools.',
  'Grey rectangles elsewhere on the chart are supply/demand zones, NOT the position tool. A red label with a countdown under it (e.g. "72.80 / 00:01") on a dotted line is the CURRENT price, not a level. Header price ("NIFTY 23200 PE 49.45 -170.20") is also the current price.',
  'Without a position tool, horizontal lines with labels (tool = "lines") or levels written as text on the image (tool = "text") may still give entry / stop / targets — only when they are clearly marked as such. Otherwise tool = "none".',
  'currentPrice = the live/last price shown (the countdown label or the header price). chartTimeframe = the selected interval ("1m", "5m", "15m", "1h", "D" …) or null. screenshotClock = the phone status-bar clock exactly as seen, HH:MM (e.g. "1:57"), or null.',
  '',
  'kind:',
  '- NEW_SETUP: a trade being called now — levels drawn and price still near the entry, not yet at the target or the stop.',
  '- UPDATE: a trade already in progress (price has moved from the entry toward the target or stop) with no new levels.',
  '- RESULT: the outcome of an earlier trade — the caption says "target done", "SL hit", "booked", "before and after", or the current price is already at / through the target or the stop.',
  '- NOT_A_SETUP: no tradeable levels (a plain chart, a P&L screenshot, a meme, news, an index view without entry/stop/target).',
  'For UPDATE and RESULT still fill instrument, side, entry, stopLoss and targets from the drawing when it is visible.',
  'side = SELL for a short, BUY for a long, null when there is no setup. targets nearest first. confidence 0..1 = how sure you are of the numbers and the kind. notes = one short sentence on what you saw (what decided the kind).',
].join('\n');

export const IMAGE_SETUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'instrument', 'side', 'entry', 'stopLoss', 'targets', 'currentPrice', 'chartTimeframe', 'screenshotClock', 'tool', 'confidence', 'notes'],
  properties: {
    kind: { type: 'string', enum: ['NEW_SETUP', 'UPDATE', 'RESULT', 'NOT_A_SETUP'] },
    instrument: {
      type: 'object',
      additionalProperties: false,
      required: ['raw', 'underlying', 'expiry', 'strike', 'optionType', 'exchange'],
      properties: {
        raw: { type: ['string', 'null'] },
        underlying: { type: ['string', 'null'] },
        expiry: { type: ['string', 'null'] },
        strike: { type: ['number', 'null'] },
        optionType: { type: ['string', 'null'], enum: ['CE', 'PE', null] },
        exchange: { type: ['string', 'null'] },
      },
    },
    side: { type: ['string', 'null'], enum: ['BUY', 'SELL', null] },
    entry: { type: ['number', 'null'] },
    stopLoss: { type: ['number', 'null'] },
    targets: { type: 'array', items: { type: 'number' } },
    currentPrice: { type: ['number', 'null'] },
    chartTimeframe: { type: ['string', 'null'] },
    screenshotClock: { type: ['string', 'null'] },
    tool: { type: 'string', enum: ['position_tool', 'lines', 'text', 'none'] },
    confidence: { type: 'number' },
    notes: { type: 'string' },
  },
} as const;

// ─── Tolerant reply parser ──────────────────────────────────────────────────

const KIND_ALIASES: Record<string, ImageSetupKind> = {
  NEW_SETUP: 'NEW_SETUP', NEW: 'NEW_SETUP', SETUP: 'NEW_SETUP', SIGNAL: 'NEW_SETUP',
  UPDATE: 'UPDATE', IN_PROGRESS: 'UPDATE',
  RESULT: 'RESULT', OUTCOME: 'RESULT',
  NOT_A_SETUP: 'NOT_A_SETUP', NOT_SETUP: 'NOT_A_SETUP', NONE: 'NOT_A_SETUP', NOISE: 'NOT_A_SETUP',
};
const TOOLS = new Set<ImageSetupTool>(['position_tool', 'lines', 'text', 'none']);

/** A number from a number or a printed price ("87.55", "₹1,234.5", " 48 "); null otherwise. */
export function priceOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.replace(/[,₹\s]/g, '').match(/^-?\d+(?:\.\d+)?$/);
  return m ? Number(m[0]) : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The JSON object in a model reply: fences, prose around it and trailing commas tolerated. */
function jsonObjectIn(text: string): Record<string, unknown> | null {
  const body = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  const slice = body.slice(a, b + 1);
  for (const candidate of [slice, slice.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      const o = JSON.parse(candidate) as unknown;
      if (o && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, unknown>;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * The model's text → an extraction, or null when it is not the schema's JSON at all (no object, or no
 * recognisable kind). Everything else is coerced rather than rejected: prices as strings, SHORT/LONG
 * for SELL/BUY, PUT/CALL for PE/CE, a single target instead of a list, a 0–100 confidence.
 */
export function readImageSetupReply(text: string): ImageSetupExtraction | null {
  const o = jsonObjectIn(text);
  if (!o) return null;
  const kind = KIND_ALIASES[String(o.kind ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_')];
  if (!kind) return null;
  const inst = (o.instrument && typeof o.instrument === 'object' && !Array.isArray(o.instrument) ? o.instrument : {}) as Record<string, unknown>;
  const ot = String(inst.optionType ?? '').trim().toUpperCase();
  const optionType = ot === 'CE' || ot === 'CALL' ? 'CE' : ot === 'PE' || ot === 'PUT' ? 'PE' : null;
  const sd = String(o.side ?? '').trim().toUpperCase();
  const side: Side | null = sd === 'SELL' || sd === 'SHORT' ? 'SELL' : sd === 'BUY' || sd === 'LONG' ? 'BUY' : null;
  const rawTargets = Array.isArray(o.targets) ? o.targets : o.targets === undefined || o.targets === null ? [] : [o.targets];
  const targets = rawTargets.map(priceOf).filter((x): x is number => x !== null);
  let confidence = priceOf(o.confidence) ?? 0;
  if (confidence > 1 && confidence <= 100) confidence /= 100;
  confidence = Math.max(0, Math.min(1, confidence));
  const tool = String(o.tool ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_') as ImageSetupTool;
  return {
    kind,
    instrument: {
      raw: str(inst.raw),
      underlying: str(inst.underlying)?.toUpperCase() ?? null,
      expiry: str(inst.expiry),
      strike: priceOf(inst.strike),
      optionType,
      exchange: str(inst.exchange),
    },
    side,
    entry: priceOf(o.entry),
    stopLoss: priceOf(o.stopLoss ?? o.stop_loss ?? o.sl),
    targets,
    currentPrice: priceOf(o.currentPrice ?? o.current_price),
    chartTimeframe: str(o.chartTimeframe),
    screenshotClock: str(o.screenshotClock),
    tool: TOOLS.has(tool) ? tool : 'none',
    confidence,
    notes: String(o.notes ?? '').slice(0, 500),
  };
}

// ─── Instrument text ────────────────────────────────────────────────────────

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "2026-11-03", "03 NOV 2026", "3 Nov 26", "03NOV26", "03 NOV" → an expiry hint; null when unreadable. */
export function expiryHintOf(text: string | null | undefined): ExpiryHint | null {
  const t = String(text ?? '').trim().toUpperCase();
  if (!t) return null;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return { day: Number(iso[3]), month: Number(iso[2]), year: Number(iso[1]) };
  const m = t.match(/(\d{1,2})\s*-?\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s*-?\s*(\d{2,4})?/);
  if (!m) return null;
  const day = Number(m[1]);
  if (!(day >= 1 && day <= 31)) return null;
  const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
  return { day, month: MONTHS.indexOf(m[2]) + 1, year };
}

/** Fill underlying / expiry / strike / CE-PE the model left empty from the header text ("NIFTY 03 NOV 2026 23200 PE"). */
export function completeInstrument(i: ImageSetupInstrument): ImageSetupInstrument {
  const raw = String(i.raw ?? '').toUpperCase();
  const c = compactSymbol(raw);
  if (c) return { ...i, underlying: i.underlying ?? c.underlying, expiry: i.expiry ?? c.expiry, strike: i.strike ?? c.strike, optionType: i.optionType ?? c.optionType };
  const m = raw.match(/^\s*([A-Z][A-Z0-9&-]*)\s+(?:(\d{1,2}\s*[A-Z]{3}\s*(?:\d{2,4})?)\s+)?(\d+(?:\.\d+)?)\s*(CE|PE)\b/);
  if (!m) return i;
  return {
    ...i,
    underlying: i.underlying ?? m[1],
    expiry: i.expiry ?? (m[2] ? m[2].trim() : null),
    strike: i.strike ?? Number(m[3]),
    optionType: i.optionType ?? (m[4] as 'CE' | 'PE'),
  };
}

// ─── Kind rules (caption + price) ───────────────────────────────────────────

/** Captions that report an outcome (a result post), whatever the picture looks like. */
const RESULT_CAPTION =
  /\b(target|targets|tgt|tp)\s*(\d\s*)?(done|hit|achieved|complete[d]?|hog[a]?y[ae]|ho\s*gay[ae])\b|\bsl\s*(hit|hog[a]?ya|ho\s*gaya)\b|\bstop\s*(loss)?\s*hit\b|\bbooked\b|\bdone\s+for\s+the\s+day\b/i;
/** "Before and after" posts show a past call next to what happened: never a new call. */
const BEFORE_AFTER_CAPTION = /\bbefore\s*(and|&|n)\s*after\b/i;

/** Why the caption makes this a result ("target done"), or null. */
export function captionResultReason(caption: string | null | undefined): string | null {
  const c = String(caption ?? '');
  const m = c.match(RESULT_CAPTION);
  if (m) return `caption says "${m[0].trim()}"`;
  return null;
}

export function captionBeforeAfter(caption: string | null | undefined): boolean {
  return BEFORE_AFTER_CAPTION.test(String(caption ?? ''));
}

/** Is the price at / through the nearest target or the stop (the trade is over)? */
export function priceThroughLevels(x: Pick<ImageSetupExtraction, 'side' | 'stopLoss' | 'targets' | 'currentPrice'>): string | null {
  const p = x.currentPrice;
  if (p === null || !x.side) return null;
  const t = x.targets[0];
  const sell = x.side === 'SELL';
  if (t !== undefined && (sell ? p <= t : p >= t)) return `current price ${p} at/through the target ${t}`;
  if (x.stopLoss !== null && (sell ? p >= x.stopLoss : p <= x.stopLoss)) return `current price ${p} at/through the stop ${x.stopLoss}`;
  return null;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export interface ImageSetupVerdict {
  /** The kind after the code rules (caption / price / validation); the model's own kind stays in the extraction. */
  kind: ImageSetupKind;
  valid: boolean;
  /** Why it is not valid, or which rule changed the kind; null when the model's read stands as is. */
  reason: string | null;
  /** The extraction with the instrument completed from its header text and targets ordered nearest first. */
  extraction: ImageSetupExtraction;
  /** The call as the text parser would have produced it (only for a valid read of a tradeable contract). */
  signal: ParsedSignal | null;
  /** Valid read but nothing to trade (index spot levels): why. */
  untradeable?: string;
}

/** Foreign / CFD / forex / crypto charts: never an Indian contract, whatever underlying the model named. */
const FOREIGN = /\bCFDs?\b|USOIL|UKOIL|WTI\b|BRENT|XAU|XAG|BTC|ETH|\bUSD\b|\/\s*U\.?S\.?\s*DOLLAR|NASDAQ|NYSE|\bDOW\b|\bSPX\b|FOREX|OANDA|FXCM|BINANCE|COINBASE/i;

/** Why the instrument is not an Indian exchange one, or null. */
export function foreignInstrument(i: ImageSetupInstrument): string | null {
  const text = [i.raw, i.underlying, i.exchange].filter(Boolean).join(' ');
  const m = text.match(FOREIGN);
  return m ? `not an Indian exchange instrument (${m[0]})` : null;
}

/** Compact contract symbols on a chart label: TradingView NIFTY261103P23350 (YYMMDD) / Angel NIFTY03NOV2623200PE (DDMMMYY). */
function compactSymbol(raw: string): { underlying: string; expiry: string; optionType: 'CE' | 'PE'; strike: number } | null {
  const a = raw.match(/\b([A-Z]{3,}?)(\d{2})(\d{2})(\d{2})([CP])(\d{3,6})\b/);
  if (a) return { underlying: a[1], expiry: `20${a[2]}-${a[3]}-${a[4]}`, optionType: a[5] === 'C' ? 'CE' : 'PE', strike: Number(a[6]) };
  const b = raw.match(/\b([A-Z]{3,}?)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(\d{3,6})(CE|PE)\b/);
  if (b) return { underlying: b[1], expiry: `${b[2]} ${b[3]} 20${b[4]}`, optionType: b[6] as 'CE' | 'PE', strike: Number(b[5]) };
  return null;
}

const notASetup = (extraction: ImageSetupExtraction, reason: string): ImageSetupVerdict => ({ kind: 'NOT_A_SETUP', valid: false, reason, extraction, signal: null });

/**
 * The code-side checks on a read. Every kind but NOT_A_SETUP must carry a complete, coherent setup —
 * side, positive entry / stop / target(s), SELL: stop > entry > targets (BUY the mirror), an underlying
 * the vocabulary knows and, for an option, a strike, CE/PE and a readable expiry — else it is downgraded
 * to NOT_A_SETUP with the reason. Then the kind rules: a result caption ("target done") makes it a RESULT,
 * "before and after" turns a NEW_SETUP into a RESULT, and a NEW_SETUP whose current price is already at /
 * through the target or the stop is a RESULT. The instrument master check is separate ({@link withContractCheck}).
 */
export function validateImageSetup(read: ImageSetupExtraction, ctx: { caption: string | null | undefined; vocab: Vocabulary }): ImageSetupVerdict {
  const instrument = completeInstrument(read.instrument);
  const side = read.side;
  const sell = side === 'SELL';
  const targets = [...new Set(read.targets.filter((t) => t > 0))].sort((a, b) => (sell ? b - a : a - b));
  const x: ImageSetupExtraction = { ...read, instrument, targets };
  if (read.kind === 'NOT_A_SETUP') return { kind: 'NOT_A_SETUP', valid: false, reason: read.notes ? `model: ${read.notes}`.slice(0, 300) : 'model: not a setup', extraction: x, signal: null };

  if (!side) return notASetup(x, 'no side (long / short) read');
  const { entry, stopLoss: sl } = read;
  if (entry === null || !(entry > 0)) return notASetup(x, 'no positive entry');
  if (sl === null || !(sl > 0)) return notASetup(x, 'no positive stop-loss');
  if (targets.length === 0) return notASetup(x, 'no positive target');
  if (read.targets.some((t) => !(t > 0))) return notASetup(x, 'a target is not positive');
  if (read.currentPrice !== null && !(read.currentPrice > 0)) return notASetup(x, 'current price is not positive');
  const geometryOk = sell ? sl > entry && targets.every((t) => t < entry) : sl < entry && targets.every((t) => t > entry);
  if (!geometryOk) {
    const want = sell ? 'SELL needs stop > entry > target' : 'BUY needs target > entry > stop';
    return notASetup(x, `levels contradict the side: ${want} (entry ${entry}, stop ${sl}, targets ${targets.join('/')})`);
  }

  const foreign = foreignInstrument(instrument);
  if (foreign) return notASetup(x, foreign);
  const name = ctx.vocab.names.get(String(instrument.underlying ?? '').trim().toUpperCase().replace(/-EQ$/, ''));
  if (!name) return notASetup(x, `unknown underlying ${instrument.underlying ?? '(none)'}`);
  const option = instrument.optionType !== null;
  const expiryHint = expiryHintOf(instrument.expiry);
  if (option && !(instrument.strike !== null && instrument.strike > 0)) return notASetup(x, 'option without a strike');
  if (option && !expiryHint) return notASetup(x, `option expiry unreadable (${instrument.expiry ?? 'none'})`);
  const cls = ctx.vocab.classOf.get(name);
  const fut = /\bFUT/i.test(instrument.raw ?? '');
  // An index / commodity chart that is neither an option nor a future is the spot / index line: its levels
  // are not a contract's (a future trades at a basis), so the read is kept but nothing is traded from it.
  const spot = !option && !fut && cls !== 'STOCK';
  const kind: InstrumentKind = option ? (instrument.optionType as 'CE' | 'PE') : fut ? 'FUT' : 'EQ';
  const signal: ParsedSignal | null = spot
    ? null
    : {
        underlying: name,
        instrumentKind: kind,
        strike: option ? instrument.strike : null,
        expiryHint,
        side,
        entryType: 'AT',
        entryLow: entry,
        entryHigh: entry,
        sl,
        targets,
        qty: null,
        horizon: 'INTRADAY',
        tags: ['IMAGE_SETUP'],
        // Never more sure than the rule parser on a complete call.
        confidence: Math.round(Math.max(0, Math.min(0.85, read.confidence)) * 100) / 100,
      };
  const rule = kindRule(read.kind, ctx.caption, { side, stopLoss: sl, targets, currentPrice: read.currentPrice });
  return {
    kind: rule.kind,
    valid: true,
    reason: rule.reason,
    extraction: { ...x, instrument: { ...instrument, underlying: name } },
    signal,
    ...(spot ? { untradeable: 'index / spot levels: no contract to trade' } : {}),
  };
}

/** The caption / price rules on a valid read's kind (see {@link validateImageSetup}). */
function kindRule(
  kind: ImageSetupKind,
  caption: string | null | undefined,
  levels: Pick<ImageSetupExtraction, 'side' | 'stopLoss' | 'targets' | 'currentPrice'>,
): { kind: ImageSetupKind; reason: string | null } {
  const capResult = captionResultReason(caption);
  if (capResult && kind !== 'RESULT') return { kind: 'RESULT', reason: `${kind} → RESULT: ${capResult}` };
  if (kind === 'NEW_SETUP' && captionBeforeAfter(caption)) return { kind: 'RESULT', reason: 'NEW_SETUP → RESULT: caption says "before and after"' };
  const through = priceThroughLevels(levels);
  if (kind !== 'RESULT' && through) return { kind: 'RESULT', reason: `${kind} → RESULT: ${through}` };
  return { kind, reason: null };
}

/** The instrument master's say: found → unchanged; not found → NOT_A_SETUP; master unavailable (null) → unchanged. */
export function withContractCheck(v: ImageSetupVerdict, found: { tradingsymbol: string } | false | null): ImageSetupVerdict {
  if (!v.valid || found === null) return v;
  if (found === false) return { ...v, kind: 'NOT_A_SETUP', valid: false, reason: 'contract not found in the instrument master', signal: null };
  return v;
}

// ─── Freshness (signal mode) ────────────────────────────────────────────────

const IST_OFFSET_MIN = 330;

/** Minutes after IST midnight of the screenshot clock ("1:57", "14:31", "2:31 PM"); candidates for a 12 h clock. */
export function clockCandidates(clock: string | null | undefined): number[] {
  const m = String(clock ?? '').match(/(\d{1,2})[:.](\d{2})\s*([AaPp][Mm])?/);
  if (!m) return [];
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return [];
  if (m[3]) {
    const pm = m[3].toUpperCase() === 'PM';
    const h24 = (h % 12) + (pm ? 12 : 0);
    return [h24 * 60 + min];
  }
  if (h >= 13 || h === 0) return [h * 60 + min];
  return [h * 60 + min, ((h % 12) + 12) * 60 + min];
}

export interface Freshness {
  fresh: boolean;
  reason: string;
  /** Minutes between the screenshot clock and the post (positive = screenshot before the post); null when unread. */
  lagMin: number | null;
}

/**
 * Can a NEW_SETUP still be traded from this post? The screenshot was taken at most `maxLagMin` minutes
 * before the post (a 2-minute clock skew the other way is tolerated); the current price on it is still
 * strictly between the stop and the nearest target and within `maxDriftPct` % of the entry.
 */
export function freshnessOf(
  x: Pick<ImageSetupExtraction, 'side' | 'entry' | 'stopLoss' | 'targets' | 'currentPrice' | 'screenshotClock'>,
  postedAt: Date,
  opts: { maxLagMin: number; maxDriftPct: number },
): Freshness {
  const cands = clockCandidates(x.screenshotClock);
  if (!cands.length) return { fresh: false, reason: `screenshot clock unreadable (${x.screenshotClock ?? 'none'})`, lagMin: null };
  const postedMin = Math.floor((((postedAt.getTime() / 60_000 + IST_OFFSET_MIN) % 1440) + 1440) % 1440);
  const lag = cands.map((c) => postedMin - c).sort((a, b) => Math.abs(a) - Math.abs(b))[0];
  if (lag < -2 || lag > opts.maxLagMin) return { fresh: false, reason: `screenshot taken ${lag} min before the post (allowed −2…${opts.maxLagMin})`, lagMin: lag };
  const p = x.currentPrice;
  const t = x.targets[0];
  if (p === null || x.entry === null || x.stopLoss === null || t === undefined || !x.side) return { fresh: false, reason: 'no current price / levels to check against', lagMin: lag };
  const between = x.side === 'SELL' ? p > t && p < x.stopLoss : p < t && p > x.stopLoss;
  if (!between) return { fresh: false, reason: `current price ${p} is not between the stop ${x.stopLoss} and the target ${t}`, lagMin: lag };
  const drift = (Math.abs(p - x.entry) / x.entry) * 100;
  if (drift > opts.maxDriftPct) return { fresh: false, reason: `current price ${p} is ${Math.round(drift * 10) / 10}% from the entry ${x.entry} (> ${opts.maxDriftPct}%)`, lagMin: lag };
  return { fresh: true, reason: `screenshot ${lag} min before the post, price ${p} ${Math.round(drift * 10) / 10}% from the entry`, lagMin: lag };
}

// ─── The signal text ────────────────────────────────────────────────────────

const ddmmm = (h: ExpiryHint | null) => (h && h.day ? `${String(h.day).padStart(2, '0')}${MONTHS[h.month - 1]}` : '');

/** "[image] SELL NIFTY 23200 PE 03NOV AT 87.55 SL 100.5 T 48" — the night review splits image vs text calls on the prefix. */
export function imageSignalText(s: ParsedSignal): string {
  const contract = s.instrumentKind === 'CE' || s.instrumentKind === 'PE' ? `${s.strike} ${s.instrumentKind} ${ddmmm(s.expiryHint)}`.trim() : s.instrumentKind === 'FUT' ? `FUT ${ddmmm(s.expiryHint)}`.trim() : '';
  const t = s.targets.length ? ` T ${s.targets.join('/')}` : '';
  return `[image] ${s.side} ${s.underlying}${contract ? ` ${contract}` : ''} AT ${s.entryLow}${s.sl !== null ? ` SL ${s.sl}` : ''}${t}`;
}

/** Option writing (SELL CE / PE)? The signal trader refuses it unless SIGNAL_ALLOW_OPTION_SELL=true. */
export function isOptionSell(s: Pick<ParsedSignal, 'instrumentKind' | 'side'>): boolean {
  return (s.instrumentKind === 'CE' || s.instrumentKind === 'PE') && s.side === 'SELL';
}
