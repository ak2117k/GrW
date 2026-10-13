import { adaptiveBlocks, plainBlocks } from '../strategies/testing/block-fixtures';
import { optionBlocks } from '../lifecycle/testing/lifecycle-fixtures';
import {
  cooldownActive, intentIdFor, istMinutes, lastLossVerdict, matchEntry, minScoreAt, scanMatches, setupGroupKey,
  sizeQty, staleEntryFails, staleMovePct, stopPriceFor,
} from './entry-rules';
import { hit, ist } from './testing/intake-fixtures';

const D = '2026-10-13';

describe('entry match (spec §4.1 entry.chartink; M1 minScore semantics)', () => {
  it('IST minutes of the day', () => {
    expect(istMinutes(ist(D, '11:45'))).toBe(705);
    expect(istMinutes(ist(D, '00:00'))).toBe(0);
  });

  it("minScore: a window's score replaces base inside [from, to); base outside; null means no gate", () => {
    const entry = adaptiveBlocks().entry;
    const m = entry.kind === 'chartink' ? entry.minScore : null;
    expect(minScoreAt(m, ist(D, '10:30'))).toBe(47);
    expect(minScoreAt(m, ist(D, '11:45'))).toBe(75);
    expect(minScoreAt(m, ist(D, '13:59'))).toBe(75);
    expect(minScoreAt(m, ist(D, '14:00'))).toBe(47);
    expect(minScoreAt(null, ist(D, '12:00'))).toBeNull();
  });

  it('scan match: ANY, EXACT and CONTAINS compare case-insensitively; no scan name never matches a named rule', () => {
    const contains = { kind: 'chartink' as const, scanName: 'hull', match: 'CONTAINS' as const, side: 'BUY' as const, minScore: null };
    expect(scanMatches(contains, 'Hull MA cross 15m')).toBe(true);
    expect(scanMatches(contains, 'EMA breakout')).toBe(false);
    expect(scanMatches(contains, null)).toBe(false);
    expect(scanMatches({ ...contains, match: 'EXACT', scanName: 'Hull MA cross 15m' }, 'hull ma cross 15m')).toBe(true);
    expect(scanMatches({ ...contains, match: 'ANY', scanName: null }, null)).toBe(true);
  });

  it('a hit that is not the strategy’s (scan or side) is NOT_MINE; an evaluator entry never matches Chartink (O5)', () => {
    expect(matchEntry(plainBlocks(), hit({ scanName: 'EMA breakout' }), ist(D, '10:30'))).toEqual({ kind: 'NOT_MINE' });
    expect(matchEntry(plainBlocks(), hit({ side: 'SELL' }), ist(D, '10:30'))).toEqual({ kind: 'NOT_MINE' });
    const evaluator = { ...plainBlocks(), entry: { kind: 'evaluator' as const, evaluatorKey: 'zone-reversal', params: {}, side: 'BOTH' as const } };
    expect(matchEntry(evaluator, hit(), ist(D, '10:30'))).toEqual({ kind: 'NOT_MINE' });
  });

  it('OPTIONS_BUY is VEHICLE_UNSUPPORTED (O4); a low score is MIN_SCORE; otherwise a CANDIDATE', () => {
    const opt = { ...optionBlocks(), entry: plainBlocks().entry };
    expect(matchEntry(opt, hit(), ist(D, '10:30'))).toMatchObject({ kind: 'SKIP', reason: 'VEHICLE_UNSUPPORTED' });
    expect(matchEntry(adaptiveBlocks(), hit({ scanName: 'anything', score: 70 }), ist(D, '12:00'))).toEqual({ kind: 'SKIP', reason: 'MIN_SCORE', detail: 'score 70 below 75 (11:45-14:00 IST window)' });
    expect(matchEntry(adaptiveBlocks(), hit({ score: 46 }), ist(D, '10:30'))).toEqual({ kind: 'SKIP', reason: 'MIN_SCORE', detail: 'score 46 below 47' });
    expect(matchEntry(adaptiveBlocks(), hit({ score: 47 }), ist(D, '10:30'))).toEqual({ kind: 'CANDIDATE' });
    expect(matchEntry(plainBlocks(), hit({ score: 0 }), ist(D, '12:00'))).toEqual({ kind: 'CANDIDATE' });
  });
});

