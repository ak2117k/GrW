import type { InfoBias, InfoHorizon, InfoItem } from './info';
import type { EntryType, Horizon, InstrumentKind, ParsedSignal, Side } from './types';
import type { Vocabulary } from './vocabulary';

/**
 * The LLM fallback's strict output contract. The model only EXTRACTS what the post says — it never
 * invents an SL, a target or an expiry — and every field it returns is re-validated with the same
 * side-of-entry rules as the rule parser before a TradeSignal is written.
 */

export const SIGNAL_PARSE_SYSTEM = [
  'You extract trade calls from Indian stock-market Telegram posts (NSE/BSE/MCX; English, Hinglish, emoji).',
  'Return ONLY JSON matching the schema. Extract what the post states; never invent a stop-loss, target, strike or expiry.',
  'isSignal=false for chatter, news, P&L recaps, ads, results of earlier calls (\"target done\", \"SL hit\") and anything without a clear entry.',
  'isSignal=false for market commentary / views / levels (support, resistance, "a monthly close above X needed") without an explicit buy/sell instruction, and for sector indices without derivatives (Nifty IT, Pharma, Auto, Metal, Realty, FMCG, PSU Bank): those are never NIFTY.',
  'A strike + CE/PE with a premium to pay ("BANKNIFTY 54400 PE ABOVE 387", "1420CE CMP 37 support 20 for 57") IS a buy call even without an SL or target; "support x" there is the sl and "view x" / "for x" a target. A disclaimer ("not buy or sell levels", "for educational purposes only") does not make a call a non-call.',
  'underlying: the exchange name (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX, CRUDEOIL, NATURALGAS, GOLD, SILVER, or the NSE cash symbol such as RELIANCE, TATAMOTORS).',
  'instrumentKind: CE or PE for options (needs strike), FUT for futures (index or commodity calls without CE/PE are FUT), EQ for cash stocks.',
  'side: BUY or SELL of that instrument (buying a put is BUY with kind PE).',
  'entryType: ABOVE (buy/sell above x), BELOW, RANGE (a-b), AT (single price). entryLow <= entryHigh; equal for ABOVE/BELOW/AT.',
  'sl: the stop-loss price or null. targets: price levels in order, [] when none. expiry: YYYY-MM-DD only if the post states it, else null.',
  'horizon: BTST for BTST/STBT, POSITIONAL for swing/positional/hold, else INTRADAY. confidence 0..1: how sure you are this is a clear, complete call.',
  'If the post contains several calls, list each in signals[] (most prominent first).',
].join('\n');

export const SIGNAL_PARSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isSignal', 'signals'],
  properties: {
    isSignal: { type: 'boolean' },
    signals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['underlying', 'instrumentKind', 'strike', 'expiry', 'side', 'entryType', 'entryLow', 'entryHigh', 'sl', 'targets', 'qty', 'horizon', 'confidence'],
        properties: {
          underlying: { type: 'string' },
          instrumentKind: { type: 'string', enum: ['FUT', 'CE', 'PE', 'EQ'] },
          strike: { type: ['number', 'null'] },
          expiry: { type: ['string', 'null'] },
          side: { type: 'string', enum: ['BUY', 'SELL'] },
          entryType: { type: 'string', enum: ['ABOVE', 'BELOW', 'AT', 'RANGE'] },
          entryLow: { type: 'number' },
          entryHigh: { type: 'number' },
          sl: { type: ['number', 'null'] },
          targets: { type: 'array', items: { type: 'number' } },
          qty: { type: ['integer', 'null'] },
          horizon: { type: 'string', enum: ['INTRADAY', 'BTST', 'POSITIONAL'] },
          confidence: { type: 'number' },
        },
      },
    },
  },
} as const;

export interface LlmParseReply {
  isSignal: boolean;
  signals: unknown[];
}

const KINDS = new Set<InstrumentKind>(['FUT', 'CE', 'PE', 'EQ']);
const ENTRY = new Set<EntryType>(['ABOVE', 'BELOW', 'AT', 'RANGE']);
const HORIZON = new Set<Horizon>(['INTRADAY', 'BTST', 'POSITIONAL']);

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Parse the model's text into a reply; null when it is not the schema's JSON. */
export function readLlmReply(text: string): LlmParseReply | null {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const o = JSON.parse(body) as Record<string, unknown>;
    if (typeof o?.isSignal !== 'boolean' || !Array.isArray(o.signals)) return null;
    return { isSignal: o.isSignal, signals: o.signals };
  } catch {
    return null;
  }
}

