import { MANAGER_ACTIONS, type ManagerDecision, type ManagerReply } from './desk.types';

/**
 * The manager's reply contract: the JSON schema sent to the model (a request, not a guarantee) and
 * parseManagerReply, which re-checks it in code. One malformed decision rejects the WHOLE reply, so a
 * partial or off-contract answer acts on nothing (plan Review Focus 2).
 */

const str = { type: 'string' } as const;
const num = { type: 'number' } as const;
const nullableNum = { anyOf: [{ type: 'null' }, num] } as const;
const why = { reason: str, evidence: { type: 'array', items: str } } as const;

const obj = (action: string, props: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: ['action', ...Object.keys(props), 'reason', 'evidence'],
  properties: { action: { type: 'string', enum: [action] }, ...props, ...why },
});

export const MANAGER_REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'decisions'],
  properties: {
    summary: str,
    decisions: {
      type: 'array',
      items: {
        anyOf: [
          obj('OPEN', {
            underlying: str,
            side: { type: 'string', enum: ['BUY_CE', 'BUY_PE', 'BUY_FUT'] },
            strikePolicy: { anyOf: [{ type: 'string', enum: ['ATM', 'ITM1', 'OTM1'] }, num] },
            expiryPolicy: { type: 'string', enum: ['NEAREST', 'NEXT'] },
            entry: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'low', 'high', 'triggerAbove', 'triggerBelow', 'validMin'],
              properties: { type: { type: 'string', enum: ['NOW', 'ZONE', 'BREAKOUT'] }, low: nullableNum, high: nullableNum, triggerAbove: nullableNum, triggerBelow: nullableNum, validMin: num },
            },
            stop: { type: 'object', additionalProperties: false, required: ['underlying'], properties: { underlying: num } },
            targets: { type: 'object', additionalProperties: false, required: ['underlying'], properties: { underlying: { type: 'array', items: num } } },
            proposalRef: { anyOf: [{ type: 'null' }, str] },
            confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          }),
          obj('EXIT', { trackerId: str }),
          obj('BOOK', { trackerId: str }),
          obj('TIGHTEN', { trackerId: str, underlyingStop: num }),
          obj('PAUSE_ENTRIES', { scope: str, minutes: num }),
          obj('RESUME', {}),
          obj('WATCH', { underlying: str, note: str, recheckMin: num }),
          obj('FLAG_DATA_HOLE', { what: str, impact: str }),
          obj('NO_ACTION', { proposalRef: { anyOf: [{ type: 'null' }, str] } }),
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'trackerId', 'text'],
            properties: { action: { type: 'string', enum: ['BRIEF'] }, trackerId: str, text: str, ...why },
          },
        ],
      },
    },
  },
} as const;

type Rec = Record<string, unknown>;
type OpenDecision = Extract<ManagerDecision, { action: 'OPEN' }>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const optNum = (v: unknown) => v === undefined || v === null || finite(v);

/**
 * Text → JSON, tolerating a ```json fence or a line of prose around the one object (the reply is no longer
 * grammar-constrained: Vertex rejected MANAGER_REPLY_SCHEMA as too large). An object passes through.
 * Also the supreme confirm reply's parser (domain/confirm-prompt.ts).
 */
export function toJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const t = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return undefined;
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {
      return undefined;
    }
  }
}