describe('filters (spec §4.1 filters; the silo rules)', () => {
  it('stale entry is the move past the alert price in the trade direction, strictly over the limit', () => {
    expect(staleMovePct('BUY', 100, 101.5)).toBeCloseTo(1.5);
    expect(staleMovePct('SELL', 100, 98.9)).toBeCloseTo(1.1);
    expect(staleEntryFails({ maxMovePct: 1 }, 'BUY', 100, 101)).toBe(false);
    expect(staleEntryFails({ maxMovePct: 1 }, 'BUY', 100, 101.01)).toBe(true);
    expect(staleEntryFails({ maxMovePct: 1 }, 'SELL', 100, 101)).toBe(false);
    expect(staleEntryFails(null, 'BUY', 100, 150)).toBe(false);
    // An alert price that cannot be judged fails closed (Global Constraints: entries fail closed).
    expect(staleEntryFails({ maxMovePct: 1 }, 'BUY', 0, 500)).toBe(true);
    expect(staleEntryFails({ maxMovePct: 1 }, 'BUY', 100, Number.NaN)).toBe(true);
  });

  it('cooldown: active while the last open is at most `minutes` ago', () => {
    const now = ist(D, '11:00');
    expect(cooldownActive({ minutes: 45 }, ist(D, '10:15'), now)).toBe(true);
    expect(cooldownActive({ minutes: 45 }, ist(D, '10:14'), now)).toBe(false);
    expect(cooldownActive({ minutes: 45 }, null, now)).toBe(false);
    expect(cooldownActive(null, ist(D, '10:59'), now)).toBe(false);
  });

  it('last loss: net ≤ 0 blocks, unknown is UNKNOWN (fail closed), none or a win passes', () => {
    const f = { window: 'SAME_IST_DAY' as const };
    expect(lastLossVerdict(f, -0.01)).toBe('BLOCK');
    expect(lastLossVerdict(f, 0)).toBe('BLOCK');
    expect(lastLossVerdict(f, 12.5)).toBe('PASS');
    expect(lastLossVerdict(f, null)).toBe('PASS');
    expect(lastLossVerdict(f, 'UNKNOWN')).toBe('UNKNOWN');
    expect(lastLossVerdict(null, -50)).toBe('PASS');
  });
});

describe('stop, sizing and ids (ruling J8, J4)', () => {
  it('stop price from the stop % on the reference, to the paisa', () => {
    expect(stopPriceFor('BUY', 500, 1.5)).toBe(492.5);
    expect(stopPriceFor('SELL', 500, 1.5)).toBe(507.5);
    expect(stopPriceFor('BUY', 1234.56, 0.8)).toBe(1224.68);
  });

  it('riskRupees sizes by the stop distance, notionalRupees by the price, whole lots, never negative', () => {
    expect(sizeQty({ kind: 'riskRupees', amount: 800 }, 500, 494, 1)).toBe(133);
    expect(sizeQty({ kind: 'notionalRupees', amount: 200000 }, 500, 492.5, 1)).toBe(400);
    expect(sizeQty({ kind: 'notionalRupees', amount: 200000 }, 500, 492.5, 75)).toBe(375);
    expect(sizeQty({ kind: 'riskRupees', amount: 800 }, 500, 500, 1)).toBe(0);
    expect(sizeQty({ kind: 'riskRupees', amount: 3 }, 500, 494, 1)).toBe(0);
    expect(sizeQty({ kind: 'notionalRupees', amount: 1000 }, 0, 0, 1)).toBe(0);
  });

  it('the intent id is deterministic per (user, strategy, alert, token) and differs across users', () => {
    const a = intentIdFor('user_A', 'cs_x', 'alert_1', '2885');
    expect(a).toMatch(/^ci_[0-9a-f]{32}$/);
    expect(intentIdFor('user_A', 'cs_x', 'alert_1', '2885')).toBe(a);
    expect(intentIdFor('user_B', 'cs_x', 'alert_1', '2885')).not.toBe(a);
    expect(intentIdFor('user_A', 'cs_y', 'alert_1', '2885')).not.toBe(a);
  });

  it('setup group key is the legacy corpus form alertId|symbol|IST day', () => {
    expect(setupGroupKey('alert_1', 'RELIANCE', ist(D, '23:59'))).toBe('alert_1|RELIANCE|2026-10-13');
  });
});
