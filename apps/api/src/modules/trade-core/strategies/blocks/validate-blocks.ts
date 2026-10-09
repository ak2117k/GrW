import { BLOCK_NAMES, CANDLE_TIMEFRAMES, VEHICLES, type BlockError, type EntrySide } from './block-types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const STRIKE = /^(ATM|ITM[1-9]\d?|OTM[1-9]\d?)$/;
const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

interface NumRule { gt?: number; gte?: number; lt?: number; integer?: boolean }
/** A percent of price: strictly between 0 and 100. A shape bound, not a risk limit. */
const PCT: NumRule = { gt: 0, lt: 100 };
/** A Chartink score: a finite number, 0 or more. */
const SCORE: NumRule = { gte: 0 };
const HHMM_STR = { maxLength: 5, pattern: HHMM, hint: 'HH:MM (IST, 24-hour)' };
const KEBAB_STR = { maxLength: 100, pattern: KEBAB, hint: 'a kebab-case key' };

class Collector {
  readonly errors: BlockError[] = [];

  add(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  obj(v: unknown, path: string): Obj | undefined {
    if (!isObj(v)) {
      this.add(path, 'must be an object');
      return undefined;
    }
    return v;
  }

  onlyKeys(o: Obj, path: string, allowed: readonly string[]): void {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) this.add(`${path}.${k}`, 'is not a field of this block');
  }

  num(o: Obj, key: string, path: string, rule: NumRule): number | undefined {
    const v = o[key];
    const p = `${path}.${key}`;
    if (typeof v !== 'number' || !Number.isFinite(v)) return this.fail(p, 'must be a finite number');
    if (rule.integer && !Number.isInteger(v)) return this.fail(p, 'must be a whole number');
    if (rule.gt !== undefined && !(v > rule.gt)) return this.fail(p, `must be greater than ${rule.gt}`);
    if (rule.gte !== undefined && !(v >= rule.gte)) return this.fail(p, `must be at least ${rule.gte}`);
    if (rule.lt !== undefined && !(v < rule.lt)) return this.fail(p, `must be less than ${rule.lt}`);
    return v;
  }

  oneOf<T extends string>(o: Obj, key: string, path: string, values: readonly T[]): T | undefined {
    const v = o[key];
    if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
      return this.fail(`${path}.${key}`, `must be one of ${values.join(', ')}`);
    }
    return v as T;
  }

  str(o: Obj, key: string, path: string, opts: { maxLength: number; pattern?: RegExp; hint?: string }): string | undefined {
    const v = o[key];
    const p = `${path}.${key}`;
    if (typeof v !== 'string' || v.trim() === '') return this.fail(p, 'must be a non-empty string');
    if (v.length > opts.maxLength) return this.fail(p, `must be at most ${opts.maxLength} characters`);
    if (opts.pattern && !opts.pattern.test(v)) return this.fail(p, `must look like ${opts.hint}`);
    return v;
  }

  private fail(path: string, message: string): undefined {
    this.add(path, message);
    return undefined;
  }
}

/** Evaluator params: an object of scalars only. */
function checkParams(c: Collector, v: unknown, path: string): void {
  if (!isObj(v)) {
    c.add(path, 'must be an object');
    return;
  }
  for (const [k, pv] of Object.entries(v)) {
    const scalar = typeof pv === 'boolean' || typeof pv === 'string' || (typeof pv === 'number' && Number.isFinite(pv));
    if (!scalar) c.add(`${path}.${k}`, 'must be a number, string or boolean');
  }
}

function checkMinScore(c: Collector, v: unknown): void {
  if (v === null) return;
  const path = 'entry.minScore';
  const o = c.obj(v, path);
  if (!o) return;
  c.onlyKeys(o, path, ['base', 'windows']);
  c.num(o, 'base', path, SCORE);
  if (!Array.isArray(o.windows)) {
    c.add(`${path}.windows`, 'must be a list');
    return;
  }
  o.windows.forEach((w: unknown, i: number) => {
    const p = `${path}.windows.${i}`;
    const wo = c.obj(w, p);
    if (!wo) return;
    c.onlyKeys(wo, p, ['fromHhmm', 'toHhmm', 'score']);
    const from = c.str(wo, 'fromHhmm', p, HHMM_STR);
    const to = c.str(wo, 'toHhmm', p, HHMM_STR);
    c.num(wo, 'score', p, SCORE);
    if (from !== undefined && to !== undefined && from >= to) c.add(`${p}.toHhmm`, 'must be after fromHhmm');
  });
}

