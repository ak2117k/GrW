import { parseAgrees, RuleParse } from './parse-compare';
import { ReaderCall } from './reading.types';

const ai: ReaderCall = {
  underlying: 'NIFTY',
  side: 'BUY',
  optionType: 'CE',
  strike: 26000,
  entryLow: 120,
  entryHigh: 125,
  stopLoss: 100,
  targets: [150, 180],
};
const rule = (over: Partial<RuleParse> = {}): RuleParse => ({ ...ai, ...over });

describe('parseAgrees', () => {
  it('agrees on the same call with SL 0.3% apart', () => {
    expect(parseAgrees(ai, rule({ stopLoss: 100.3 }))).toEqual({ agrees: true, diffs: [] });
  });

  it('differs on strike', () => {
    expect(parseAgrees(ai, rule({ strike: 26100 }))).toEqual({ agrees: false, diffs: ['strike'] });
  });

  it('null SL vs 245 is a diff', () => {
    const r = parseAgrees({ ...ai, stopLoss: null }, rule({ stopLoss: 245 }));
    expect(r).toEqual({ agrees: false, diffs: ['stopLoss'] });
  });

  it('agrees when both sides leave SL and targets empty', () => {
    const call = { ...ai, stopLoss: null, targets: [] };
    expect(parseAgrees(call, rule({ stopLoss: null, targets: [] }))).toEqual({ agrees: true, diffs: [] });
  });

  it('differs on a price more than 0.5% apart and compares only the first target', () => {
    const r = parseAgrees(ai, rule({ entryHigh: 126, targets: [150, 999] }));
    expect(r).toEqual({ agrees: false, diffs: ['entryHigh'] });
  });

  it('differs on underlying, side and option type', () => {
    const r = parseAgrees(ai, rule({ underlying: 'BANKNIFTY', side: 'SELL', optionType: 'PE' }));
    expect(r.diffs).toEqual(['underlying', 'side', 'optionType']);
  });
});