/**
 * One LLM-extracted call → a ParsedSignal, or null with the reason. The underlying must be in the
 * vocabulary; levels must sit on the correct side of the entry (as in the rule parser).
 */
export function validateLlmSignal(raw: unknown, vocab: Vocabulary): { ok: true; signal: ParsedSignal } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not an object' };
  const o = raw as Record<string, unknown>;
  const name = vocab.names.get(String(o.underlying ?? '').trim().toUpperCase().replace(/-EQ$/, ''));
  if (!name) return { ok: false, reason: `unknown underlying ${String(o.underlying)}` };
  const kind = String(o.instrumentKind ?? '') as InstrumentKind;
  if (!KINDS.has(kind)) return { ok: false, reason: 'bad instrumentKind' };
  const side = String(o.side ?? '') as Side;
  if (side !== 'BUY' && side !== 'SELL') return { ok: false, reason: 'bad side' };
  const entryType = String(o.entryType ?? '') as EntryType;
  if (!ENTRY.has(entryType)) return { ok: false, reason: 'bad entryType' };
  const a = num(o.entryLow);
  const b = num(o.entryHigh) ?? a;
  if (a === null || b === null || !(a > 0) || !(b > 0)) return { ok: false, reason: 'no entry' };
  const entryLow = Math.min(a, b);
  const entryHigh = Math.max(a, b);
  const strike = num(o.strike);
  if ((kind === 'CE' || kind === 'PE') && !(strike !== null && strike > 0)) return { ok: false, reason: 'option without strike' };
  let sl = num(o.sl);
  if (sl !== null && sl <= 0) sl = null;
  if (sl !== null && (side === 'BUY' ? sl >= entryLow : sl <= entryHigh)) return { ok: false, reason: 'sl on the wrong side' };
  const targets = (Array.isArray(o.targets) ? o.targets : []).map(num).filter((x): x is number => x !== null && x > 0);
  if (targets.some((x) => (side === 'BUY' ? x <= entryHigh : x >= entryLow))) return { ok: false, reason: 'target on the wrong side' };
  targets.sort((x, y) => (side === 'BUY' ? x - y : y - x));
  const expiry = typeof o.expiry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.expiry) ? o.expiry : null;
  const horizon = HORIZON.has(o.horizon as Horizon) ? (o.horizon as Horizon) : 'INTRADAY';
  const qty = num(o.qty);
  const conf = num(o.confidence);
  return {
    ok: true,
    signal: {
      underlying: name,
      instrumentKind: kind,
      strike: kind === 'CE' || kind === 'PE' ? strike : null,
      expiryHint: expiry ? { day: Number(expiry.slice(8, 10)), month: Number(expiry.slice(5, 7)), year: Number(expiry.slice(0, 4)) } : null,
      side,
      entryType: entryType === 'RANGE' && entryLow === entryHigh ? 'AT' : entryType,
      entryLow,
      entryHigh,
      sl,
      targets: [...new Set(targets)],
      qty: qty !== null && qty > 0 ? Math.round(qty) : null,
      horizon,
      tags: ['LLM'],
      // Never more sure than the rule parser on a complete call.
      confidence: Math.max(0, Math.min(0.85, conf ?? 0.5)),
    },
  };
}

// ─── INFO extraction (market information posts) ─────────────────────────────

/** One INFO item, flattened for the strict schema (validated into an {@link InfoItem}). */
export const INFO_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['underlying', 'bias', 'levels', 'targetLevel', 'oiStrike', 'oiSide', 'oiNote', 'conditionDriver', 'conditionDirection', 'horizon'],
  properties: {
    underlying: { type: 'string' },
    bias: { anyOf: [{ type: 'string', enum: ['BULL', 'BEAR', 'NEUTRAL'] }, { type: 'null' }] },
    levels: { type: 'array', items: { type: 'number' } },
    targetLevel: { type: ['number', 'null'] },
    oiStrike: { type: ['number', 'null'] },
    oiSide: { anyOf: [{ type: 'string', enum: ['CE', 'PE'] }, { type: 'null' }] },
    oiNote: { type: ['string', 'null'] },
    conditionDriver: { type: ['string', 'null'] },
    conditionDirection: { anyOf: [{ type: 'string', enum: ['UP', 'DOWN'] }, { type: 'null' }] },
    horizon: { anyOf: [{ type: 'string', enum: ['INTRADAY', 'DAYS', 'WEEKS', 'MONTHS'] }, { type: 'null' }] },
  },
} as const;

