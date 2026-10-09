import { formatBlockErrors, validateBlocks } from './validate-blocks';
import { adaptiveBlocks, plainBlocks } from '../testing/block-fixtures';

const paths = (raw: unknown, opts?: { allowedVehicles?: readonly string[] }) =>
  validateBlocks(raw, opts).map((e) => e.path);

describe('validateBlocks', () => {
  it('accepts both reference shapes', () => {
    expect(validateBlocks(adaptiveBlocks())).toEqual([]);
    expect(validateBlocks(plainBlocks())).toEqual([]);
  });

  it('rejects anything that is not an object', () => {
    for (const raw of [null, undefined, 'blocks', 42, []]) expect(paths(raw)).toEqual(['blocks']);
  });

  it('names every missing block', () => {
    const { stop: _s, sizing: _z, ...rest } = plainBlocks();
    expect(paths(rest)).toEqual(['stop', 'sizing']);
  });

  it('rejects unknown top-level and in-block fields (an AI draft cannot smuggle rules in)', () => {
    expect(paths({ ...plainBlocks(), leverage: 5 })).toEqual(['blocks.leverage']);
    expect(paths({ ...plainBlocks(), stop: { kind: 'fixedPct', pct: 1, graceMs: 120000 } })).toEqual(['stop.graceMs']);
  });

  it('rejects strings, NaN, Infinity, zero, negatives and 100 % where a percent is needed', () => {
    for (const bad of ['1.5', NaN, Infinity, 0, -1, 100, null]) {
      expect(paths({ ...plainBlocks(), stop: { kind: 'fixedPct', pct: bad } })).toEqual(['stop.pct']);
    }
  });

  it('rejects an unknown kind', () => {
    expect(paths({ ...plainBlocks(), target: { kind: 'trailing', pct: 2 } })).toEqual(['target.kind']);
  });

  it('needs whole numbers where a count is meant', () => {
    const a = adaptiveBlocks();
    expect(paths({ ...a, stop: { ...a.stop, period: 14.5 } })).toEqual(['stop.period']);
    const mtf = { ...plainBlocks(), vehicle: { kind: 'MTF' } };
    expect(paths({ ...mtf, timeExit: { kind: 'holdDays', n: 0 } })).toEqual(['timeExit.n']);
    expect(paths({ ...mtf, timeExit: { kind: 'holdDays', n: 2.5 } })).toEqual(['timeExit.n']);
    expect(paths({ ...mtf, timeExit: { kind: 'holdDays', n: 5 } })).toEqual([]);
  });

  it('rejects an ATR clamp whose minimum exceeds its maximum', () => {
    const a = adaptiveBlocks();
    expect(paths({ ...a, stop: { ...a.stop, minPct: 3 } })).toEqual(['stop.minPct']);
    expect(paths({ ...a, trail: { ...a.trail, minPct: 2 } })).toEqual(['trail.minPct']);
  });

  it('checks the HH:MM clock format', () => {
    for (const bad of ['9:15', '24:00', '15:60', '1515', 1515]) {
      expect(paths({ ...plainBlocks(), timeExit: { kind: 'clock', hhmm: bad } })).toEqual(['timeExit.hhmm']);
    }
  });

  it('chartink: ANY needs a null scanName; EXACT and CONTAINS need a name', () => {
    const e = { kind: 'chartink', minScore: null };
    expect(paths({ ...plainBlocks(), entry: { ...e, scanName: 'hull', match: 'ANY', side: 'BUY' } })).toEqual(['entry.scanName']);
    expect(paths({ ...plainBlocks(), entry: { ...e, scanName: null, match: 'EXACT', side: 'BUY' } })).toEqual(['entry.scanName']);
    expect(paths({ ...plainBlocks(), entry: { ...e, scanName: 'x', match: 'REGEX', side: 'BUY' } })).toEqual(['entry.match']);
    expect(paths({ ...plainBlocks(), entry: { ...e, scanName: 'x', match: 'EXACT' } })).toEqual(['entry.side']);
  });

  it('chartink minScore: required (null = no score gate); a base with well-formed IST windows', () => {
    const { minScore: _m, ...noScore } = adaptiveBlocks().entry as Record<string, unknown>;
    expect(paths({ ...adaptiveBlocks(), entry: noScore })).toEqual(['entry.minScore']);
    const withScore = (minScore: unknown) => ({ ...adaptiveBlocks(), entry: { ...adaptiveBlocks().entry, minScore } });
    expect(paths(withScore({ base: 47, windows: [] }))).toEqual([]);
    expect(paths(withScore({ base: -1, windows: [] }))).toEqual(['entry.minScore.base']);
    expect(paths(withScore({ base: 47 }))).toEqual(['entry.minScore.windows']);
    expect(paths(withScore({ base: 47, windows: [{ fromHhmm: '14:00', toHhmm: '11:45', score: 75 }] }))).toEqual(['entry.minScore.windows.0.toHhmm']);
    expect(paths(withScore({ base: 47, windows: [{ fromHhmm: '11:45', toHhmm: '14:00', score: '75' }] }))).toEqual(['entry.minScore.windows.0.score']);
  });

  it('filters must name every rule (null, or [] for gates, means none)', () => {
    expect(paths({ ...plainBlocks(), filters: {} })).toEqual(['filters.staleEntry', 'filters.cooldown', 'filters.lastLoss', 'filters.gates']);
    expect(paths({ ...plainBlocks(), filters: { staleEntry: null, cooldown: null, lastLoss: null, gates: [] } })).toEqual([]);
  });

  it('filters: each rule is well-formed; gates are evaluator references with scalar params', () => {
    const f = plainBlocks().filters;
    expect(paths({ ...plainBlocks(), filters: { ...f, staleEntry: { maxMovePct: 0 } } })).toEqual(['filters.staleEntry.maxMovePct']);
    expect(paths({ ...plainBlocks(), filters: { ...f, cooldown: { minutes: 44.5 } } })).toEqual(['filters.cooldown.minutes']);
    expect(paths({ ...plainBlocks(), filters: { ...f, lastLoss: { window: 'EVER' } } })).toEqual(['filters.lastLoss.window']);
    expect(paths({ ...plainBlocks(), filters: { ...f, gates: {} } })).toEqual(['filters.gates']);
    expect(paths({ ...plainBlocks(), filters: { ...f, gates: [{ kind: 'evaluator', evaluatorKey: 'Decision Gate', params: { x: [1] } }] } }))
      .toEqual(['filters.gates.0.evaluatorKey', 'filters.gates.0.params.x']);
    expect(paths({ ...plainBlocks(), filters: { ...f, gates: [{ kind: 'llm', evaluatorKey: 'judge', params: {} }] } })).toEqual(['filters.gates.0.kind']);
    expect(paths({ ...plainBlocks(), filters: { ...f, maxTradesPerDay: 3 } })).toEqual(['filters.maxTradesPerDay']);
  });

  it('evaluator: a kebab-case key and scalar params only', () => {
    const entry = { kind: 'evaluator', evaluatorKey: 'zone-reversal', params: { lookback: 20, mode: 'fast', strict: true }, side: 'BUY' };
    expect(paths({ ...plainBlocks(), entry })).toEqual([]);
    expect(paths({ ...plainBlocks(), entry: { ...entry, params: { x: { nested: 1 } } } })).toEqual(['entry.params.x']);
    expect(paths({ ...plainBlocks(), entry: { ...entry, params: [] } })).toEqual(['entry.params']);
    expect(paths({ ...plainBlocks(), entry: { ...entry, evaluatorKey: 'Zone Reversal' } })).toEqual(['entry.evaluatorKey']);
  });

  it('CASH_INTRADAY needs a clock exit (an intraday position never holds overnight)', () => {
    expect(paths({ ...plainBlocks(), timeExit: { kind: 'holdDays', n: 2 } })).toEqual(['timeExit']);
  });

  it('MTF and OPTIONS_BUY are buy-only', () => {
    const mtf = { ...plainBlocks(), vehicle: { kind: 'MTF' }, timeExit: { kind: 'holdDays', n: 5 } };
    expect(paths({ ...mtf, entry: { ...plainBlocks().entry, side: 'BOTH' } })).toEqual(['entry.side']);
  });

  it('an ATR trail needs an ATR stop; a trail that starts after the partial needs a partial', () => {
    const atrTrail = { kind: 'atr', multiple: 1, minPct: 0.6, maxPct: 1.5, startsAfter: 'ENTRY' };
    expect(paths({ ...plainBlocks(), trail: atrTrail })).toEqual(['trail']);
    expect(paths({ ...adaptiveBlocks(), partial: { kind: 'none' } })).toEqual(['trail.startsAfter']);
  });

  it('the partial level must sit below a fixed target, and its fraction strictly between 0 and 1', () => {
    const a = adaptiveBlocks();
    expect(paths({ ...a, partial: { kind: 'atTarget1', fraction: 0.5, atPct: 2 } })).toEqual(['partial.atPct']);
    expect(paths({ ...a, partial: { kind: 'atTarget1', fraction: 1, atPct: 1 } })).toEqual(['partial.fraction']);
  });

  it('accepts a complete OPTIONS_BUY vehicle and reports its bad fields by path', () => {
    const vehicle = {
      kind: 'OPTIONS_BUY', strike: 'OTM2', minDaysToExpiry: 2, premiumStopPct: 30,
      thetaStop: { minMovePct: 10, withinMinutes: 20 }, expiryDayExitHhmm: '14:30',
    };
    expect(paths({ ...plainBlocks(), vehicle })).toEqual([]);
    expect(paths({ ...plainBlocks(), vehicle: { ...vehicle, strike: 'OTM' } })).toEqual(['vehicle.strike']);
    expect(paths({ ...plainBlocks(), vehicle: { ...vehicle, thetaStop: { minMovePct: 10 } } })).toEqual(['vehicle.thetaStop.withinMinutes']);
  });

  it('refuses a vehicle the strategy does not allow', () => {
    expect(paths(plainBlocks(), { allowedVehicles: ['MTF'] })).toEqual(['vehicle.kind']);
    expect(paths(plainBlocks(), { allowedVehicles: ['CASH_INTRADAY'] })).toEqual([]);
  });

  it('a sizing amount must be a positive number of rupees', () => {
    expect(paths({ ...plainBlocks(), sizing: { kind: 'riskRupees', amount: 0 } })).toEqual(['sizing.amount']);
  });
});

describe('formatBlockErrors', () => {
  it('joins path and message', () => {
    expect(formatBlockErrors([{ path: 'stop.pct', message: 'must be greater than 0' }, { path: 'sizing', message: 'is required' }]))
      .toBe('stop.pct: must be greater than 0; sizing: is required');
  });
});
