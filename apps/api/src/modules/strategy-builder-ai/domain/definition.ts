/**
 * The Strategy Builder's definition, normalised.
 *
 * The web builder has two editors — a script DSL and a visual rule builder —
 * with different shapes. Everything downstream (the deterministic checklist,
 * the cache hash, the Claude prompt) works on ONE normalised shape built here,
 * so the same strategy always hashes the same and Claude never sees raw code.
 *
 * Pure: no Nest, no I/O. The script path reuses the existing DSL parser.
 */
import { StrategyParserService, type ConditionOperand, type ParsedRule } from '../../signal-generator/services/strategy-parser.service';

// ── Catalogue ──────────────────────────────────────────────────────────

export const SEGMENTS = ['OPTIONS', 'EQUITY', 'FUTURES', 'COMMODITY'] as const;
export type Segment = (typeof SEGMENTS)[number];

/** Intervals the data feed (Angel One historical + live candles) actually serves. */
export const SUPPORTED_INTERVALS = ['1m', '3m', '5m', '10m', '15m', '30m', '1h', '1d'] as const;

export const INDEX_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'] as const;
export const MCX_UNDERLYINGS = [
  'CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI', 'GOLD', 'GOLDM', 'GOLDPETAL', 'SILVER', 'SILVERM',
  'SILVERMIC', 'COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL',
] as const;
/** An NSE/BSE trading symbol shape (e.g. RELIANCE, M&M, BAJAJ-AUTO). */
export const SYMBOL_PATTERN = /^[A-Z][A-Z0-9&-]{0,19}$/;

export const STOP_KINDS = ['ATR', 'PERCENT', 'POINTS'] as const;
export type StopKind = (typeof STOP_KINDS)[number];
export const FILL_AT = ['next_open', 'signal_close', 'same_bar_open'] as const;
export type FillAt = (typeof FILL_AT)[number];

export const NOTES_MAX_CHARS = 300;
export const NAME_MAX_CHARS = 80;
const MAX_INDICATORS = 20;
const MAX_CONDITIONS = 40;
const MAX_CODE_CHARS = 20_000;

// ── Input (what the web sends) ─────────────────────────────────────────

export interface BuilderSettingsInput {
  stopLossKind?: string | null;
  stopLossValue?: number | null;
  targetKind?: string | null;
  targetValue?: number | null;
  riskPerTradeRupees?: number | null;
  capitalPerTradeRupees?: number | null;
  maxOpenPositions?: number | null;
  maxTradesPerDay?: number | null;
  sessionStart?: string | null;
  sessionEnd?: string | null;
  fillAt?: string | null;
}

export interface BuilderStateInput {
  strategyKey?: string;
  mode?: string;
  name?: string;
  description?: string;
  timeframe?: string;
  segment?: string;
  instrument?: string;
  code?: string;
  indicators?: Array<{ name?: unknown; params?: unknown }>;
  entryRules?: Array<{ logic?: unknown; conditions?: unknown }>;
  exitRules?: Array<{ logic?: unknown; conditions?: unknown }>;
  settings?: BuilderSettingsInput;
}

// ── Normalised definition ──────────────────────────────────────────────

export type Op = '>' | '<' | '>=' | '<=' | '==' | 'CROSSES_ABOVE' | 'CROSSES_BELOW' | 'BETWEEN';

export interface NormCondition {
  left: string;
  op: Op;
  right: string;
  right2?: string;
}

export interface NormRule {
  logic: 'AND' | 'OR';
  conditions: NormCondition[];
}

export interface NormIndicator {
  /** Variable name (script) or the canonical call text (visual), e.g. "rsi" / "RSI(close,14)". */
  ref: string;
  type: string;
  params: number[];
}

export interface StopSpec {
  kind: StopKind;
  value: number;
}

/** The editable settings, normalised: every field present, null when empty. */
export interface NormSettings {
  stopLossKind: StopKind | null;
  stopLossValue: number | null;
  targetKind: StopKind | null;
  targetValue: number | null;
  riskPerTradeRupees: number | null;
  capitalPerTradeRupees: number | null;
  maxOpenPositions: number | null;
  maxTradesPerDay: number | null;
  sessionStart: string | null;
  sessionEnd: string | null;
  fillAt: FillAt | null;
}

export interface StrategyDefinition {
  name: string;
  notes: string;
  mode: 'script' | 'visual';
  segment: string;
  instrument: string;
  timeframe: string;
  indicators: NormIndicator[];
  entry: { long: NormRule[]; short: NormRule[] };
  exit: { long: NormRule[]; short: NormRule[] };
  /** Effective stop / target: the structured setting, else the script's `stoploss` / `target` line. */
  stopLoss: StopSpec | null;
  target: StopSpec | null;
  settings: NormSettings;
}

export interface SchemaProblem {
  message: string;
  line?: number;
}