export const SIGNAL_INFO_SYSTEM = [
  'You extract MARKET INFORMATION from Indian stock-market Telegram posts (NSE/BSE/MCX; English, Hinglish, emoji). The post is NOT a trade call.',
  'Return ONLY JSON matching the schema. Extract what the post states or clearly implies; never invent levels.',
  'isInfo=false for greetings, ads, membership, P&L brags and anything without a market view. Otherwise one item per underlying the post has a view on.',
  'underlying: the exchange name (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX, CRUDEOIL for crude / US oil / WTI / Brent, NATURALGAS, GOLD, SILVER, or the NSE cash symbol). An un-named level near 15000-35000 is usually NIFTY.',
  'bias: BULL / BEAR / NEUTRAL (range, support+resistance only) or null when the post has no direction. Hinglish: upar/badhega/fakne upar = BULL; neeche/girega/tootega/panic = BEAR; "X se dur nahi" = moving towards X.',
  'Heavy PUT OI / put writing at a strike = support (BULL); heavy CALL OI / call writing = resistance (BEAR): fill oiStrike/oiSide/oiNote.',
  'condition: a scenario driver ("if US oil keeps rising then nifty below 22000" → item NIFTY BEAR, conditionDriver CRUDE, conditionDirection UP). The driver alone is not an item unless the post gives it a view of its own.',
  'horizon: INTRADAY (today), DAYS, WEEKS (swing / positional), MONTHS, or null.',
].join('\n');

export const SIGNAL_INFO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isInfo', 'items'],
  properties: { isInfo: { type: 'boolean' }, items: { type: 'array', items: INFO_ITEM_SCHEMA } },
} as const;

export interface InfoLlmReply {
  isInfo: boolean;
  items: unknown[];
}

const stripJson = (text: string) => text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

/** The model's text → an info reply, or null when it is not the schema's JSON. */
export function readInfoReply(text: string): InfoLlmReply | null {
  try {
    const o = JSON.parse(stripJson(text)) as Record<string, unknown>;
    if (typeof o?.isInfo !== 'boolean' || !Array.isArray(o.items)) return null;
    return { isInfo: o.isInfo, items: o.items };
  } catch {
    return null;
  }
}

const BIASES = new Set<InfoBias>(['BULL', 'BEAR', 'NEUTRAL']);
const INFO_HORIZONS = new Set<InfoHorizon>(['INTRADAY', 'DAYS', 'WEEKS', 'MONTHS']);
const INFO_UNDERLYING_ALIASES: Record<string, string> = { 'US OIL': 'CRUDEOIL', USOIL: 'CRUDEOIL', WTI: 'CRUDEOIL', BRENT: 'CRUDEOIL', CRUDE: 'CRUDEOIL' };

/** Model items (flattened) → validated InfoItems: the underlying must be in the vocabulary; junk is dropped. */
export function validateInfoItems(raw: readonly unknown[] | null | undefined, vocab: Vocabulary): InfoItem[] {
  const out: InfoItem[] = [];
  for (const x of raw ?? []) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const key = String(o.underlying ?? '').trim().toUpperCase().replace(/-EQ$/, '');
    const name = vocab.names.get(INFO_UNDERLYING_ALIASES[key] ?? key);
    if (!name || out.some((i) => i.underlying === name)) continue;
    const levels = (Array.isArray(o.levels) ? o.levels : []).map(num).filter((n): n is number => n !== null && n > 0);
    const strike = num(o.oiStrike);
    const side = o.oiSide === 'CE' || o.oiSide === 'PE' ? o.oiSide : null;
    const dir = o.conditionDirection === 'UP' || o.conditionDirection === 'DOWN' ? o.conditionDirection : null;
    const driver = typeof o.conditionDriver === 'string' && o.conditionDriver.trim() ? o.conditionDriver.trim().toUpperCase().replace(/^CRUDEOIL$/, 'CRUDE') : null;
    const target = num(o.targetLevel);
    out.push({
      underlying: name,
      bias: BIASES.has(o.bias as InfoBias) ? (o.bias as InfoBias) : null,
      levels: [...new Set(levels)],
      targetLevel: target !== null && target > 0 ? target : null,
      oi: strike !== null && strike > 0 && side ? { strike, side, note: typeof o.oiNote === 'string' ? o.oiNote.slice(0, 120) : '' } : null,
      condition: driver && driver !== name && !(driver === 'CRUDE' && name === 'CRUDEOIL') ? { driver, direction: dir } : null,
      horizon: INFO_HORIZONS.has(o.horizon as InfoHorizon) ? (o.horizon as InfoHorizon) : null,
      kind: 'VIEW',
    });
  }
  return out;
}

