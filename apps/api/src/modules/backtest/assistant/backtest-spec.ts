/**
 * The structured backtest spec Claude must return for "Ask Claude to backtest…", and its
 * validation into the Strategy Builder's executable form (`ParsedStrategy`).
 *
 * Claude only ever fills this JSON — never code. Its vocabulary is exactly the Strategy Builder's
 * (StrategyExecutorService): the indicators in SUPPORTED_INDICATORS (minus OI, which the executor
 * cannot compute), the comparators in SUPPORTED_CONDITIONS, price fields, numbers, and a stop /
 * target as percent, points or ATR multiple. Anything else is rejected here, before data is
 * fetched or a bar is read.
 */
import type {
  ConditionOperand,
  ParsedCondition,
  ParsedIndicator,
  ParsedRule,
  ParsedStrategy,
} from '../../signal-generator/services/strategy-parser.service';
import type { IndicatorType } from '../../signal-generator/dto/user-strategy.dto';
import { DAY_MS, intervalMinutes } from '../data/backtest-data.domain';

export const SPEC_INDICATORS = ['RSI', 'EMA', 'SMA', 'MACD', 'BB', 'ATR', 'VWAP', 'SUPERTREND', 'ADX', 'VOLUME'] as const;
export const SPEC_COMPARATORS = ['<', '>', '<=', '>=', 'CROSSES_ABOVE', 'CROSSES_BELOW'] as const;
export const SPEC_TIMEFRAMES = ['1m', '3m', '5m', '10m', '15m', '30m', '1h', '1d'] as const;
export const SPEC_EXCHANGES = ['NSE', 'BSE', 'NFO', 'MCX'] as const;
const PRICE_FIELDS = ['open', 'high', 'low', 'close'] as const;
const STOP_TYPES = ['percent', 'points', 'atr'] as const;

/** Extra parameters each indicator accepts after `period` (executor semantics). */
const EXTRA_PARAMS: Record<string, number> = { RSI: 0, EMA: 0, SMA: 0, MACD: 2, BB: 1, ATR: 0, VWAP: 0, SUPERTREND: 1, ADX: 0, VOLUME: 0 };
/** Sub-series names the executor registers next to the indicator's own id. */
const SUB_OUTPUTS: Record<string, string[]> = { MACD: ['signal', 'hist'], BB: ['upper', 'lower'] };
const NO_PERIOD = new Set(['VWAP', 'VOLUME']);

export const MAX_SPAN_DAYS = 3653;
export const DEFAULT_MAX_BARS = 300_000;
const BARS_PER_SESSION_MIN = 375;
const SESSIONS_PER_YEAR = 250;

// ── JSON schema (enforced by the API transport; a prompt instruction for the CLI) ───────────────

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

const OPERAND_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['indicator', 'price', 'number'] },
    ref: { type: ['string', 'null'], description: 'indicator: an indicators[].id, or id_signal / id_hist (MACD), id_upper / id_lower (BB; the id itself is the middle band). price: open|high|low|close. number: null.' },
    value: { type: ['number', 'null'], description: 'number operands only' },
    multiplier: { type: ['number', 'null'], description: 'optional: the indicator/price value times this (e.g. 1.01 = 1% above)' },
  },
  required: ['kind', 'ref', 'value', 'multiplier'],
  additionalProperties: false,
};

const RULE_SCHEMA = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['AND', 'OR'] },
    conditions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          left: OPERAND_SCHEMA,
          cmp: { type: 'string', enum: [...SPEC_COMPARATORS] },
          right: OPERAND_SCHEMA,
        },
        required: ['left', 'cmp', 'right'],
        additionalProperties: false,
      },
    },
  },
  required: ['op', 'conditions'],
  additionalProperties: false,
};

const RISK_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: [...STOP_TYPES] },
    value: { type: 'number', description: 'percent of price (1.5 = 1.5%), price points, or ATR multiple' },
    atrPeriod: { type: ['integer', 'null'] },
  },
  required: ['type', 'value', 'atrPeriod'],
  additionalProperties: false,
};

