import type { Proposal } from './desk.types';
import {
  countNotCheckable,
  firstNumber,
  isBareUpdate,
  lotCost,
  managerLevelsFrom,
  mergeEngine,
  miniUnderlyingOf,
  nearestLevels,
  normaliseUnderlyingKey,
  pickUnderlyings,
  PROPOSAL_QUOTAS,
  quotaProposals,
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

  it('readings over the quota: the 16 newest kept', () => {
    const list = Array.from({ length: 55 }, (_, i) => proposal(i));
    const out = quotaProposals(list.reverse());
    expect(out).toHaveLength(16);
    expect(out[0].ref).toBe('reading:54');
    expect(out[15].ref).toBe('reading:39');
  });

  it('underlyings de-duplicated in order and capped at 8 (minis read as their parent)', () => {
    expect(pickUnderlyings([['nifty', 'BSE'], ['NIFTY', null, 'GOLDM'], ['A', 'B', 'C', 'D', 'E', 'F']])).toEqual(['NIFTY', 'BSE', 'GOLD', 'A', 'B', 'C', 'D', 'E']);
  });

  it('underlying keys: MARKET dropped, aliases and minis mapped, a long stock name matched to the master', () => {
    const names = new Set(['BHARATFORG', 'NIFTY', 'GOLD', 'RELIANCE', 'MAZDOCK']);
    expect(normaliseUnderlyingKey('MARKET')).toBeNull();
    expect(normaliseUnderlyingKey(' ')).toBeNull();
    expect(normaliseUnderlyingKey('goldm')).toBe('GOLD');
    expect(normaliseUnderlyingKey('CRUDEOILM')).toBe('CRUDEOIL');
    expect(normaliseUnderlyingKey('NATGASMINI')).toBe('NATURALGAS');
    expect(normaliseUnderlyingKey('SILVERM')).toBe('SILVER');
    expect(normaliseUnderlyingKey('BANK NIFTY')).toBe('BANKNIFTY');
    expect(normaliseUnderlyingKey('RELIANCE-EQ', names)).toBe('RELIANCE');
    expect(normaliseUnderlyingKey('BHARATFORGE', names)).toBe('BHARATFORG');
    expect(normaliseUnderlyingKey('MAZDOK', names)).toBe('MAZDOCK');
    expect(normaliseUnderlyingKey('UNKNOWNCO', names)).toBe('UNKNOWNCO');
    expect(pickUnderlyings([['MARKET', 'BHARATFORGE', 'BHARATFORG']], 8, names)).toEqual(['BHARATFORG']);
  });

  it('proposal quotas per source, newest first; unused quota never goes to the engine', () => {
    const mk = (kind: Proposal['kind'], i: number, over: Partial<Proposal> = {}): Proposal => ({
      ref: `${kind}:${i}`,
      kind,
      at: new Date(Date.UTC(2026, 10, 26, 4, 0) + i * 60_000).toISOString(),
      underlying: `U${i}`,
      text: '',
      detail: kind === 'reading' ? { kind: 'CALL', call: { underlying: `U${i}` } } : kind === 'engine' ? { action: 'ENTER_CE' } : {},
      ...over,
    });
    const list = [
      ...Array.from({ length: 30 }, (_, i) => mk('reading', i)),
      ...Array.from({ length: 3 }, (_, i) => mk('signal_decision', i)),
      ...Array.from({ length: 10 }, (_, i) => mk('setup', i)),
      ...Array.from({ length: 40 }, (_, i) => mk('engine', i)),
    ];
    const out = quotaProposals(list);
    const by = (k: Proposal['kind']) => out.filter((p) => p.kind === k);
    expect(by('reading')).toHaveLength(16);
    expect(by('reading')[0].ref).toBe('reading:29');
    expect(by('signal_decision')).toHaveLength(3);
    expect(by('setup')).toHaveLength(6);
    expect(by('engine')).toHaveLength(10);
    expect(by('engine')[0].ref).toBe('engine:39');
    expect(PROPOSAL_QUOTAS).toEqual({ reading: 16, signal_decision: 8, setup: 6, engine: 10 });
    // newest first overall
    const t = out.map((p) => Date.parse(p.at));
    expect([...t].sort((a, b) => b - a)).toEqual(t);
  });

  it('engine items merge to one per (underlying, side), latest wins, with a count', () => {
    const e = (id: string, min: number, underlying: string, action: string): Proposal => ({
      ref: `engine:${id}`,
      kind: 'engine',
      at: new Date(Date.UTC(2026, 10, 26, 4, min)).toISOString(),
      underlying,
      text: id,
      detail: { action, mode: 'paper', tradeId: null },
    });
    const out = mergeEngine([e('a', 1, 'NIFTY', 'ENTER_CE'), e('b', 5, 'NIFTY', 'ENTER_CE'), e('c', 3, 'NIFTY', 'ENTER_PE'), e('d', 2, 'NIFTY', 'ENTER_CE')]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ ref: 'engine:b', detail: { action: 'ENTER_CE', count: 3 } });
    expect(out[1]).toMatchObject({ ref: 'engine:c', detail: { action: 'ENTER_PE', count: 1 } });
  });

  it('bare-number UPDATE readings (no instrument, no level) are dropped', () => {
    const r = (id: string, kind: string, call: unknown, underlying: string | null): Proposal => ({ ref: `reading:${id}`, kind: 'reading', at: new Date().toISOString(), underlying, text: '', detail: { kind, call } });
    expect(isBareUpdate(r('1', 'UPDATE', null, null))).toBe(true);
    expect(isBareUpdate(r('2', 'UPDATE', { underlying: '', strike: null, entryLow: null, entryHigh: null, stopLoss: null, targets: [] }, null))).toBe(true);
    expect(isBareUpdate(r('3', 'UPDATE', { underlying: '', strike: null, entryLow: null, entryHigh: null, stopLoss: 120, targets: [] }, null))).toBe(false);
    expect(isBareUpdate(r('4', 'UPDATE', { underlying: 'NIFTY' }, 'NIFTY'))).toBe(false);
    expect(isBareUpdate(r('5', 'CALL', null, null))).toBe(false);
    expect(quotaProposals([r('1', 'UPDATE', null, null), r('4', 'UPDATE', { underlying: 'NIFTY' }, 'NIFTY')]).map((p) => p.ref)).toEqual(['reading:4']);
  });

  it('an UPDATE whose claim subject or summary names an instrument is kept', () => {
    const r = (detail: Record<string, unknown>, text = ''): Proposal => ({ ref: 'reading:x', kind: 'reading', at: new Date().toISOString(), underlying: null, text, detail: { kind: 'UPDATE', call: null, ...detail } });
    expect(isBareUpdate(r({ claims: [{ subject: 'BANKNIFTY', text: 'holding' }] }))).toBe(false);
    expect(isBareUpdate(r({ claims: [{ subject: 'MARKET', text: 'weak' }] }))).toBe(true);
    expect(isBareUpdate(r({}, 'Bank Nifty 120++ running'))).toBe(false);
    expect(isBareUpdate(r({}, 'crude target done'))).toBe(false);
    expect(isBareUpdate(r({}, 'Mazdock 1760 PE 40++'), new Set(['MAZDOCK']))).toBe(false);
    expect(isBareUpdate(r({}, '120++ running'))).toBe(true);
    expect(isBareUpdate(r({}, 'Mazdock 40++'))).toBe(true); // a stock needs the master's names
  });

  it('mini contract name per underlying (CRUDEOILM, GOLDM, SILVERM, NATGASMINI)', () => {
    expect(miniUnderlyingOf('CRUDEOIL')).toBe('CRUDEOILM');
    expect(miniUnderlyingOf('GOLD')).toBe('GOLDM');
    expect(miniUnderlyingOf('SILVER')).toBe('SILVERM');
    expect(miniUnderlyingOf('NATURALGAS')).toBe('NATGASMINI');
    expect(miniUnderlyingOf('NIFTY')).toBeNull();
  });

  it('1-lot cost = premium x lot size x value factor; fits only when within the funds', () => {
    expect(lotCost({ contract: 'CRUDEOIL16DEC265200CE', premium: 154, lotSize: 100, valueFactor: 1 }, 30_000)).toEqual({ contract: 'CRUDEOIL16DEC265200CE', premium: 154, lotSize: 100, valueFactor: 1, cost: 15_400, required: 15_400, fits: true });
    expect(lotCost({ contract: 'X', premium: 385, lotSize: 100, valueFactor: 1 }, 30_000).fits).toBe(false);
    expect(lotCost({ contract: 'X', premium: 10, lotSize: 1, valueFactor: 100 }, null)).toMatchObject({ cost: 1000, fits: null });
    // fits compares what the order path will ask for (cost + charges buffer), not the bare cost
    expect(lotCost({ contract: 'X', premium: 295, lotSize: 100, valueFactor: 1 }, 30_000, 30_090)).toMatchObject({ cost: 29_500, required: 30_090, fits: false });
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