// ─── Vision (image posts) ────────────────────────────────────────────────────

/** VIEW is the legacy name of INFO (cached replies from before 2026-10-24 carry it). */
export type VisionKind = 'SIGNAL' | 'UPDATE' | 'INFO' | 'VIEW' | 'NOISE';
const VISION_KINDS = new Set<VisionKind>(['SIGNAL', 'UPDATE', 'INFO', 'VIEW', 'NOISE']);

const VISION_CLASSIFY_LINES = [
  'You read ONE image posted in an Indian stock-market Telegram channel (NSE/BSE/MCX), plus its caption if any.',
  'First decide kind: SIGNAL = a fresh trade call with an explicit buy/sell instruction AND an entry AND a stop-loss or a target;',
  'UPDATE = a follow-up on an earlier call ("target done", "SL hit", "exit", "trail SL"); INFO = market information: analysis, a chart',
  'with levels, support/resistance, an option-chain / OI screenshot, an outlook or a "close above X needed" without an explicit trade',
  'instruction; NOISE = P&L or broker screenshots, results of earlier calls, ads, memes, greetings, anything else. When unsure',
  'between SIGNAL and INFO, choose INFO. Sector indices without derivatives (Nifty IT, Pharma, Auto, Metal, Realty, FMCG, PSU Bank,',
  'Midcap 100 …) are INFO, never NIFTY.',
  'For kind=SIGNAL set isSignal=true and fill signals[] exactly as for a text post; for every other kind isSignal=false and signals=[].',
  'For kind=INFO fill items[] (one per underlying with a view: bias, levels, OI note, condition, horizon) as described below; else items=[].',
  'shownTime: when the image is a SCREENSHOT of a chat message carrying the call, the time printed on that message bubble',
  '(e.g. "2:34 PM"), as 24-hour "HH:MM" ("14:34"); null when no such time is visible. Never the phone status-bar clock.',
];

const VISION_DESCRIBE_LINES = [
  'ALWAYS, for every kind (NOISE and UPDATE too), describe what the image shows - another reader sees only your words:',
  'description: one or two plain sentences: the instrument(s), the direction / bias, the levels drawn or written (entry, stop, targets,',
  'support, resistance), the timeframe if visible, and what the post says is happening (e.g. "NIFTY 15m chart, short active from ~25700,',
  'trailing stop 25720, target 25600"; "broker P&L screenshot, +12,400 on CRUDEOIL options"). Only what is visible; never invent a level.',
  'instruments: the exchange names of the instruments shown (as for underlying), [] when none. bias: BULL, BEAR, NEUTRAL, or NONE when',
  'the image shows no direction. levels: every price level drawn or written, each {kind: ENTRY | STOP | TARGET | SUPPORT | RESISTANCE |',
  'OTHER, price}; [] when none.',
  'Never leave description empty, whatever the kind. A broker position / order book / P&L screenshot is NOISE but its description still says',
  'what it shows: the instrument (and CE / PE / FUT), the side (long / short, buy / sell) if visible, the P&L and LTP, and what is scribbled out',
  'or hidden (e.g. "position screenshot: SENSEX option PE, +₹4.33L, strike hidden"); its instruments[] names the instrument too.',
];