export const BACKTEST_SPEC_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    feasible: { type: 'boolean', description: 'false when the request cannot be expressed with this vocabulary' },
    reason: { type: ['string', 'null'], description: 'why not feasible (null when feasible)' },
    symbol: { type: 'string', description: 'NSE trading symbol, e.g. NIFTY, BANKNIFTY, TATAMOTORS' },
    exchange: { type: 'string', enum: [...SPEC_EXCHANGES] },
    timeframe: { type: 'string', enum: [...SPEC_TIMEFRAMES] },
    lookbackDays: { type: ['integer', 'null'], description: 'calendar days back from today; null when explicit dates are given' },
    startDate: { type: ['string', 'null'], description: 'YYYY-MM-DD or null' },
    endDate: { type: ['string', 'null'], description: 'YYYY-MM-DD or null (null = today)' },
    direction: { type: 'string', enum: ['long', 'short', 'both'] },
    indicators: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'lowercase name used by the rules, e.g. ema_fast' },
          type: { type: 'string', enum: [...SPEC_INDICATORS] },
          source: { type: 'string', enum: [...PRICE_FIELDS] },
          period: { type: 'integer' },
          params: { type: 'array', items: { type: 'number' }, description: 'MACD: [slow, signal]; BB: [stdDev]; SUPERTREND: [multiplier]; else []' },
        },
        required: ['id', 'type', 'source', 'period', 'params'],
        additionalProperties: false,
      },
    },
    entryLong: nullable(RULE_SCHEMA),
    entryShort: nullable(RULE_SCHEMA),
    exitLong: nullable(RULE_SCHEMA),
    exitShort: nullable(RULE_SCHEMA),
    stop: nullable(RISK_SCHEMA),
    target: nullable(RISK_SCHEMA),
    initialCapital: { type: ['number', 'null'] },
    positionSizePct: { type: ['number', 'null'], description: 'percent of capital per trade, 1-100 (null = 100)' },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'defaults you chose that the request did not state' },
  },
  required: [
    'feasible', 'reason', 'symbol', 'exchange', 'timeframe', 'lookbackDays', 'startDate', 'endDate', 'direction',
    'indicators', 'entryLong', 'entryShort', 'exitLong', 'exitShort', 'stop', 'target', 'initialCapital',
    'positionSizePct', 'assumptions',
  ],
  additionalProperties: false,
};

// ── types ──────────────────────────────────────────────────────────────────────────────────────

export interface SpecOperand {
  kind: 'indicator' | 'price' | 'number';
  ref: string | null;
  value: number | null;
  multiplier: number | null;
}
export interface SpecRule {
  op: 'AND' | 'OR';
  conditions: Array<{ left: SpecOperand; cmp: (typeof SPEC_COMPARATORS)[number]; right: SpecOperand }>;
}
export interface SpecRisk {
  type: (typeof STOP_TYPES)[number];
  value: number;
  atrPeriod: number | null;
}
export interface BacktestSpec {
  feasible: boolean;
  reason: string | null;
  symbol: string;
  exchange: string;
  timeframe: string;
  lookbackDays: number | null;
  startDate: string | null;
  endDate: string | null;
  direction: 'long' | 'short' | 'both';
  indicators: Array<{ id: string; type: string; source: string; period: number; params: number[] }>;
  entryLong: SpecRule | null;
  entryShort: SpecRule | null;
  exitLong: SpecRule | null;
  exitShort: SpecRule | null;
  stop: SpecRisk | null;
  target: SpecRisk | null;
  initialCapital: number | null;
  positionSizePct: number | null;
  assumptions: string[];
}

export interface ValidSpec {
  spec: BacktestSpec;
  parsed: ParsedStrategy;
  from: Date;
  to: Date;
  initialCapital: number;
  positionSizePct: number;
}

export type SpecVerdict = { ok: true; value: ValidSpec } | { ok: false; infeasible?: boolean; errors: string[] };