function checkEntry(c: Collector, v: unknown): { side?: EntrySide } {
  const o = c.obj(v, 'entry');
  if (!o) return {};
  const kind = c.oneOf(o, 'kind', 'entry', ['chartink', 'evaluator'] as const);
  if (kind === 'chartink') {
    c.onlyKeys(o, 'entry', ['kind', 'scanName', 'match', 'side', 'minScore']);
    const match = c.oneOf(o, 'match', 'entry', ['ANY', 'EXACT', 'CONTAINS'] as const);
    if (match === 'ANY') {
      if (o.scanName !== null) c.add('entry.scanName', 'must be null when match is ANY');
    } else if (match) {
      c.str(o, 'scanName', 'entry', { maxLength: 200 });
    }
    if (o.minScore === undefined) c.add('entry.minScore', 'is required (null for no score gate)');
    else checkMinScore(c, o.minScore);
  } else if (kind === 'evaluator') {
    c.onlyKeys(o, 'entry', ['kind', 'evaluatorKey', 'params', 'side']);
    c.str(o, 'evaluatorKey', 'entry', KEBAB_STR);
    checkParams(c, o.params, 'entry.params');
  }
  const side = c.oneOf(o, 'side', 'entry', ['BUY', 'SELL', 'BOTH'] as const);
  return { side };
}

const FILTER_RULES = ['staleEntry', 'cooldown', 'lastLoss', 'gates'] as const;

function checkFilters(c: Collector, v: unknown): void {
  const o = c.obj(v, 'filters');
  if (!o) return;
  c.onlyKeys(o, 'filters', FILTER_RULES);
  for (const k of FILTER_RULES) if (!(k in o)) c.add(`filters.${k}`, 'is required (null, or [] for gates, means none)');

  if (o.staleEntry != null) {
    const s = c.obj(o.staleEntry, 'filters.staleEntry');
    if (s) {
      c.onlyKeys(s, 'filters.staleEntry', ['maxMovePct']);
      c.num(s, 'maxMovePct', 'filters.staleEntry', PCT);
    }
  }
  if (o.cooldown != null) {
    const s = c.obj(o.cooldown, 'filters.cooldown');
    if (s) {
      c.onlyKeys(s, 'filters.cooldown', ['minutes']);
      c.num(s, 'minutes', 'filters.cooldown', { gte: 1, integer: true });
    }
  }
  if (o.lastLoss != null) {
    const s = c.obj(o.lastLoss, 'filters.lastLoss');
    if (s) {
      c.onlyKeys(s, 'filters.lastLoss', ['window']);
      c.oneOf(s, 'window', 'filters.lastLoss', ['SAME_IST_DAY'] as const);
    }
  }
  if ('gates' in o) {
    if (!Array.isArray(o.gates)) {
      c.add('filters.gates', 'must be a list');
      return;
    }
    o.gates.forEach((g: unknown, i: number) => {
      const p = `filters.gates.${i}`;
      const go = c.obj(g, p);
      if (!go) return;
      c.onlyKeys(go, p, ['kind', 'evaluatorKey', 'params']);
      c.oneOf(go, 'kind', p, ['evaluator'] as const);
      c.str(go, 'evaluatorKey', p, KEBAB_STR);
      checkParams(c, go.params, `${p}.params`);
    });
  }
}

function checkStop(c: Collector, v: unknown): 'fixedPct' | 'atr' | undefined {
  const o = c.obj(v, 'stop');
  if (!o) return undefined;
  const kind = c.oneOf(o, 'kind', 'stop', ['fixedPct', 'atr'] as const);
  if (kind === 'fixedPct') {
    c.onlyKeys(o, 'stop', ['kind', 'pct']);
    c.num(o, 'pct', 'stop', PCT);
  } else if (kind === 'atr') {
    c.onlyKeys(o, 'stop', ['kind', 'period', 'timeframe', 'multiple', 'minPct', 'maxPct']);
    c.num(o, 'period', 'stop', { gte: 1, integer: true });
    c.oneOf(o, 'timeframe', 'stop', CANDLE_TIMEFRAMES);
    c.num(o, 'multiple', 'stop', { gt: 0 });
    const min = c.num(o, 'minPct', 'stop', PCT);
    const max = c.num(o, 'maxPct', 'stop', PCT);
    if (min !== undefined && max !== undefined && min > max) c.add('stop.minPct', 'must not exceed stop.maxPct');
  }
  return kind;
}

