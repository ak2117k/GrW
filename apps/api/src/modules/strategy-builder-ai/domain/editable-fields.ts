/**
 * The ONLY fields an AI edit may touch. Claude's suggestions are validated
 * against this list: an edit to any other path, or with a value of the wrong
 * type / out of range, is rejected. The web applies an accepted edit with the
 * same path names (see apps/web/src/components/strategy/strategyAi.ts).
 *
 * Rules and indicator code are deliberately NOT editable by the model — a
 * suggestion about them goes in prose (risks / summary), never as an edit.
 */
import { FILL_AT, SEGMENTS, STOP_KINDS, SUPPORTED_INTERVALS, SYMBOL_PATTERN, type StrategyDefinition } from './definition';

export type EditValue = string | number | null;

interface FieldSpec {
  description: string;
  /** Returns the normalised value, or undefined when invalid. */
  parse: (v: unknown) => EditValue | undefined;
  read: (d: StrategyDefinition) => EditValue;
}

const enumOf = (allowed: readonly string[]) => (v: unknown): EditValue | undefined =>
  typeof v === 'string' && allowed.includes(v.trim()) ? v.trim() : undefined;

const numberIn = (min: number, max: number, integer = false) => (v: unknown): EditValue | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  if (integer && !Number.isInteger(n)) return undefined;
  return n;
};

const hhmm = (v: unknown): EditValue | undefined =>
  typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim()) ? v.trim() : undefined;

const symbol = (v: unknown): EditValue | undefined =>
  typeof v === 'string' && SYMBOL_PATTERN.test(v.trim().toUpperCase()) ? v.trim().toUpperCase() : undefined;

export const EDITABLE_FIELDS: Record<string, FieldSpec> = {
  timeframe: { description: `bar interval, one of ${SUPPORTED_INTERVALS.join('/')}`, parse: enumOf(SUPPORTED_INTERVALS), read: (d) => d.timeframe || null },
  segment: { description: `one of ${SEGMENTS.join('/')}`, parse: enumOf(SEGMENTS), read: (d) => d.segment || null },
  instrument: { description: 'underlying symbol, e.g. NIFTY, BANKNIFTY, RELIANCE, CRUDEOIL', parse: symbol, read: (d) => d.instrument || null },
  'settings.stopLossKind': { description: `stop-loss unit, one of ${STOP_KINDS.join('/')}`, parse: enumOf(STOP_KINDS), read: (d) => d.stopLoss?.kind ?? null },
  'settings.stopLossValue': { description: 'stop distance in that unit (ATR multiple, % of entry, or points)', parse: numberIn(0.01, 100_000), read: (d) => d.stopLoss?.value ?? null },
  'settings.targetKind': { description: `target unit, one of ${STOP_KINDS.join('/')}`, parse: enumOf(STOP_KINDS), read: (d) => d.target?.kind ?? null },
  'settings.targetValue': { description: 'target distance in that unit', parse: numberIn(0.01, 100_000), read: (d) => d.target?.value ?? null },
  'settings.riskPerTradeRupees': { description: 'max rupees lost if the stop is hit', parse: numberIn(1, 10_000_000), read: (d) => d.settings.riskPerTradeRupees },
  'settings.capitalPerTradeRupees': { description: 'rupees deployed per trade (premium for options)', parse: numberIn(1, 100_000_000), read: (d) => d.settings.capitalPerTradeRupees },
  'settings.maxOpenPositions': { description: 'integer 1-50', parse: numberIn(1, 50, true), read: (d) => d.settings.maxOpenPositions },
  'settings.maxTradesPerDay': { description: 'integer 1-100', parse: numberIn(1, 100, true), read: (d) => d.settings.maxTradesPerDay },
  'settings.sessionStart': { description: 'first entry time HH:MM (IST)', parse: hhmm, read: (d) => d.settings.sessionStart },
  'settings.sessionEnd': { description: 'last entry / square-off time HH:MM (IST)', parse: hhmm, read: (d) => d.settings.sessionEnd },
  'settings.fillAt': { description: `entry fill timing, one of ${FILL_AT.filter((f) => f !== 'same_bar_open').join('/')}`, parse: enumOf(FILL_AT.filter((f) => f !== 'same_bar_open')), read: (d) => d.settings.fillAt },
};

export const EDITABLE_FIELD_NAMES = Object.keys(EDITABLE_FIELDS);

export function isEditableField(field: string): boolean {
  return Object.prototype.hasOwnProperty.call(EDITABLE_FIELDS, field);
}

/** Fields that are empty in the EFFECTIVE definition (a script's stoploss line counts as filled). */
export function emptyFields(d: StrategyDefinition): string[] {
  return EDITABLE_FIELD_NAMES.filter((f) => {
    const v = EDITABLE_FIELDS[f].read(d);
    return v === null || v === '';
  });
}

export interface ValidEdit {
  field: string;
  value: EditValue;
  reason: string;
}

/**
 * Validate one model-proposed edit. `allowedFields` narrows the whitelist
 * (the Suggest flow passes the empty fields only).
 */
export function validateEdit(raw: unknown, allowedFields?: readonly string[]): ValidEdit | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const keys = Object.keys(e);
  if (keys.some((k) => !['field', 'value', 'reason'].includes(k))) return null;
  if (typeof e.field !== 'string' || !isEditableField(e.field)) return null;
  if (allowedFields && !allowedFields.includes(e.field)) return null;
  const value = EDITABLE_FIELDS[e.field].parse(e.value);
  if (value === undefined) return null;
  const reason = typeof e.reason === 'string' ? e.reason.trim().slice(0, 300) : '';
  return { field: e.field, value, reason };
}