// ── validation ─────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function parseYmd(s: string): Date | null {
  if (!YMD.test(s)) return null;
  const d = new Date(`${s}T00:00:00+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Rough bar count of a span at a timeframe (NSE regular session). */
export function estimateBars(timeframe: string, from: Date, to: Date): number {
  const mins = intervalMinutes(timeframe) ?? 1440;
  const sessions = ((to.getTime() - from.getTime()) / DAY_MS) * (SESSIONS_PER_YEAR / 365);
  return Math.ceil(sessions * (mins >= 1440 ? 1 : Math.ceil(BARS_PER_SESSION_MIN / mins)));
}

/**
 * Validate a model reply into an executable strategy. `now` pins "today"; `maxBars` caps the
 * request so a 10-year 1-minute run is refused before any data is read.
 */
export function validateSpec(raw: unknown, now: Date, maxBars = DEFAULT_MAX_BARS): SpecVerdict {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['the reply is not a JSON object'] };
  if (raw.feasible === false) {
    return { ok: false, infeasible: true, errors: [String(raw.reason || 'the request cannot be expressed as a backtest here')] };
  }
  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim().toUpperCase() : '';
  if (!/^[A-Z0-9&-]{1,30}$/.test(symbol)) errors.push(`invalid symbol "${raw.symbol}"`);
  const exchange = typeof raw.exchange === 'string' ? raw.exchange.toUpperCase() : 'NSE';
  if (!(SPEC_EXCHANGES as readonly string[]).includes(exchange)) errors.push(`invalid exchange "${raw.exchange}"`);
  const timeframe = String(raw.timeframe ?? '');
  if (!(SPEC_TIMEFRAMES as readonly string[]).includes(timeframe)) errors.push(`unsupported timeframe "${raw.timeframe}"`);
  const direction = raw.direction;
  if (!['long', 'short', 'both'].includes(direction)) errors.push(`invalid direction "${direction}"`);

  // period
  let to = now;
  let from: Date | null = null;
  if (raw.endDate != null) {
    const e = typeof raw.endDate === 'string' ? parseYmd(raw.endDate) : null;
    if (!e) errors.push(`invalid endDate "${raw.endDate}"`);
    else to = new Date(Math.min(e.getTime() + DAY_MS - 1, now.getTime()));
  }
  if (raw.startDate != null) {
    from = typeof raw.startDate === 'string' ? parseYmd(raw.startDate) : null;
    if (!from) errors.push(`invalid startDate "${raw.startDate}"`);
  } else if (raw.lookbackDays != null) {
    const n = raw.lookbackDays;
    if (!Number.isInteger(n) || n < 1 || n > MAX_SPAN_DAYS) errors.push(`lookbackDays must be 1-${MAX_SPAN_DAYS}`);
    else from = new Date(to.getTime() - n * DAY_MS);
  } else {
    errors.push('no period: give lookbackDays or startDate');
  }
  if (from && from.getTime() >= to.getTime()) errors.push('startDate must be before endDate (and not in the future)');
  if (from && to.getTime() - from.getTime() > MAX_SPAN_DAYS * DAY_MS) errors.push('period longer than 10 years');
  if (from && errors.length === 0 && (SPEC_TIMEFRAMES as readonly string[]).includes(timeframe)) {
    const bars = estimateBars(timeframe, from, to);
    if (bars > maxBars) errors.push(`~${bars} ${timeframe} bars exceeds the ${maxBars}-bar cap: shorten the period or use a coarser timeframe`);
  }

  // indicators
  const ids = new Map<string, string>(); // referable name -> indicator type
  const indicators: ParsedIndicator[] = [];
  const list = Array.isArray(raw.indicators) ? raw.indicators : null;
  if (!list) errors.push('indicators must be an array');
  else if (list.length > 8) errors.push('at most 8 indicators');
  for (const [i, ind] of (list ?? []).entries()) {
    if (!isObj(ind)) { errors.push(`indicator #${i + 1} is not an object`); continue; }
    const id = String(ind.id ?? '');
    const type = String(ind.type ?? '').toUpperCase();
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(id) || id.startsWith('px_') || id.startsWith('risk_')) {
      errors.push(`indicator id "${id}" must be lowercase letters/digits/_ (and not px_/risk_)`);
      continue;
    }
    if (ids.has(id)) { errors.push(`duplicate indicator id "${id}"`); continue; }
    if (!(SPEC_INDICATORS as readonly string[]).includes(type)) {
      errors.push(`unknown indicator "${ind.type}" (allowed: ${SPEC_INDICATORS.join(', ')})`);
      continue;
    }
    const source = String(ind.source ?? 'close');
    if (!(PRICE_FIELDS as readonly string[]).includes(source)) errors.push(`indicator "${id}": invalid source "${source}"`);
    const period = NO_PERIOD.has(type) ? 1 : ind.period;
    if (!Number.isInteger(period) || period < 1 || period > 500) errors.push(`indicator "${id}": period must be an integer 1-500`);
    const params = Array.isArray(ind.params) ? ind.params : [];
    if (params.length > EXTRA_PARAMS[type] || !params.every((p: unknown) => finite(p) && (p as number) > 0 && (p as number) <= 500)) {
      errors.push(`indicator "${id}": ${type} takes at most ${EXTRA_PARAMS[type]} extra positive parameter(s)`);
    }
    ids.set(id, type);
    for (const sub of SUB_OUTPUTS[type] ?? []) ids.set(`${id}_${sub}`, type);
    indicators.push({ variable: id, type: type as IndicatorType, source, period, extraParams: params.map(Number) });
  }

  // operands → executor operands (price fields become 1-period SMAs of that field)
  const helpers = new Map<string, ParsedIndicator>();
  const priceVar = (field: string) => {
    const v = `px_${field}`;
    if (!helpers.has(v)) helpers.set(v, { variable: v, type: 'SMA', source: field, period: 1, extraParams: [] });
    return v;
  };
  const operand = (o: unknown, where: string): ConditionOperand | null => {
    if (!isObj(o)) { errors.push(`${where}: operand is not an object`); return null; }
    const mult = o.multiplier;
    if (mult != null && !(finite(mult) && mult > 0 && mult <= 100)) { errors.push(`${where}: multiplier must be in (0, 100]`); return null; }
    let variable: string;
    if (o.kind === 'number') {
      if (!finite(o.value)) { errors.push(`${where}: number operand needs a finite value`); return null; }
      return { type: 'number', value: o.value };
    } else if (o.kind === 'price') {
      if (!(PRICE_FIELDS as readonly string[]).includes(o.ref)) { errors.push(`${where}: price ref must be open|high|low|close`); return null; }
      variable = priceVar(o.ref);
    } else if (o.kind === 'indicator') {
      if (typeof o.ref !== 'string' || !ids.has(o.ref)) { errors.push(`${where}: unknown indicator ref "${o.ref}"`); return null; }
      variable = o.ref;
    } else {
      errors.push(`${where}: operand kind must be indicator|price|number`);
      return null;
    }
    return mult != null && mult !== 1
      ? { type: 'expression', expression: { variable, operator: '*', value: mult } }
      : { type: 'variable', variable };
  };
  const rule = (r: unknown, name: string): ParsedRule => {
    const empty: ParsedRule = { operator: 'AND', conditions: [] };
    if (r == null) return empty;
    if (!isObj(r) || !['AND', 'OR'].includes(r.op) || !Array.isArray(r.conditions)) {
      errors.push(`${name}: must be {op: AND|OR, conditions: [...]}`);
      return empty;
    }
    if (r.conditions.length > 6) errors.push(`${name}: at most 6 conditions`);
    const conditions: ParsedCondition[] = [];
    for (const [i, c] of r.conditions.entries()) {
      const where = `${name} #${i + 1}`;
      if (!isObj(c) || !(SPEC_COMPARATORS as readonly string[]).includes(c.cmp)) {
        errors.push(`${where}: comparator must be one of ${SPEC_COMPARATORS.join(' ')}`);
        continue;
      }
      const left = operand(c.left, where);
      const right = operand(c.right, where);
      if (left && right) conditions.push({ left, comparator: c.cmp, right });
    }
    return { operator: r.op, conditions };
  };
  const entryLong = rule(raw.entryLong, 'entryLong');
  const entryShort = rule(raw.entryShort, 'entryShort');
  const exitLong = rule(raw.exitLong, 'exitLong');
  const exitShort = rule(raw.exitShort, 'exitShort');

  const risk = (r: unknown, name: string): ConditionOperand | null => {
    if (r == null) return null;
    if (!isObj(r) || !(STOP_TYPES as readonly string[]).includes(r.type) || !finite(r.value) || r.value <= 0) {
      errors.push(`${name}: must be {type: percent|points|atr, value > 0}`);
      return null;
    }
    if (r.type === 'percent') {
      if (r.value > 50) { errors.push(`${name}: percent must be ≤ 50`); return null; }
      return { type: 'expression', expression: { variable: priceVar('close'), operator: '*', value: r.value / 100 } };
    }
    if (r.type === 'points') return { type: 'number', value: r.value };
    const p = r.atrPeriod ?? 14;
    if (!Number.isInteger(p) || p < 1 || p > 200 || r.value > 20) { errors.push(`${name}: ATR period 1-200, multiple ≤ 20`); return null; }
    const v = `risk_atr${p}`;
    if (!helpers.has(v)) helpers.set(v, { variable: v, type: 'ATR', source: 'close', period: p, extraParams: [] });
    return { type: 'expression', expression: { variable: v, operator: '*', value: r.value } };
  };
  const stoploss = risk(raw.stop, 'stop');
  const target = risk(raw.target, 'target');

  const wantsLong = direction === 'long' || direction === 'both';
  const wantsShort = direction === 'short' || direction === 'both';
  if (wantsLong && entryLong.conditions.length === 0) errors.push('direction includes long but entryLong has no conditions');
  if (wantsShort && entryShort.conditions.length === 0) errors.push('direction includes short but entryShort has no conditions');
  const noExit = (r: ParsedRule) => r.conditions.length === 0 && !stoploss && !target;
  if ((wantsLong && noExit(exitLong)) || (wantsShort && noExit(exitShort))) errors.push('no way out of a trade: add an exit rule, a stop or a target');

  const capital = raw.initialCapital == null ? 1_000_000 : raw.initialCapital;
  if (!finite(capital) || capital < 10_000 || capital > 1e9) errors.push('initialCapital must be 10,000 - 1,000,000,000');
  const sizePct = raw.positionSizePct == null ? 100 : raw.positionSizePct;
  if (!finite(sizePct) || sizePct < 1 || sizePct > 100) errors.push('positionSizePct must be 1-100');

  if (errors.length > 0 || !from) return { ok: false, errors };
  const spec: BacktestSpec = {
    ...(raw as BacktestSpec),
    symbol,
    exchange,
    assumptions: Array.isArray(raw.assumptions) ? raw.assumptions.map(String).slice(0, 10) : [],
  };
  const parsed: ParsedStrategy = {
    name: `ai:${symbol}:${timeframe}`,
    timeframe,
    indicators: [...indicators, ...helpers.values()],
    entryRules: { long: wantsLong ? entryLong : { operator: 'AND', conditions: [] }, short: wantsShort ? entryShort : { operator: 'AND', conditions: [] } },
    exitRules: { long: exitLong, short: exitShort },
    riskConfig: { stoploss, target },
  };
  return { ok: true, value: { spec, parsed, from, to, initialCapital: capital, positionSizePct: sizePct } };
}