/** One decision → typed, or the problem. Only shape here; trading rules are validateDecision's job. */
function parseDecision(x: unknown): { d: ManagerDecision } | { error: string } {
  if (!isRec(x)) return { error: 'not an object' };
  const action = x.action;
  if (!MANAGER_ACTIONS.includes(action as never)) return { error: `unknown action ${String(action)}` };
  if (action === 'BRIEF') {
    // { action, trackerId, text }: reason / evidence optional (the brief is the content). Length is validateDecision's
    // check, so a too-short brief is INVALID on its own and never voids the rest of the reply.
    if (!nonEmpty(x.trackerId)) return { error: 'BRIEF without trackerId' };
    if (typeof x.text !== 'string') return { error: 'BRIEF without text' };
    if (x.evidence !== undefined && !(Array.isArray(x.evidence) && x.evidence.every((e) => typeof e === 'string'))) return { error: 'evidence must be an array of strings' };
    const evidence = Array.isArray(x.evidence) ? (x.evidence as string[]).map((e) => e.trim()).filter((e) => e.length > 0) : [];
    return { d: { action, trackerId: x.trackerId.trim(), text: x.text.trim(), reason: nonEmpty(x.reason) ? x.reason.trim() : 'trade brief', evidence } };
  }
  if (!nonEmpty(x.reason)) return { error: 'missing reason' };
  if (!Array.isArray(x.evidence) || !x.evidence.every((e) => typeof e === 'string')) return { error: 'evidence must be an array of strings' };
  const w = { reason: x.reason.trim(), evidence: (x.evidence as string[]).map((e) => e.trim()).filter((e) => e.length > 0) };
  switch (action) {
    case 'OPEN': {
      if (!nonEmpty(x.underlying)) return { error: 'OPEN without underlying' };
      if (!['BUY_CE', 'BUY_PE', 'BUY_FUT'].includes(x.side as string)) return { error: `bad side ${String(x.side)}` };
      if (!(['ATM', 'ITM1', 'OTM1'].includes(x.strikePolicy as string) || finite(x.strikePolicy))) return { error: 'bad strikePolicy' };
      if (!['NEAREST', 'NEXT'].includes(x.expiryPolicy as string)) return { error: 'bad expiryPolicy' };
      const e = x.entry;
      if (!isRec(e) || !['NOW', 'ZONE', 'BREAKOUT'].includes(e.type as string) || !finite(e.validMin)) return { error: 'bad entry' };
      if (![e.low, e.high, e.triggerAbove, e.triggerBelow].every(optNum)) return { error: 'bad entry levels' };
      if (!isRec(x.stop) || !finite(x.stop.underlying)) return { error: 'bad stop' };
      if (!isRec(x.targets) || !Array.isArray(x.targets.underlying) || x.targets.underlying.length === 0 || !x.targets.underlying.every(finite)) return { error: 'bad targets' };
      if (!['low', 'medium', 'high'].includes(x.confidence as string)) return { error: 'bad confidence' };
      if (!(x.proposalRef === undefined || x.proposalRef === null || typeof x.proposalRef === 'string')) return { error: 'bad proposalRef' };
      const entry: OpenDecision['entry'] = { type: e.type as OpenDecision['entry']['type'], validMin: e.validMin };
      for (const k of ['low', 'high', 'triggerAbove', 'triggerBelow'] as const) if (finite(e[k])) entry[k] = e[k] as number;
      const d: OpenDecision = {
        action: 'OPEN',
        underlying: x.underlying.trim().toUpperCase(),
        side: x.side as OpenDecision['side'],
        strikePolicy: x.strikePolicy as OpenDecision['strikePolicy'],
        expiryPolicy: x.expiryPolicy as OpenDecision['expiryPolicy'],
        entry,
        stop: { underlying: x.stop.underlying },
        targets: { underlying: x.targets.underlying as number[] },
        confidence: x.confidence as OpenDecision['confidence'],
        ...w,
      };
      if (nonEmpty(x.proposalRef)) d.proposalRef = x.proposalRef.trim();
      return { d };
    }
    case 'EXIT':
    case 'BOOK':
      if (!nonEmpty(x.trackerId)) return { error: `${action} without trackerId` };
      return { d: { action, trackerId: x.trackerId.trim(), ...w } };
    case 'TIGHTEN':
      if (!nonEmpty(x.trackerId) || !finite(x.underlyingStop)) return { error: 'TIGHTEN needs trackerId and underlyingStop' };
      return { d: { action, trackerId: x.trackerId.trim(), underlyingStop: x.underlyingStop, ...w } };
    case 'PAUSE_ENTRIES':
      if (!nonEmpty(x.scope) || !finite(x.minutes)) return { error: 'PAUSE_ENTRIES needs scope and minutes' };
      return { d: { action, scope: x.scope.trim().toLowerCase() === 'all' ? 'all' : x.scope.trim().toUpperCase(), minutes: x.minutes, ...w } };
    case 'WATCH':
      if (!nonEmpty(x.underlying) || typeof x.note !== 'string' || !finite(x.recheckMin)) return { error: 'WATCH needs underlying, note and recheckMin' };
      return { d: { action, underlying: x.underlying.trim().toUpperCase(), note: x.note, recheckMin: x.recheckMin, ...w } };
    case 'FLAG_DATA_HOLE':
      if (!nonEmpty(x.what) || typeof x.impact !== 'string') return { error: 'FLAG_DATA_HOLE needs what and impact' };
      return { d: { action, what: x.what, impact: x.impact, ...w } };
    case 'RESUME':
      return { d: { action, ...w } };
    case 'NO_ACTION': {
      if (!(x.proposalRef === undefined || x.proposalRef === null || typeof x.proposalRef === 'string')) return { error: 'bad proposalRef' };
      const d: Extract<ManagerDecision, { action: 'NO_ACTION' }> = { action, ...w };
      if (nonEmpty(x.proposalRef)) d.proposalRef = x.proposalRef.trim();
      return { d };
    }
  }
  return { error: `unknown action ${String(action)}` };
}

/** The model's reply (text or parsed JSON) → the typed reply, or why it is not one. */
export function parseManagerReply(raw: unknown): { ok: true; reply: ManagerReply } | { ok: false; error: string } {
  const j = toJson(raw);
  if (!isRec(j)) return { ok: false, error: 'reply is not a JSON object' };
  if (typeof j.summary !== 'string') return { ok: false, error: 'missing summary' };
  if (!Array.isArray(j.decisions)) return { ok: false, error: 'missing decisions array' };
  const decisions: ManagerDecision[] = [];
  for (let i = 0; i < j.decisions.length; i++) {
    const p = parseDecision(j.decisions[i]);
    if ('error' in p) return { ok: false, error: `decision ${i}: ${p.error}` };
    decisions.push(p.d);
  }
  return { ok: true, reply: { summary: j.summary.trim(), decisions } };
}