function checkTarget(c: Collector, v: unknown): { kind?: 'fixedPct' | 'rr'; pct?: number } {
  const o = c.obj(v, 'target');
  if (!o) return {};
  const kind = c.oneOf(o, 'kind', 'target', ['fixedPct', 'rr'] as const);
  if (kind === 'fixedPct') {
    c.onlyKeys(o, 'target', ['kind', 'pct']);
    return { kind, pct: c.num(o, 'pct', 'target', PCT) };
  }
  if (kind === 'rr') {
    c.onlyKeys(o, 'target', ['kind', 'ratio']);
    c.num(o, 'ratio', 'target', { gt: 0 });
  }
  return { kind };
}

function checkTrail(c: Collector, v: unknown): { kind?: 'none' | 'breakeven' | 'atr'; startsAfter?: 'ENTRY' | 'PARTIAL' } {
  const o = c.obj(v, 'trail');
  if (!o) return {};
  const kind = c.oneOf(o, 'kind', 'trail', ['none', 'breakeven', 'atr'] as const);
  if (kind === 'none') c.onlyKeys(o, 'trail', ['kind']);
  if (kind === 'breakeven') {
    c.onlyKeys(o, 'trail', ['kind', 'atPct']);
    c.num(o, 'atPct', 'trail', PCT);
  }
  if (kind === 'atr') {
    c.onlyKeys(o, 'trail', ['kind', 'multiple', 'minPct', 'maxPct', 'startsAfter']);
    c.num(o, 'multiple', 'trail', { gt: 0 });
    const min = c.num(o, 'minPct', 'trail', PCT);
    const max = c.num(o, 'maxPct', 'trail', PCT);
    if (min !== undefined && max !== undefined && min > max) c.add('trail.minPct', 'must not exceed trail.maxPct');
    return { kind, startsAfter: c.oneOf(o, 'startsAfter', 'trail', ['ENTRY', 'PARTIAL'] as const) };
  }
  return { kind };
}

function checkTimeExit(c: Collector, v: unknown): 'clock' | 'holdDays' | undefined {
  const o = c.obj(v, 'timeExit');
  if (!o) return undefined;
  const kind = c.oneOf(o, 'kind', 'timeExit', ['clock', 'holdDays'] as const);
  if (kind === 'clock') {
    c.onlyKeys(o, 'timeExit', ['kind', 'hhmm']);
    c.str(o, 'hhmm', 'timeExit', HHMM_STR);
  }
  if (kind === 'holdDays') {
    c.onlyKeys(o, 'timeExit', ['kind', 'n']);
    c.num(o, 'n', 'timeExit', { gte: 1, integer: true });
  }
  return kind;
}

function checkPartial(c: Collector, v: unknown): { kind?: 'none' | 'atTarget1'; atPct?: number } {
  const o = c.obj(v, 'partial');
  if (!o) return {};
  const kind = c.oneOf(o, 'kind', 'partial', ['none', 'atTarget1'] as const);
  if (kind === 'none') c.onlyKeys(o, 'partial', ['kind']);
  if (kind === 'atTarget1') {
    c.onlyKeys(o, 'partial', ['kind', 'fraction', 'atPct']);
    c.num(o, 'fraction', 'partial', { gt: 0, lt: 1 });
    return { kind, atPct: c.num(o, 'atPct', 'partial', PCT) };
  }
  return { kind };
}

function checkSizing(c: Collector, v: unknown): void {
  const o = c.obj(v, 'sizing');
  if (!o) return;
  const kind = c.oneOf(o, 'kind', 'sizing', ['riskRupees', 'notionalRupees'] as const);
  if (kind) {
    c.onlyKeys(o, 'sizing', ['kind', 'amount']);
    c.num(o, 'amount', 'sizing', { gt: 0 });
  }
}

