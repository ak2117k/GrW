/**
 * Deterministic strategy checks — free, always on, for every user.
 *
 * Runs on the normalised definition (definition.ts) plus the user's own Risk
 * Wall limits. Each check yields one checklist item with a stable id; the
 * Claude review is only offered when no item is an error.
 */
import {
  INDEX_UNDERLYINGS,
  MCX_UNDERLYINGS,
  SEGMENTS,
  SUPPORTED_INTERVALS,
  SYMBOL_PATTERN,
  canonicalJson,
  type NormCondition,
  type NormRule,
  type NormaliseResult,
  type StrategyDefinition,
} from './definition';

export type CheckStatus = 'pass' | 'warn' | 'error';

export interface CheckItem {
  id: CheckId;
  status: CheckStatus;
  label: string;
  /** Every finding for this check, most severe first. */
  details: string[];
}

export type CheckId =
  | 'schema'
  | 'instrument'
  | 'interval'
  | 'contradictions'
  | 'stop-loss'
  | 'exit'
  | 'sizing'
  | 'look-ahead'
  | 'overfitting';

/** The user's limits in force, in rupees / counts (null = not set / unavailable). */
export interface RiskLimitsView {
  maxRiskPerTrade: number | null;
  maxOpenPositions: number | null;
  maxTradesPerDay: number | null;
  optionsMaxPremiumPerTrade: number | null;
  /** maxCapitalDeployed for the vehicle the strategy's segment maps to. */
  maxCapitalDeployed: number | null;
}

export interface CheckReport {
  items: CheckItem[];
  errors: number;
  warnings: number;
}

interface Finding {
  status: Exclude<CheckStatus, 'pass'>;
  text: string;
}

const LABELS: Record<CheckId, string> = {
  schema: 'Definition is complete',
  instrument: 'Instrument is supported',
  interval: 'Interval is supported',
  contradictions: 'No contradictory rules',
  'stop-loss': 'Has a stop-loss',
  exit: 'Has a way to exit',
  sizing: 'Sizing within your risk limits',
  'look-ahead': 'No look-ahead bias',
  overfitting: 'Parameter count is reasonable',
};

const BOUNDED_0_100 = new Set(['RSI', 'ADX']);
const INTRADAY = new Set(['1m', '3m', '5m', '10m', '15m', '30m', '1h']);

// ── Small helpers ──────────────────────────────────────────────────────

const allRules = (d: StrategyDefinition): NormRule[] => [...d.entry.long, ...d.entry.short, ...d.exit.long, ...d.exit.short];
const entryRules = (d: StrategyDefinition): NormRule[] => [...d.entry.long, ...d.entry.short];

function asNumber(operand: string): number | null {
  return /^-?\d+(\.\d+)?$/.test(operand) ? Number(operand) : null;
}