/** One line a human can read back ("EMA(20) CROSSES_ABOVE EMA(50) …") for the UI and the summary prompt. */
export function describeSpec(v: ValidSpec): string {
  const s = v.spec;
  const ind = s.indicators.map((i) => `${i.id}=${i.type}(${[i.period, ...i.params].join(',')}${i.source !== 'close' ? ` ${i.source}` : ''})`).join(' ');
  const op = (o: SpecOperand) => (o.kind === 'number' ? String(o.value) : `${o.ref}${o.multiplier != null && o.multiplier !== 1 ? `*${o.multiplier}` : ''}`);
  const rule = (r: SpecRule | null) => (r && r.conditions.length ? r.conditions.map((c) => `${op(c.left)} ${c.cmp} ${op(c.right)}`).join(` ${r.op} `) : '-');
  const risk = (r: SpecRisk | null) => (r ? `${r.value}${r.type === 'percent' ? '%' : r.type === 'atr' ? `xATR(${r.atrPeriod ?? 14})` : ' pts'}` : '-');
  return [
    `${s.symbol} ${s.exchange} ${s.timeframe} ${v.from.toISOString().slice(0, 10)}..${v.to.toISOString().slice(0, 10)} ${s.direction}`,
    `indicators: ${ind || '-'}`,
    `entry long: ${rule(s.entryLong)} | entry short: ${rule(s.entryShort)}`,
    `exit long: ${rule(s.exitLong)} | exit short: ${rule(s.exitShort)}`,
    `stop: ${risk(s.stop)} target: ${risk(s.target)} size: ${v.positionSizePct}% of ${v.initialCapital}`,
  ].join('\n');
}