/**
 * The pre-2026-11-27 prompt / schema (classification only, no description). Sent when SIGNAL_VISION_DESCRIBE=off,
 * and — sticky for the process — after the provider rejected the describe schema (400), so images keep being classified.
 */
export const SIGNAL_VISION_SYSTEM_LEGACY = [...VISION_CLASSIFY_LINES, '', SIGNAL_PARSE_SYSTEM, '', SIGNAL_INFO_SYSTEM].join('\n');

export const SIGNAL_VISION_SYSTEM = [...VISION_CLASSIFY_LINES, ...VISION_DESCRIBE_LINES, '', SIGNAL_PARSE_SYSTEM, '', SIGNAL_INFO_SYSTEM].join('\n');

export const SIGNAL_VISION_SCHEMA_LEGACY = {
  ...SIGNAL_PARSE_SCHEMA,
  required: ['kind', ...SIGNAL_PARSE_SCHEMA.required, 'items', 'shownTime'],
  properties: {
    kind: { type: 'string', enum: ['SIGNAL', 'UPDATE', 'INFO', 'NOISE'] },
    ...SIGNAL_PARSE_SCHEMA.properties,
    items: { type: 'array', items: INFO_ITEM_SCHEMA },
    shownTime: { type: ['string', 'null'] },
  },
} as const;

export const SIGNAL_VISION_SCHEMA = {
  ...SIGNAL_VISION_SCHEMA_LEGACY,
  required: [...SIGNAL_VISION_SCHEMA_LEGACY.required, 'description', 'instruments', 'bias', 'levels'],
  properties: {
    ...SIGNAL_VISION_SCHEMA_LEGACY.properties,
    description: { type: 'string' },
    instruments: { type: 'array', items: { type: 'string' } },
    bias: { type: 'string', enum: ['BULL', 'BEAR', 'NEUTRAL', 'NONE'] },
    levels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'price'],
        properties: { kind: { type: 'string', enum: ['ENTRY', 'STOP', 'TARGET', 'SUPPORT', 'RESISTANCE', 'OTHER'] }, price: { type: 'number' } },
      },
    },
  },
} as const;

export type ImageLevelKind = 'ENTRY' | 'STOP' | 'TARGET' | 'SUPPORT' | 'RESISTANCE' | 'OTHER';
const IMAGE_LEVEL_KINDS = new Set<ImageLevelKind>(['ENTRY', 'STOP', 'TARGET', 'SUPPORT', 'RESISTANCE', 'OTHER']);
const IMAGE_BIASES = new Set(['BULL', 'BEAR', 'NEUTRAL']);
const MAX_DESCRIPTION_CHARS = 600;
const MAX_IMAGE_INSTRUMENTS = 5;
const MAX_IMAGE_LEVELS = 12;

/**
 * What the image shows, in words, for EVERY kind (owner 2026-11-27: a Mr. P "short side trade is active" chart
 * was filed NOISE and the message reader saw only the caption). The message reader renders `description` and
 * quotes `instruments`; nothing here creates a signal. Absent on replies cached before 2026-11-27.
 */
export interface ImageDescription {
  description?: string;
  /** Who wrote `description`: the model, or the intake's stand-in when the model gave none (absent on old rows). */
  descriptionSource?: 'model' | 'stand-in';
  /** Upper-cased exchange names the image shows (unvalidated against the vocabulary). */
  instruments?: string[];
  bias?: 'BULL' | 'BEAR' | 'NEUTRAL';
  levels?: Array<{ kind: ImageLevelKind; price: number }>;
}

export interface VisionReply extends LlmParseReply, ImageDescription {
  kind: VisionKind;
  /** kind INFO: the model's info items (unvalidated; see {@link validateInfoItems}). */
  items?: unknown[];
  /**
   * The time printed on a screenshotted call's own message bubble, "HH:MM" 24-hour (owner 2026-11-12: MCX
   * COMMODITY re-posted a 14:34 premium-group call as a screenshot at 15:40 and it was traded as fresh).
   */
  shownTime?: string | null;
}

