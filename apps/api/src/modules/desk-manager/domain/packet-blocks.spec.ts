import type { Proposal } from './desk.types';
import {
  capProposals,
  countNotCheckable,
  firstNumber,
  managerLevelsFrom,
  nearestLevels,
  pickUnderlyings,
  timedBlock,
  underlyingFromSymbol,
} from './packet-blocks';

const proposal = (i: number): Proposal => ({
  ref: `reading:${i}`,
  kind: 'reading',
  at: new Date(Date.UTC(2026, 10, 26, 4, 0) + i * 60_000).toISOString(),
  underlying: 'NIFTY',
  text: `p${i}`,
  detail: {},
});

describe('packet blocks', () => {
  it('a failing read is unavailable with its reason; a slow one times out', async () => {
    const bad = await timedBlock('src', async () => {
      throw new Error('db down');
    });
    expect(bad).toEqual({ status: 'unavailable', reason: 'db down', source: 'src' });
    const slow = await timedBlock('slow', () => new Promise((r) => setTimeout(() => r(1), 200)), 20);
    expect(slow.status).toBe('unavailable');
    expect(slow.reason).toMatch(/timed out after 20 ms/);
    expect(await timedBlock('ok', async () => 5)).toEqual({ status: 'present', value: 5, source: 'ok' });
  });

  it('proposals capped at 40 newest first', () => {
    const list = Array.from({ length: 55 }, (_, i) => proposal(i));
    const out = capProposals(list.reverse().sort(() => 0));
    expect(out).toHaveLength(40);
    expect(out[0].ref).toBe('reading:54');
    expect(out[39].ref).toBe('reading:15');
  });

  it('underlyings de-duplicated in order and capped at 8', () => {
    expect(pickUnderlyings([['nifty', 'BSE'], ['NIFTY', null, 'GOLDM'], ['A', 'B', 'C', 'D', 'E', 'F']])).toEqual(['NIFTY', 'BSE', 'GOLDM', 'A', 'B', 'C', 'D', 'E']);
  });

  it('underlying from a contract symbol', () => {
    expect(underlyingFromSymbol('NIFTY27NOV2624650CE')).toBe('NIFTY');
    expect(underlyingFromSymbol('BSE30DEC253900CE')).toBe('BSE');
    expect(underlyingFromSymbol('GOLDM05DEC25FUT')).toBe('GOLDM');
    expect(underlyingFromSymbol('RELIANCE-EQ')).toBe('RELIANCE');
    expect(underlyingFromSymbol('M&M27NOV263500CE')).toBe('M&M');
    expect(underlyingFromSymbol('')).toBeNull();
  });

  it('numbers, levels and NOT_CHECKABLE counts', () => {
    expect(firstNumber('below 3,863 on a 15m close')).toBe(3863);
    expect(firstNumber(null)).toBeNull();
    expect(nearestLevels([100, 200, 300, 400, 500, 600, 700, 800], 410, 3)).toEqual([300, 400, 500]);
    expect(
      countNotCheckable([
        [{ verdict: 'NOT_CHECKABLE', reasonCode: 'QUOTE_BUDGET' }, { verdict: 'NOT_CHECKABLE' }, { verdict: 'CONFIRMED' }],
        [{ verdict: 'NOT_CHECKABLE', reasonCode: 'quote_budget' }],
        null,
      ]),
    ).toEqual({ total: 3, byReason: { QUOTE_BUDGET: 2, OTHER: 1 } });
  });

  it('manager levels: OPEN sets stop and targets, a later TIGHTEN moves the stop', () => {
    const t0 = new Date('2026-11-26T04:00:00Z');
    const t1 = new Date('2026-11-26T04:30:00Z');
    expect(
      managerLevelsFrom([
        { action: 'TIGHTEN', payload: { underlyingStop: 3880 }, createdAt: t1 },
        { action: 'OPEN', payload: { stop: { underlying: 3863 }, targets: { underlying: [3920, 3950] } }, createdAt: t0 },
      ]),
    ).toEqual({ stop: 3880, targets: [3920, 3950] });
  });
});
