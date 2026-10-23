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

// ─── Vision (image posts) ────────────────────────────────────────────────────

export type VisionKind = 'SIGNAL' | 'UPDATE' | 'VIEW' | 'NOISE';
const VISION_KINDS = new Set<VisionKind>(['SIGNAL', 'UPDATE', 'VIEW', 'NOISE']);

export const SIGNAL_VISION_SYSTEM = [
  'You read ONE image posted in an Indian stock-market Telegram channel (NSE/BSE/MCX), plus its caption if any.',
  'First decide kind: SIGNAL = a fresh trade call with an explicit buy/sell instruction AND an entry AND a stop-loss or a target;',
  'UPDATE = a follow-up on an earlier call ("target done", "SL hit", "exit", "trail SL"); VIEW = analysis, a chart with levels,',
  'support/resistance, an outlook or a "close above X needed" without an explicit trade instruction; NOISE = P&L or broker',
  'screenshots, results of earlier calls, ads, memes, greetings, anything else. When unsure between SIGNAL and VIEW, choose VIEW.',
  'Sector indices without derivatives (Nifty IT, Pharma, Auto, Metal, Realty, FMCG, PSU Bank, Midcap 100 …) are VIEW, never NIFTY.',
  'For kind=SIGNAL set isSignal=true and fill signals[] exactly as for a text post; for every other kind isSignal=false and signals=[].',
  '',
  SIGNAL_PARSE_SYSTEM,
].join('\n');

export const SIGNAL_VISION_SCHEMA = {
  ...SIGNAL_PARSE_SCHEMA,
  required: ['kind', ...SIGNAL_PARSE_SCHEMA.required],
  properties: { kind: { type: 'string', enum: ['SIGNAL', 'UPDATE', 'VIEW', 'NOISE'] }, ...SIGNAL_PARSE_SCHEMA.properties },
} as const;

export interface VisionReply extends LlmParseReply {
  kind: VisionKind;
}

/**
 * The model's text → a vision reply, or null when it is not the schema's JSON. A non-SIGNAL kind
 * always carries no signals (a "VIEW" with a filled signals[] is a VIEW); a SIGNAL with no signals
 * is not a signal.
 */
export function readVisionReply(text: string): VisionReply | null {
  const base = readLlmReply(text);
  if (!base) return null;
  let kind: unknown;
  try {
    kind = (JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as Record<string, unknown>).kind;
  } catch {
    return null;
  }
  if (!VISION_KINDS.has(kind as VisionKind)) return null;
  const k = kind as VisionKind;
  if (k !== 'SIGNAL') return { kind: k, isSignal: false, signals: [] };
  return { kind: k, isSignal: base.isSignal && base.signals.length > 0, signals: base.signals };
}