/** The indicator type behind an operand ("rsi" → RSI via the script's declarations, "RSI(close,14)" → RSI). */
function seriesType(operand: string, d: StrategyDefinition): string | null {
  const declared = d.indicators.find((i) => i.ref === operand);
  if (declared) return declared.type;
  const call = operand.match(/^([A-Za-z]+)\(/);
  if (call) return call[1].toUpperCase();
  const prefix = operand.match(/^(rsi|adx)/i);
  return prefix ? prefix[1].toUpperCase() : null;
}

function describe(c: NormCondition): string {
  return c.op === 'BETWEEN' ? `${c.left} between ${c.right} and ${c.right2}` : `${c.left} ${c.op} ${c.right}`;
}

/** Turn `30 > rsi` into `rsi < 30` so thresholds compare on one side. */
function flip(c: NormCondition): NormCondition {
  if (asNumber(c.left) === null || asNumber(c.right) !== null) return c;
  const mirror: Record<string, NormCondition['op']> = { '>': '<', '<': '>', '>=': '<=', '<=': '>=', '==': '==' };
  return mirror[c.op] ? { left: c.right, op: mirror[c.op], right: c.left } : c;
}

/** For a 0–100 oscillator compared with constant `b`: is the condition impossible or vacuous? */
function boundedVerdict(op: NormCondition['op'], b: number): 'never' | 'always' | null {
  switch (op) {
    case 'CROSSES_ABOVE':
    case 'CROSSES_BELOW':
      return b >= 100 || b <= 0 ? 'never' : null;
    case '>':
      return b >= 100 ? 'never' : b < 0 ? 'always' : null;
    case '>=':
      return b > 100 ? 'never' : b <= 0 ? 'always' : null;
    case '<':
      return b <= 0 ? 'never' : b > 100 ? 'always' : null;
    case '<=':
      return b < 0 ? 'never' : b >= 100 ? 'always' : null;
    case '==':
      return b < 0 || b > 100 ? 'never' : null;
    default:
      return null;
  }
}

function pushOnce(list: Finding[], f: Finding): void {
  if (!list.some((x) => x.text === f.text)) list.push(f);
}

function item(id: CheckId, findings: Finding[], passDetail?: string): CheckItem {
  const errors = findings.filter((f) => f.status === 'error').map((f) => f.text);
  const warns = findings.filter((f) => f.status === 'warn').map((f) => f.text);
  const status: CheckStatus = errors.length > 0 ? 'error' : warns.length > 0 ? 'warn' : 'pass';
  return { id, status, label: LABELS[id], details: status === 'pass' ? (passDetail ? [passDetail] : []) : [...errors, ...warns] };
}

// ── Checks ─────────────────────────────────────────────────────────────

function checkSchema(n: NormaliseResult): CheckItem {
  const d = n.definition;
  const f: Finding[] = [];
  if (!d.name) f.push({ status: 'error', text: 'Give the strategy a name.' });
  if (!d.timeframe) f.push({ status: 'error', text: 'Choose a timeframe.' });
  if (!(SEGMENTS as readonly string[]).includes(d.segment)) f.push({ status: 'error', text: 'Choose a segment (Options, Equity, Futures or Commodity).' });
  if (!d.instrument) f.push({ status: 'error', text: 'Set the instrument (e.g. NIFTY, RELIANCE, CRUDEOIL).' });
  for (const p of n.problems) f.push({ status: 'error', text: p.line ? `Line ${p.line}: ${p.message}` : p.message });
  if (n.problems.length === 0 && entryRules(d).length === 0) f.push({ status: 'error', text: 'Add at least one entry condition.' });
  const { sessionStart, sessionEnd } = d.settings;
  if (sessionStart && sessionEnd && sessionStart >= sessionEnd) f.push({ status: 'error', text: `Session start ${sessionStart} is not before session end ${sessionEnd}.` });
  for (const w of n.warnings) f.push({ status: 'warn', text: w.line ? `Line ${w.line}: ${w.message}` : w.message });
  return item('schema', f);
}

function checkInstrument(d: StrategyDefinition): CheckItem {
  const f: Finding[] = [];
  const sym = d.instrument;
  const isIndex = (INDEX_UNDERLYINGS as readonly string[]).includes(sym);
  const isMcx = (MCX_UNDERLYINGS as readonly string[]).includes(sym);
  if (!sym) {
    f.push({ status: 'error', text: 'No instrument set.' });
  } else if (!SYMBOL_PATTERN.test(sym)) {
    f.push({ status: 'error', text: `"${sym}" is not a valid NSE/BSE/MCX symbol.` });
  } else if (d.segment === 'COMMODITY' && !isMcx) {
    f.push({ status: 'error', text: `${sym} is not a supported MCX commodity (${MCX_UNDERLYINGS.slice(0, 6).join(', ')}, …).` });
  } else if (d.segment !== 'COMMODITY' && isMcx) {
    f.push({ status: 'error', text: `${sym} trades on MCX — set the segment to Commodity.` });
  } else if (d.segment === 'EQUITY' && isIndex) {
    f.push({ status: 'error', text: `${sym} is an index — it cannot be traded as equity. Use Options or Futures.` });
  } else if ((d.segment === 'OPTIONS' || d.segment === 'FUTURES') && !isIndex) {
    f.push({ status: 'warn', text: `${sym} is not an index — make sure it is in the NSE F&O list.` });
  }
  return item('instrument', f);
}

function checkInterval(d: StrategyDefinition): CheckItem {
  const f: Finding[] = [];
  if (!d.timeframe) f.push({ status: 'error', text: 'No timeframe set.' });
  else if (!(SUPPORTED_INTERVALS as readonly string[]).includes(d.timeframe)) {
    f.push({ status: 'error', text: `${d.timeframe} candles are not available from the data feed (supported: ${SUPPORTED_INTERVALS.join(', ')}).` });
  } else if (d.timeframe === '1m' || d.timeframe === '3m') {
    f.push({ status: 'warn', text: `${d.timeframe} bars mean many trades — brokerage and taxes often exceed the edge. Backtest net of fees.` });
  }
  return item('interval', f);
}

function checkContradictions(d: StrategyDefinition): CheckItem {
  const f: Finding[] = [];
  for (const side of ['long', 'short'] as const) {
    const en = d.entry[side];
    const ex = d.exit[side];
    if (en.length > 0 && ex.length > 0 && canonicalJson(en) === canonicalJson(ex)) {
      f.push({ status: 'error', text: `The ${side} entry and exit rules are identical — every entry would exit immediately.` });
    }
  }
  if (d.entry.long.length > 0 && canonicalJson(d.entry.long) === canonicalJson(d.entry.short)) {
    f.push({ status: 'error', text: 'Long and short entries are identical — the strategy would buy and sell on the same signal.' });
  }

  for (const rule of allRules(d)) {
    for (const raw of rule.conditions) {
      const c = flip(raw);
      if (c.left === c.right && asNumber(c.left) === null) {
        const what = c.op === 'CROSSES_ABOVE' || c.op === 'CROSSES_BELOW' ? 'crosses itself' : 'is compared with itself';
        pushOnce(f, { status: 'error', text: `"${describe(raw)}": ${c.left} ${what} — the condition can never change.` });
        continue;
      }
      const a = asNumber(c.left);
      const b = asNumber(c.right);
      if (a !== null && b !== null) {
        pushOnce(f, { status: 'error', text: `"${describe(raw)}" compares two constants — it is always true or always false.` });
        continue;
      }
      if (c.op === 'BETWEEN') {
        const lo = asNumber(c.right);
        const hi = asNumber(c.right2 ?? '');
        if (lo !== null && hi !== null && lo >= hi) pushOnce(f, { status: 'error', text: `"${describe(raw)}": the lower bound is not below the upper bound.` });
      }
      const type = seriesType(c.left, d);
      if (type && BOUNDED_0_100.has(type) && b !== null) {
        const verdict = boundedVerdict(c.op, b);
        if (verdict) {
          pushOnce(f, {
            status: 'error',
            text: `"${describe(raw)}": ${type} only ranges 0–100, so this is ${verdict === 'never' ? 'never true' : 'always true (it filters nothing)'}.`,
          });
        }
      }
    }

    // Within an AND group, the numeric bounds on one series must overlap.
    if (rule.logic === 'AND') {
      const bounds = new Map<string, { lo: number; loStrict: boolean; hi: number; hiStrict: boolean }>();
      for (const raw of rule.conditions) {
        const c = flip(raw);
        const v = asNumber(c.right);
        if (v === null || asNumber(c.left) !== null) continue;
        const b = bounds.get(c.left) ?? { lo: -Infinity, loStrict: false, hi: Infinity, hiStrict: false };
        if (c.op === '>' || c.op === '>=') {
          if (v > b.lo || (v === b.lo && c.op === '>')) Object.assign(b, { lo: v, loStrict: c.op === '>' });
        } else if (c.op === '<' || c.op === '<=') {
          if (v < b.hi || (v === b.hi && c.op === '<')) Object.assign(b, { hi: v, hiStrict: c.op === '<' });
        } else if (c.op === 'BETWEEN') {
          const v2 = asNumber(c.right2 ?? '');
          if (v2 !== null) {
            if (v > b.lo) Object.assign(b, { lo: v, loStrict: false });
            if (v2 < b.hi) Object.assign(b, { hi: v2, hiStrict: false });
          }
        }
        bounds.set(c.left, b);
      }
      for (const [series, b] of bounds) {
        if (b.lo > b.hi || (b.lo === b.hi && (b.loStrict || b.hiStrict))) {
          pushOnce(f, { status: 'error', text: `Conditions on ${series} are joined with AND but can never all be true at once.` });
        }
      }
    }
  }
  return item('contradictions', f);
}

function checkStopLoss(d: StrategyDefinition): CheckItem {
  const f: Finding[] = [];
  const s = d.stopLoss;
  const { stopLossKind, stopLossValue } = d.settings;
  if (!s) {
    const half = (stopLossKind && stopLossValue === null) || (!stopLossKind && stopLossValue !== null);
    f.push({
      status: 'error',
      text: half ? 'Set both the stop-loss unit and its value.' : 'No stop-loss — every strategy must define one (Risk & execution → Stop-loss).',
    });
  } else if (!(s.value > 0)) {
    f.push({ status: 'error', text: 'The stop-loss distance must be greater than zero.' });
  } else {
    if (s.kind === 'PERCENT' && s.value > 20) f.push({ status: 'warn', text: `A ${s.value}% stop is very wide — one loss could erase many wins.` });
    if (s.kind === 'ATR' && s.value > 6) f.push({ status: 'warn', text: `A ${s.value}× ATR stop is very wide.` });
    if (s.kind === 'ATR' && s.value < 0.3) f.push({ status: 'warn', text: `A ${s.value}× ATR stop sits inside normal noise and will be hit often.` });
    const t = d.target;
    if (t && t.kind === s.kind && t.value > 0 && t.value < s.value) {
      f.push({ status: 'warn', text: `Target (${t.value}) is smaller than the stop (${s.value}) — you need a win rate above ${Math.round((s.value / (s.value + t.value)) * 100)}% to break even before fees.` });
    }
  }
  return item('stop-loss', f, s ? `${s.value} ${s.kind === 'ATR' ? '× ATR' : s.kind === 'PERCENT' ? '%' : 'points'}` : undefined);
}

function checkExit(d: StrategyDefinition): CheckItem {
  const f: Finding[] = [];
  const hasRules = d.exit.long.length + d.exit.short.length > 0;
  const hasTarget = !!d.target && d.target.value > 0;
  const hasSquareOff = INTRADAY.has(d.timeframe) && !!d.settings.sessionEnd;
  if (!hasRules && !hasTarget && !hasSquareOff) {
    f.push({ status: 'error', text: 'No exit — add an exit rule, a target, or (intraday) a session end time. A stop alone only closes losers.' });
  } else {
    if (d.entry.short.length > 0 && d.exit.short.length === 0 && !hasTarget && !hasSquareOff) {
      f.push({ status: 'error', text: 'Short entries have no exit rule or target.' });
    }
    if (d.entry.long.length > 0 && d.exit.long.length === 0 && !hasTarget && !hasSquareOff) {
      f.push({ status: 'error', text: 'Long entries have no exit rule or target.' });
    }
  }
  return item('exit', f);
}

function checkSizing(d: StrategyDefinition, limits: RiskLimitsView | null): CheckItem {
  const f: Finding[] = [];
  const s = d.settings;
  const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;
  if (s.riskPerTradeRupees === null && s.capitalPerTradeRupees === null) {
    f.push({ status: 'warn', text: 'No position sizing set — orders will be sized from your Risk Wall limits.' });
  }
  if (s.riskPerTradeRupees !== null && s.riskPerTradeRupees <= 0) f.push({ status: 'error', text: 'Risk per trade must be positive.' });
  if (s.capitalPerTradeRupees !== null && s.capitalPerTradeRupees <= 0) f.push({ status: 'error', text: 'Capital per trade must be positive.' });
  if (s.maxOpenPositions !== null && (s.maxOpenPositions < 1 || !Number.isInteger(s.maxOpenPositions))) f.push({ status: 'error', text: 'Max open positions must be a whole number ≥ 1.' });
  if (s.maxTradesPerDay !== null && (s.maxTradesPerDay < 1 || !Number.isInteger(s.maxTradesPerDay))) f.push({ status: 'error', text: 'Max trades per day must be a whole number ≥ 1.' });
  if (s.riskPerTradeRupees !== null && s.capitalPerTradeRupees !== null && s.riskPerTradeRupees > s.capitalPerTradeRupees && d.segment === 'OPTIONS') {
    f.push({ status: 'warn', text: 'Risk per trade exceeds the premium deployed — a bought option cannot lose more than its premium.' });
  }
  if (!limits) {
    f.push({ status: 'warn', text: 'Could not load your risk limits — sizing was not compared against them.' });
  } else {
    if (s.riskPerTradeRupees !== null && limits.maxRiskPerTrade !== null && s.riskPerTradeRupees > limits.maxRiskPerTrade) {
      f.push({ status: 'error', text: `Risk per trade ${rupees(s.riskPerTradeRupees)} is above your limit of ${rupees(limits.maxRiskPerTrade)}.` });
    }
    const capCap = d.segment === 'OPTIONS' ? limits.optionsMaxPremiumPerTrade : limits.maxCapitalDeployed;
    if (s.capitalPerTradeRupees !== null && capCap !== null && s.capitalPerTradeRupees > capCap) {
      const what = d.segment === 'OPTIONS' ? 'max premium per trade' : 'max capital deployed';
      f.push({ status: 'error', text: `Capital per trade ${rupees(s.capitalPerTradeRupees)} is above your ${what} of ${rupees(capCap)}.` });
    }
    if (s.maxOpenPositions !== null && limits.maxOpenPositions !== null && s.maxOpenPositions > limits.maxOpenPositions) {
      f.push({ status: 'error', text: `Max open positions ${s.maxOpenPositions} is above your limit of ${limits.maxOpenPositions}.` });
    }
    if (s.maxTradesPerDay !== null && limits.maxTradesPerDay !== null && s.maxTradesPerDay > limits.maxTradesPerDay) {
      f.push({ status: 'error', text: `Max trades per day ${s.maxTradesPerDay} is above your limit of ${limits.maxTradesPerDay}.` });
    }
  }
  return item('sizing', f);
}

function checkLookAhead(d: StrategyDefinition): CheckItem {
  const f: Finding[] = [];
  const usesBarData = entryRules(d).some((r) => r.conditions.some((c) => asNumber(c.left) === null || asNumber(c.right) === null));
  if (d.settings.fillAt === 'same_bar_open' && usesBarData) {
    f.push({
      status: 'error',
      text: "Entries fill at the signal bar's OPEN, but the signal uses that bar's close / indicators — values not known until the bar ends. Fill at the next bar's open instead.",
    });
  }
  const usesVwap = d.indicators.some((i) => i.type === 'VWAP') || allRules(d).some((r) => r.conditions.some((c) => /vwap/i.test(c.left) || /vwap/i.test(c.right)));
  if (usesVwap && !INTRADAY.has(d.timeframe) && d.timeframe) {
    f.push({ status: 'warn', text: 'VWAP resets every session — on daily bars it is just the day\'s average price and behaves differently in backtests.' });
  }
  const passDetail = d.settings.fillAt === 'signal_close' ? "Fills at the signal bar's close." : "Fills at the next bar's open.";
  return item('look-ahead', f, passDetail);
}

/** Tunable numbers: indicator params, numeric thresholds, multipliers, stop and target. */
export function countParameters(d: StrategyDefinition): number {
  let n = d.indicators.reduce((acc, i) => acc + i.params.length, 0);
  for (const r of allRules(d)) {
    for (const c of r.conditions) {
      for (const o of [c.left, c.right, c.right2 ?? '']) {
        if (asNumber(o) !== null) n++;
        else if (/[*+\-/]\d/.test(o)) n++;
        const call = o.match(/\(([^)]*)\)/);
        if (call && !d.indicators.some((i) => i.ref === o)) n += call[1].split(',').filter((a) => asNumber(a.trim()) !== null).length;
      }
    }
  }
  if (d.stopLoss) n++;
  if (d.target) n++;
  return n;
}