export interface NormaliseResult {
  definition: StrategyDefinition;
  /** Things that make the definition structurally unusable (become checklist errors). */
  problems: SchemaProblem[];
  /** Parser warnings worth surfacing. */
  warnings: SchemaProblem[];
  /** Stable key for cooldowns (saved id, else the lower-cased name). */
  strategyKey: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Operands are a closed vocabulary: identifiers, indicator calls, numbers, `x * n`. Never prose. */
const OPERAND_PATTERN = /^(?:-?\d+(?:\.\d+)?|[A-Za-z_]\w{0,31}(?:\([\w ,.]{0,30}\))?(?:\s*[*+\-/]\s*\d+(?:\.\d+)?)?)$/;

export function isValidOperand(s: string): boolean {
  return s.length <= 48 && OPERAND_PATTERN.test(s);
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function hhmm(v: unknown): string | null {
  return typeof v === 'string' && HHMM.test(v.trim()) ? v.trim() : null;
}

/** Collapse whitespace so "RSI(close, 14)" and "RSI(close,14)" are the same operand. */
function canonOperand(s: string): string {
  return s.replace(/\s+/g, '');
}

export function normaliseSettings(raw: BuilderSettingsInput | undefined): NormSettings {
  const s = raw ?? {};
  return {
    stopLossKind: oneOf(s.stopLossKind, STOP_KINDS),
    stopLossValue: num(s.stopLossValue),
    targetKind: oneOf(s.targetKind, STOP_KINDS),
    targetValue: num(s.targetValue),
    riskPerTradeRupees: num(s.riskPerTradeRupees),
    capitalPerTradeRupees: num(s.capitalPerTradeRupees),
    maxOpenPositions: num(s.maxOpenPositions),
    maxTradesPerDay: num(s.maxTradesPerDay),
    sessionStart: hhmm(s.sessionStart),
    sessionEnd: hhmm(s.sessionEnd),
    fillAt: oneOf(s.fillAt, FILL_AT),
  };
}

const VISUAL_OP: Record<string, Op> = {
  crosses_above: 'CROSSES_ABOVE',
  crosses_below: 'CROSSES_BELOW',
  greater_than: '>',
  less_than: '<',
  between: 'BETWEEN',
};

function operandText(o: ConditionOperand): string {
  if (o.type === 'number') return String(o.value);
  if (o.type === 'expression' && o.expression) return `${o.expression.variable}${o.expression.operator}${o.expression.value}`;
  return o.variable ?? '';
}

function fromParsedRule(rule: ParsedRule): NormRule[] {
  if (rule.conditions.length === 0) return [];
  return [
    {
      logic: rule.operator,
      conditions: rule.conditions.map((c) => ({ left: operandText(c.left), op: c.comparator as Op, right: operandText(c.right) })),
    },
  ];
}

function stopFromOperand(o: ConditionOperand | null): StopSpec | null {
  if (!o) return null;
  if (o.type === 'number' && typeof o.value === 'number') return { kind: 'POINTS', value: o.value };
  if (o.type === 'expression' && o.expression && /^atr/i.test(o.expression.variable) && o.expression.operator === '*') {
    return { kind: 'ATR', value: o.expression.value };
  }
  return null;
}

function stopFromSettings(kind: StopKind | null, value: number | null): StopSpec | null {
  return kind && value !== null ? { kind, value } : null;
}

const VISUAL_INDICATOR_TYPES = ['RSI', 'EMA', 'SMA', 'MACD', 'VWAP', 'BB', 'ATR', 'SUPERTREND', 'ADX', 'VOLUME', 'OI'];

function normaliseVisualRules(raw: BuilderStateInput['entryRules'], side: string, problems: SchemaProblem[]): NormRule[] {
  const out: NormRule[] = [];
  (Array.isArray(raw) ? raw : []).forEach((r, ri) => {
    const logic = r?.logic === 'OR' ? 'OR' : 'AND';
    const conds = Array.isArray(r?.conditions) ? (r.conditions as Array<Record<string, unknown>>) : [];
    const conditions: NormCondition[] = [];
    conds.forEach((c, ci) => {
      const where = `${side} rule ${ri + 1}, condition ${ci + 1}`;
      const rawLeft = str(c?.leftOperand, 60);
      const rawRight = str(c?.rightOperand, 60);
      const op = VISUAL_OP[str(c?.operator, 20)];
      if (!rawLeft || !rawRight) {
        problems.push({ message: `${where} is incomplete (both sides must be set)` });
        return;
      }
      if (!op) {
        problems.push({ message: `${where} has an unknown operator` });
        return;
      }
      if (!isValidOperand(rawLeft) || !isValidOperand(rawRight)) {
        problems.push({ message: `${where} has an operand that is not an indicator, price field or number` });
        return;
      }
      // Validate BEFORE collapsing whitespace, or "ignore all rules" would become one identifier.
      const cond: NormCondition = { left: canonOperand(rawLeft), op, right: canonOperand(rawRight) };
      if (op === 'BETWEEN') {
        const rawRight2 = str(c?.rightOperand2, 60);
        if (!rawRight2 || !isValidOperand(rawRight2)) {
          problems.push({ message: `${where} uses "between" without a valid upper bound` });
          return;
        }
        cond.right2 = canonOperand(rawRight2);
      }
      conditions.push(cond);
    });
    if (conditions.length > 0) out.push({ logic, conditions });
  });
  return out;
}

// ── Entry point ────────────────────────────────────────────────────────

const parser = new StrategyParserService();

export function normaliseBuilderState(input: BuilderStateInput): NormaliseResult {
  const problems: SchemaProblem[] = [];
  const warnings: SchemaProblem[] = [];
  const mode = input.mode === 'visual' ? 'visual' : 'script';
  const name = str(input.name, NAME_MAX_CHARS);
  const settings = normaliseSettings(input.settings);

  let indicators: NormIndicator[] = [];
  let entry: StrategyDefinition['entry'] = { long: [], short: [] };
  let exit: StrategyDefinition['exit'] = { long: [], short: [] };
  let scriptStop: StopSpec | null = null;
  let scriptTarget: StopSpec | null = null;

  if (mode === 'script') {
    const code = typeof input.code === 'string' ? input.code : '';
    if (code.length > MAX_CODE_CHARS) {
      problems.push({ message: `Script is too long (max ${MAX_CODE_CHARS} characters)` });
    } else if (code.trim() === '') {
      problems.push({ message: 'Script is empty' });
    } else {
      const parsed = parser.parseScript(code);
      for (const e of parsed.errors) problems.push({ message: e.message, line: e.line });
      for (const w of parsed.warnings) {
        // The checklist reports missing entries/exits itself, with severity.
        if (!/^No (entry|exit) conditions|^No indicators/.test(w.message)) warnings.push({ message: w.message, line: w.line });
      }
      if (parsed.parsed) {
        const p = parsed.parsed;
        indicators = p.indicators
          .filter((i) => i.period > 0)
          .map((i) => ({ ref: i.variable, type: i.type, params: [i.period, ...i.extraParams] }));
        entry = { long: fromParsedRule(p.entryRules.long), short: fromParsedRule(p.entryRules.short) };
        exit = { long: fromParsedRule(p.exitRules.long), short: fromParsedRule(p.exitRules.short) };
        scriptStop = stopFromOperand(p.riskConfig.stoploss);
        scriptTarget = stopFromOperand(p.riskConfig.target);
      }
    }
  } else {
    const rawInd = Array.isArray(input.indicators) ? input.indicators : [];
    for (const ind of rawInd) {
      const type = str(ind?.name, 20).toUpperCase();
      if (!VISUAL_INDICATOR_TYPES.includes(type)) {
        problems.push({ message: `Unknown indicator "${type.slice(0, 20) || '(blank)'}"` });
        continue;
      }
      const params = ind?.params && typeof ind.params === 'object'
        ? Object.values(ind.params as Record<string, unknown>).map(num).filter((n): n is number => n !== null)
        : [];
      indicators.push({ ref: `${type}(${params.join(',')})`, type, params });
    }
    // The visual builder has no direction: its entry/exit groups are long-side.
    entry = { long: normaliseVisualRules(input.entryRules, 'Entry', problems), short: [] };
    exit = { long: normaliseVisualRules(input.exitRules, 'Exit', problems), short: [] };
  }

  if (indicators.length > MAX_INDICATORS) problems.push({ message: `Too many indicators (max ${MAX_INDICATORS})` });
  const condCount = [...entry.long, ...entry.short, ...exit.long, ...exit.short].reduce((n, r) => n + r.conditions.length, 0);
  if (condCount > MAX_CONDITIONS) problems.push({ message: `Too many conditions (max ${MAX_CONDITIONS})` });

  const definition: StrategyDefinition = {
    name,
    notes: str(input.description, NOTES_MAX_CHARS),
    mode,
    segment: str(input.segment, 20).toUpperCase(),
    instrument: str(input.instrument, 20).toUpperCase(),
    timeframe: str(input.timeframe, 8),
    indicators: indicators.slice(0, MAX_INDICATORS),
    entry,
    exit,
    stopLoss: stopFromSettings(settings.stopLossKind, settings.stopLossValue) ?? scriptStop,
    target: stopFromSettings(settings.targetKind, settings.targetValue) ?? scriptTarget,
    settings,
  };
  const key = str(input.strategyKey, 64) || name.toLowerCase() || '(untitled)';
  return { definition, problems, warnings, strategyKey: key };
}

/** Deterministic JSON (sorted keys) — the basis of the cache hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
