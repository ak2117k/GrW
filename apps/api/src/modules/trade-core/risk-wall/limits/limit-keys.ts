import { Prisma } from '@prisma/client';
import { VEHICLES } from '../../strategies/blocks/block-types';
import { toCapitalDecimal } from '../../strategies/dto/core-strategy.dto';

/**
 * The Risk Wall's limit vocabulary (spec §5.2). Each key declares its kind, the
 * direction that makes it tighter (D5) and the scopes it exists at. There are NO
 * limit values here (D4): values live in core_risk_limits (per user) and the seed
 * defaults in core_risk_limit_defaults (data). The only literals are shape bounds.
 */
export const LIMIT_SCOPES = ['ALL', ...VEHICLES] as const;
export type LimitScope = (typeof LIMIT_SCOPES)[number];

/** Ordered loosest → tightest (spec §5.2: BLOCK_ENTRIES < BLOCK_AND_SQUARE_OFF). */
export const DAILY_LOSS_ACTIONS = ['BLOCK_ENTRIES', 'BLOCK_AND_SQUARE_OFF'] as const;
export type DailyLossAction = (typeof DAILY_LOSS_ACTIONS)[number];

export type LimitKind = 'rupees' | 'count' | 'ratio' | 'hhmm' | 'enum';
export type TighterDirection = 'lower' | 'earlier' | 'stricter';

interface LimitKeySpec {
  kind: LimitKind;
  tighter: TighterDirection;
  scopes: readonly LimitScope[];
}

const PER_VEHICLE = ['CASH_INTRADAY', 'MTF', 'OPTIONS_BUY'] as const;

export const LIMIT_KEYS = {
  maxDailyLoss: { kind: 'rupees', tighter: 'lower', scopes: ['ALL'] },
  maxDailyLossPerStrategy: { kind: 'rupees', tighter: 'lower', scopes: ['ALL'] },
  maxTradesPerDay: { kind: 'count', tighter: 'lower', scopes: ['ALL'] },
  maxOpenPositions: { kind: 'count', tighter: 'lower', scopes: ['ALL', ...PER_VEHICLE] },
  maxRiskPerTrade: { kind: 'rupees', tighter: 'lower', scopes: ['ALL'] },
  maxCapitalDeployed: { kind: 'rupees', tighter: 'lower', scopes: PER_VEHICLE },
  mtfMaxLeverage: { kind: 'ratio', tighter: 'lower', scopes: ['MTF'] },
  mtfMaxHoldDays: { kind: 'count', tighter: 'lower', scopes: ['MTF'] },
  optionsMaxPremiumPerTrade: { kind: 'rupees', tighter: 'lower', scopes: ['OPTIONS_BUY'] },
  lastEntryTime: { kind: 'hhmm', tighter: 'earlier', scopes: PER_VEHICLE },
  squareOffTime: { kind: 'hhmm', tighter: 'earlier', scopes: PER_VEHICLE },
  dailyLossAction: { kind: 'enum', tighter: 'stricter', scopes: ['ALL'] },
} as const satisfies Record<string, LimitKeySpec>;

export type LimitKey = keyof typeof LIMIT_KEYS;
export const LIMIT_KEY_NAMES = Object.keys(LIMIT_KEYS) as LimitKey[];

export interface LimitPair {
  key: LimitKey;
  scope: LimitScope;
}

/** Every (key, scope) a user has; the wall rejects when one it needs is missing. Display order. */
export const LIMIT_PAIRS: readonly LimitPair[] = LIMIT_KEY_NAMES.flatMap((key) =>
  (LIMIT_KEYS[key].scopes as readonly LimitScope[]).map((scope) => ({ key, scope })),
);

export const pairId = (p: { key: string; scope: string }): string => `${p.key}@${p.scope}`;

export function isLimitKey(s: string): s is LimitKey {
  return Object.prototype.hasOwnProperty.call(LIMIT_KEYS, s);
}

export function isLimitPair(key: string, scope: string): boolean {
  return isLimitKey(key) && (LIMIT_KEYS[key].scopes as readonly string[]).includes(scope);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isTextKind = (kind: LimitKind): boolean => kind === 'hhmm' || kind === 'enum';

/** A request value (JSON number or string) → the canonical stored string, or why not. */
export function parseLimitValue(key: LimitKey, raw: unknown): Parsed<string> {
  switch (LIMIT_KEYS[key].kind) {
    case 'rupees': {
      const d = toCapitalDecimal(raw);
      return d
        ? { ok: true, value: d.toFixed(2) }
        : { ok: false, error: 'must be a rupee amount: 0 or more, at most 2 decimal places, below 10^12' };
    }
    case 'count':
      return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw < 1e12
        ? { ok: true, value: String(raw) }
        : { ok: false, error: 'must be a whole number, 0 or more' };
    case 'ratio': {
      const d = toCapitalDecimal(raw);
      return d && d.gte(1)
        ? { ok: true, value: d.toFixed(2) }
        : { ok: false, error: 'must be a number of 1 or more with at most 2 decimal places' };
    }
    case 'hhmm':
      return typeof raw === 'string' && HHMM.test(raw)
        ? { ok: true, value: raw }
        : { ok: false, error: 'must be an IST time as HH:MM (24-hour)' };
    case 'enum':
      return typeof raw === 'string' && (DAILY_LOSS_ACTIONS as readonly string[]).includes(raw)
        ? { ok: true, value: raw }
        : { ok: false, error: `must be one of ${DAILY_LOSS_ACTIONS.join(', ')}` };
  }
}

export interface StoredLimitValue {
  numValue: Prisma.Decimal | null;
  textValue: string | null;
}

export function toStorage(key: LimitKey, canonical: string): StoredLimitValue {
  return isTextKind(LIMIT_KEYS[key].kind)
    ? { numValue: null, textValue: canonical }
    : { numValue: new Prisma.Decimal(canonical), textValue: null };
}

/** The canonical value of a stored row, or null when the row does not fit its key (treated as missing). */
export function fromStorage(key: LimitKey, numValue: Prisma.Decimal | null, textValue: string | null): string | null {
  const kind = LIMIT_KEYS[key].kind;
  if (isTextKind(kind)) {
    if (numValue !== null || textValue === null) return null;
    const p = parseLimitValue(key, textValue);
    return p.ok ? p.value : null;
  }
  if (textValue !== null || numValue === null) return null;
  const n = kind === 'count' ? (numValue.isInteger() ? numValue.toNumber() : NaN) : numValue.toNumber();
  const p = parseLimitValue(key, n);
  return p.ok ? p.value : null;
}

export function wireValue(key: LimitKey, canonical: string): number | string {
  return isTextKind(LIMIT_KEYS[key].kind) ? canonical : Number(canonical);
}

export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export type ChangeDirection = 'TIGHTER' | 'SAME' | 'LOOSER';

/** D5: is `proposed` tighter than, equal to, or looser than `current` for this key? */
export function compareLimit(key: LimitKey, current: string, proposed: string): ChangeDirection {
  const kind = LIMIT_KEYS[key].kind;
  let diff: number;
  if (kind === 'hhmm') {
    diff = hhmmToMinutes(proposed) - hhmmToMinutes(current);
  } else if (kind === 'enum') {
    const rank = (v: string) => (DAILY_LOSS_ACTIONS as readonly string[]).indexOf(v);
    diff = rank(current) - rank(proposed);
  } else {
    diff = new Prisma.Decimal(proposed).comparedTo(current);
  }
  return diff < 0 ? 'TIGHTER' : diff === 0 ? 'SAME' : 'LOOSER';
}