function checkOverfitting(d: StrategyDefinition): CheckItem {
  const f: Finding[] = [];
  const params = countParameters(d);
  // Rough trade counts a year of history yields: daily bars give tens of trades, intraday hundreds.
  const ceiling = d.timeframe === '1d' ? 6 : d.timeframe === '1h' ? 8 : 10;
  if (params > ceiling) {
    f.push({ status: 'warn', text: `${params} tunable parameters for ${d.timeframe || 'this'} bars (rule of thumb ≤ ${ceiling}) — easy to curve-fit. Validate on data you did not tune on.` });
  }
  for (const r of entryRules(d)) {
    if (r.logic === 'AND' && r.conditions.length > 5) {
      pushOnce(f, { status: 'warn', text: `An entry needs ${r.conditions.length} conditions at once — signals will be rare and the sample small.` });
    }
  }
  return item('overfitting', f, `${params} tunable parameters`);
}

// ── Entry point ────────────────────────────────────────────────────────

export function runChecks(n: NormaliseResult, limits: RiskLimitsView | null): CheckReport {
  const d = n.definition;
  const items = [
    checkSchema(n),
    checkInstrument(d),
    checkInterval(d),
    checkContradictions(d),
    checkStopLoss(d),
    checkExit(d),
    checkSizing(d, limits),
    checkLookAhead(d),
    checkOverfitting(d),
  ];
  return {
    items,
    errors: items.filter((i) => i.status === 'error').length,
    warnings: items.filter((i) => i.status === 'warn').length,
  };
}