function checkVehicle(c: Collector, v: unknown): (typeof VEHICLES)[number] | undefined {
  const o = c.obj(v, 'vehicle');
  if (!o) return undefined;
  const kind = c.oneOf(o, 'kind', 'vehicle', VEHICLES);
  if (kind === 'CASH_INTRADAY' || kind === 'MTF') c.onlyKeys(o, 'vehicle', ['kind']);
  if (kind === 'OPTIONS_BUY') {
    c.onlyKeys(o, 'vehicle', ['kind', 'strike', 'minDaysToExpiry', 'premiumStopPct', 'thetaStop', 'expiryDayExitHhmm']);
    c.str(o, 'strike', 'vehicle', { maxLength: 5, pattern: STRIKE, hint: 'ATM, ITMn or OTMn' });
    c.num(o, 'minDaysToExpiry', 'vehicle', { gte: 0, integer: true });
    c.num(o, 'premiumStopPct', 'vehicle', PCT);
    const theta = c.obj(o.thetaStop, 'vehicle.thetaStop');
    if (theta) {
      c.onlyKeys(theta, 'vehicle.thetaStop', ['minMovePct', 'withinMinutes']);
      c.num(theta, 'minMovePct', 'vehicle.thetaStop', PCT);
      c.num(theta, 'withinMinutes', 'vehicle.thetaStop', { gte: 1, integer: true });
    }
    c.str(o, 'expiryDayExitHhmm', 'vehicle', HHMM_STR);
  }
  return kind;
}

/**
 * Every problem with a candidate `blocks` value, each with a path. `[]` means
 * valid. Pure: no I/O, no clock. Used on save, on approval and (M6) on AI drafts.
 */
export function validateBlocks(raw: unknown, opts: { allowedVehicles?: readonly string[] } = {}): BlockError[] {
  const c = new Collector();
  const top = c.obj(raw, 'blocks');
  if (!top) return c.errors;
  c.onlyKeys(top, 'blocks', BLOCK_NAMES);
  for (const name of BLOCK_NAMES) if (!(name in top)) c.add(name, 'is required');

  const entry = 'entry' in top ? checkEntry(c, top.entry) : {};
  if ('filters' in top) checkFilters(c, top.filters);
  const stop = 'stop' in top ? checkStop(c, top.stop) : undefined;
  const target = 'target' in top ? checkTarget(c, top.target) : {};
  const trail = 'trail' in top ? checkTrail(c, top.trail) : {};
  const timeExit = 'timeExit' in top ? checkTimeExit(c, top.timeExit) : undefined;
  const partial = 'partial' in top ? checkPartial(c, top.partial) : {};
  if ('sizing' in top) checkSizing(c, top.sizing);
  const vehicle = 'vehicle' in top ? checkVehicle(c, top.vehicle) : undefined;

  // Cross-block rules.
  if (vehicle === 'CASH_INTRADAY' && timeExit === 'holdDays') {
    c.add('timeExit', 'CASH_INTRADAY needs a clock exit (an intraday position never holds overnight)');
  }
  if ((vehicle === 'MTF' || vehicle === 'OPTIONS_BUY') && entry.side !== undefined && entry.side !== 'BUY') {
    c.add('entry.side', `${vehicle} is buy-only`);
  }
  if (trail.kind === 'atr' && stop !== undefined && stop !== 'atr') {
    c.add('trail', 'an ATR trail needs an ATR stop (it reuses the ATR measured at entry)');
  }
  if (trail.startsAfter === 'PARTIAL' && partial.kind !== undefined && partial.kind !== 'atTarget1') {
    c.add('trail.startsAfter', 'PARTIAL needs a partial block of kind atTarget1');
  }
  if (partial.atPct !== undefined && target.kind === 'fixedPct' && target.pct !== undefined && partial.atPct >= target.pct) {
    c.add('partial.atPct', 'must be below target.pct');
  }
  if (opts.allowedVehicles && vehicle && !opts.allowedVehicles.includes(vehicle)) {
    c.add('vehicle.kind', `this strategy allows only ${opts.allowedVehicles.join(', ')}`);
  }
  return c.errors;
}

export function formatBlockErrors(errors: readonly BlockError[]): string {
  return errors.map((e) => `${e.path}: ${e.message}`).join('; ');
}
