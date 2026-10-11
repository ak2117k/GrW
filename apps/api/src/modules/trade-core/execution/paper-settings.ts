import { Prisma } from '@prisma/client';
import { VEHICLES, type Vehicle } from '../strategies/blocks/block-types';

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;

/**
 * The paper settings vocabulary (spec §4.5). Values are rows in core_paper_defaults
 * (D4: never constants in code); this file only knows the keys, their scopes and each
 * key's admissible SHAPE. maxLotsPerOrder is scoped by option underlying (E4) and is
 * open-ended so the owner can add a stock's row without a migration.
 */
export const PAPER_KEYS = [
  'startingCapital',
  'intradayLeverage',
  'slippageBps',
  'noPriceRejectMs',
  'mtfFundedShare',
  'mtfAnnualRatePct',
  'mtfPledgeFee',
  'maxLotsPerOrder',
] as const;
export type PaperKey = (typeof PAPER_KEYS)[number];

export const PAPER_KEY_SCOPES: Readonly<Record<Exclude<PaperKey, 'maxLotsPerOrder'>, readonly string[]>> = {
  startingCapital: ['ALL'],
  intradayLeverage: ['CASH_INTRADAY'],
  slippageBps: VEHICLES,
  noPriceRejectMs: ['ALL'],
  mtfFundedShare: ['MTF'],
  mtfAnnualRatePct: ['MTF'],
  mtfPledgeFee: ['MTF'],
};

/** An option underlying as the instrument master names it (NIFTY, BANKNIFTY, M&M, BAJAJ-AUTO). */
export const UNDERLYING_SCOPE = /^[A-Z0-9&-]{1,30}$/;
const RESERVED_SCOPES: readonly string[] = ['ALL', ...VEHICLES];

export const paperPairId = (key: string, scope: string): string => `${key}@${scope}`;

/** Every order needs these; a missing one rejects every order (fail closed). */
export const REQUIRED_PAPER_PAIRS: readonly string[] = (Object.keys(PAPER_KEY_SCOPES) as Array<keyof typeof PAPER_KEY_SCOPES>).flatMap(
  (key) => PAPER_KEY_SCOPES[key].map((scope) => paperPairId(key, scope)),
);

export function isPaperKey(k: string): k is PaperKey {
  return (PAPER_KEYS as readonly string[]).includes(k);
}

export function isPaperPair(key: string, scope: string): boolean {
  if (!isPaperKey(key)) return false;
  if (key === 'maxLotsPerOrder') return UNDERLYING_SCOPE.test(scope) && !RESERVED_SCOPES.includes(scope);
  return PAPER_KEY_SCOPES[key].includes(scope);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): Parsed<Dec> => ({ ok: false, error });
const okValue = (value: Dec): Parsed<Dec> => ({ ok: true, value });

/** Shape bounds only (no money or risk values): what a value of this key can be. Mirrors the migration's CHECK. */
export function parsePaperValue(key: PaperKey, raw: unknown): Parsed<Dec> {
  const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : typeof raw === 'string' ? raw.trim() : null;
  if (text === null || !/^\d+(\.\d{1,2})?$/.test(text)) return fail('must be a number of 0 or more with at most 2 decimals');
  const v = new D(text);
  if (v.gt('999999999999.99')) return fail('is too large');
  switch (key) {
    case 'startingCapital':
      return v.gt(0) ? okValue(v) : fail('must be above 0');
    case 'intradayLeverage':
      return v.gte(1) ? okValue(v) : fail('must be at least 1');
    case 'slippageBps':
      return v.lte(10000) ? okValue(v) : fail('must be at most 10000 bps');
    case 'noPriceRejectMs':
      return v.isInteger() && v.gte(1000) ? okValue(v) : fail('must be a whole number of milliseconds, at least 1000');
    case 'mtfFundedShare':
      return v.lt(1) ? okValue(v) : fail('must be below 1 (the fraction of the notional the broker funds)');
    case 'mtfAnnualRatePct':
      return v.lte(100) ? okValue(v) : fail('must be at most 100 (percent a year)');
    case 'mtfPledgeFee':
      return okValue(v);
    case 'maxLotsPerOrder':
      return v.isInteger() && v.gte(1) ? okValue(v) : fail('must be a whole number of lots, at least 1');
  }
}

export interface PaperSettings {
  startingCapital: Dec;
  intradayLeverage: Dec;
  slippageBps: Record<Vehicle, Dec>;
  noPriceRejectMs: number;
  mtfFundedShare: Dec;
  mtfAnnualRatePct: Dec;
  mtfPledgeFee: Dec;
  /** Lots per order by option underlying; an underlying absent here rejects its orders. */
  maxLotsPerOrder: Readonly<Record<string, number>>;
}

export interface PaperDefaultValue {
  key: string;
  scope: string;
  numValue: Dec;
}

export type PaperSettingsResult = { ok: true; settings: PaperSettings } | { ok: false; missing: string[] };

/** The settings from the default rows (per-user overrides are a later milestone). Fails closed on any required pair. */
export function resolvePaperSettings(rows: readonly PaperDefaultValue[]): PaperSettingsResult {
  const valid = new Map<string, Dec>();
  for (const r of rows) {
    if (!isPaperPair(r.key, r.scope)) continue;
    const parsed = parsePaperValue(r.key as PaperKey, r.numValue.toString());
    if (parsed.ok) valid.set(paperPairId(r.key, r.scope), parsed.value);
  }
  const missing = REQUIRED_PAPER_PAIRS.filter((id) => !valid.has(id));
  if (missing.length > 0) return { ok: false, missing };
  const get = (key: string, scope: string) => valid.get(paperPairId(key, scope)) as Dec;
  const maxLotsPerOrder: Record<string, number> = {};
  for (const [id, v] of valid) {
    if (id.startsWith('maxLotsPerOrder@')) maxLotsPerOrder[id.slice('maxLotsPerOrder@'.length)] = v.toNumber();
  }
  return {
    ok: true,
    settings: {
      startingCapital: get('startingCapital', 'ALL'),
      intradayLeverage: get('intradayLeverage', 'CASH_INTRADAY'),
      slippageBps: Object.fromEntries(VEHICLES.map((v) => [v, get('slippageBps', v)])) as Record<Vehicle, Dec>,
      noPriceRejectMs: get('noPriceRejectMs', 'ALL').toNumber(),
      mtfFundedShare: get('mtfFundedShare', 'MTF'),
      mtfAnnualRatePct: get('mtfAnnualRatePct', 'MTF'),
      mtfPledgeFee: get('mtfPledgeFee', 'MTF'),
      maxLotsPerOrder,
    },
  };
}