/** The description fields of a parsed reply object; only the present, valid ones (junk dropped, NONE bias dropped). */
export function readImageDescription(o: Record<string, unknown> | null | undefined): ImageDescription {
  const out: ImageDescription = {};
  if (!o || typeof o !== 'object') return out;
  if (typeof o.description === 'string' && o.description.trim()) {
    out.description = o.description.trim().slice(0, MAX_DESCRIPTION_CHARS);
    out.descriptionSource = o.descriptionSource === 'stand-in' ? 'stand-in' : 'model';
  }
  if (Array.isArray(o.instruments)) {
    const names = [...new Set(o.instruments.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toUpperCase()).filter(Boolean))].slice(0, MAX_IMAGE_INSTRUMENTS);
    if (names.length) out.instruments = names;
  }
  if (typeof o.bias === 'string' && IMAGE_BIASES.has(o.bias)) out.bias = o.bias as ImageDescription['bias'];
  if (Array.isArray(o.levels)) {
    const levels: NonNullable<ImageDescription['levels']> = [];
    for (const l of o.levels) {
      const kind = (l as { kind?: unknown } | null)?.kind;
      const price = (l as { price?: unknown } | null)?.price;
      if (IMAGE_LEVEL_KINDS.has(kind as ImageLevelKind) && typeof price === 'number' && Number.isFinite(price) && price > 0) levels.push({ kind: kind as ImageLevelKind, price });
      if (levels.length >= MAX_IMAGE_LEVELS) break;
    }
    if (levels.length) out.levels = levels;
  }
  return out;
}

/** The reply (a stored or a fresh one) says, in the model's words, what its image shows (a stand-in does not count). */
export function hasImageDescription(reply: unknown): boolean {
  if (!reply || typeof reply !== 'object') return false;
  const o = reply as { description?: unknown; descriptionSource?: unknown };
  return typeof o.description === 'string' && !!o.description.trim() && o.descriptionSource !== 'stand-in';
}

/**
 * A stored `llm_result` as a vision reply for the sha256 cache, or null. A describe-only read onto a row that already
 * held an LLM parse keeps the image reading under `image` (the top level then has no kind): that reading is the reply.
 */
export function cachedVisionReply(raw: unknown): VisionReply | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.kind === 'string') return o as unknown as VisionReply;
  const nested = o.image;
  if (nested && typeof nested === 'object' && !Array.isArray(nested) && typeof (nested as { kind?: unknown }).kind === 'string') return nested as VisionReply;
  return null;
}

/**
 * A describe-schema reply with no usable description gets a plain, marked stand-in (the named instruments only), so
 * every described read stores a description and the reader is told the model gave none. `descriptionSource:
 * 'stand-in'` keeps it from counting as a description: a later process may re-describe that image.
 */
export function withDescription(reply: VisionReply): VisionReply {
  if (hasImageDescription(reply)) return reply;
  const names = reply.instruments?.length ? ` showing ${reply.instruments.join(', ')}` : '';
  return { ...reply, description: `image${names}; the model gave no description`, descriptionSource: 'stand-in' };
}

/** A trade_signals tag carrying the screenshot's own call time: `CALL_AT:HH:MM` (IST clock). */
export const CALL_AT_TAG = 'CALL_AT:';

/** "HH:MM" 24-hour (a valid clock time) or null. */
export function clockOrNull(v: unknown): string | null {
  const m = typeof v === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(v.trim()) : null;
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? `${String(h).padStart(2, '0')}:${m[2]}` : null;
}

/**
 * The model's text → a vision reply, or null when it is not the schema's JSON. A non-SIGNAL kind
 * always carries no signals (a "VIEW" with a filled signals[] is a VIEW); a SIGNAL with no signals
 * is not a signal.
 */
export function readVisionReply(text: string): VisionReply | null {
  const base = readLlmReply(text);
  if (!base) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const kind = o?.kind;
  if (!VISION_KINDS.has(kind as VisionKind)) return null;
  const k: VisionKind = kind === 'VIEW' ? 'INFO' : (kind as VisionKind);
  // Every kind keeps what the image shows, in words (the message reader reads it).
  const described = readImageDescription(o);
  if (k === 'INFO') return { kind: k, isSignal: false, signals: [], items: Array.isArray(o.items) ? o.items : [], ...described };
  if (k !== 'SIGNAL') return { kind: k, isSignal: false, signals: [], ...described };
  return { kind: k, isSignal: base.isSignal && base.signals.length > 0, signals: base.signals, shownTime: clockOrNull(o.shownTime), ...described };
}
