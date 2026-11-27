import type { DeskPacket, InstrumentView, ManagerDecision, PositionView } from './desk.types';
import { validateDecision } from './decision-validate';

const inst = (underlying: string, ltp: number | null): InstrumentView => ({
  underlying, ltp, dayOpen: null, dayHigh: null, dayLow: null, vwap: null, trend15m: null, levels: [], chainWalls: null, missing: [],
});
const pos = (over: Partial<PositionView>): PositionView => ({
  trackerId: 't1', symbol: 'BSE25NOV2850CE', exchange: 'BFO', underlying: 'BSE', qty: 75, entry: 40, ltp: 45, pnl: 375, ageMin: 20,
  origin: 'manager', held: false, sentinel: null, managerStop: 2820, managerTargets: [2900], ...over,
});
const blk = <T>(value: T) => ({ status: 'present' as const, value, source: 'test' });
const packet = (positions: PositionView[] = [pos({})]): DeskPacket =>
  ({
    at: '2026-11-26T04:30:00.000Z',
    mode: 'shadow',
    positions: blk(positions),
    instruments: blk({ BSE: inst('BSE', 2860), NIFTY: inst('NIFTY', 24000) }),
  }) as unknown as DeskPacket;

const OPEN: ManagerDecision = {
  action: 'OPEN', underlying: 'BSE', side: 'BUY_CE', strikePolicy: 'ATM', expiryPolicy: 'NEAREST',
  entry: { type: 'NOW', validMin: 10 }, stop: { underlying: 2840 }, targets: { underlying: [2890] }, confidence: 'medium',
  reason: 'r', evidence: ['ltp 2860'],
};
const open = (o: Partial<Extract<ManagerDecision, { action: 'OPEN' }>>) => ({ ...OPEN, ...o }) as ManagerDecision;

describe('validateDecision', () => {
  it('a sound OPEN is valid (risk 20, reward 30 = 1.5)', () => {
    expect(validateDecision(OPEN, packet())).toEqual([]);
  });

  it('rejects a decision without evidence', () => {
    expect(validateDecision({ action: 'NO_ACTION', reason: 'r', evidence: [] }, packet())).toEqual([expect.stringMatching(/evidence/)]);
    expect(validateDecision(open({ evidence: [] }), packet()).join()).toMatch(/evidence/);
  });

  it('rejects reward below 1.2', () => {
    // risk 20, reward 20 = 1.0
    expect(validateDecision(open({ targets: { underlying: [2880] } }), packet()).join()).toMatch(/reward.*1\.2/);
    // ZONE: entry ref = mid 2850; risk 10, reward 11 = 1.1
    expect(validateDecision(open({ entry: { type: 'ZONE', low: 2845, high: 2855, validMin: 20 }, targets: { underlying: [2861] } }), packet()).join()).toMatch(/reward/);
    // BREAKOUT PE: ref = triggerBelow 2850; stop 2870 (risk 20), target 2810 (reward 40) — valid
    expect(validateDecision(open({ side: 'BUY_PE', entry: { type: 'BREAKOUT', triggerBelow: 2850, validMin: 20 }, stop: { underlying: 2870 }, targets: { underlying: [2810] } }), packet())).toEqual([]);
  });

  it('rejects stop on wrong side (and a target on the wrong side)', () => {
    expect(validateDecision(open({ stop: { underlying: 2870 } }), packet()).join()).toMatch(/stop.*wrong side/);
    expect(validateDecision(open({ side: 'BUY_PE', stop: { underlying: 2840 }, targets: { underlying: [2800] } }), packet()).join()).toMatch(/stop.*wrong side/);
    expect(validateDecision(open({ targets: { underlying: [2850] } }), packet()).join()).toMatch(/target.*wrong side/);
  });

  it('rejects OPEN on an underlying absent from the packet, without an entry price, or with a bad validMin', () => {
    expect(validateDecision(open({ underlying: 'DABUR' }), packet()).join()).toMatch(/DABUR.*not in packet\.instruments/);
    const p = packet();
    (p.instruments.value as Record<string, InstrumentView>).BSE.ltp = null;
    expect(validateDecision(OPEN, p).join()).toMatch(/entry reference/);
    expect(validateDecision(open({ entry: { type: 'BREAKOUT', triggerBelow: 2850, validMin: 20 } }), packet()).join()).toMatch(/entry reference/);
    expect(validateDecision(open({ entry: { type: 'NOW', validMin: 0 } }), packet()).join()).toMatch(/validMin/);
  });

  it('rejects TIGHTEN that loosens (CE: lower or equal; PE: higher or equal); a real tighten passes', () => {
    const t = (trackerId: string, underlyingStop: number): ManagerDecision => ({ action: 'TIGHTEN', trackerId, underlyingStop, reason: 'r', evidence: ['1'] });
    const p = packet([pos({}), pos({ trackerId: 't2', symbol: 'BSE25NOV2850PE', managerStop: 2900 })]);
    expect(validateDecision(t('t1', 2810), p).join()).toMatch(/loosen/);
    expect(validateDecision(t('t1', 2820), p).join()).toMatch(/loosen/);
    expect(validateDecision(t('t1', 2830), p)).toEqual([]);
    expect(validateDecision(t('t2', 2910), p).join()).toMatch(/loosen/);
    expect(validateDecision(t('t2', 2890), p)).toEqual([]);
  });

  it('rejects EXIT on a held position, and EXIT/BOOK/TIGHTEN on an unknown tracker', () => {
    const p = packet([pos({ held: true })]);
    expect(validateDecision({ action: 'EXIT', trackerId: 't1', reason: 'r', evidence: ['1'] }, p).join()).toMatch(/held/);
    expect(validateDecision({ action: 'BOOK', trackerId: 'nope', reason: 'r', evidence: ['1'] }, packet()).join()).toMatch(/not in packet\.positions/);
    expect(validateDecision({ action: 'EXIT', trackerId: 't1', reason: 'r', evidence: ['1'] }, packet())).toEqual([]);
  });

  it('rejects PAUSE minutes outside 1–390', () => {
    const pz = (minutes: number): ManagerDecision => ({ action: 'PAUSE_ENTRIES', scope: 'all', minutes, reason: 'r', evidence: ['1'] });
    expect(validateDecision(pz(0), packet()).join()).toMatch(/minutes/);
    expect(validateDecision(pz(391), packet()).join()).toMatch(/minutes/);
    expect(validateDecision(pz(30), packet())).toEqual([]);
  });

  it('BRIEF: an open tracker in the packet with 20–1500 chars is valid (no evidence needed); unknown / closed or bad length refused', () => {
    const b = (trackerId: string, text: string): ManagerDecision => ({ action: 'BRIEF', trackerId, text, reason: 'trade brief', evidence: [] });
    const ok = 'Plan: hold for 2900 above 2820 on 15m closes.';
    expect(validateDecision(b('t1', ok), packet())).toEqual([]);
    expect(validateDecision(b('t9', ok), packet()).join()).toMatch(/t9 not in packet.positions/);
    expect(validateDecision(b('t1', ok), packet([])).join()).toMatch(/not in packet.positions/); // closed: no longer listed
    expect(validateDecision(b('t1', 'too short'), packet()).join()).toMatch(/outside 20–1500/);
    expect(validateDecision(b('t1', 'x'.repeat(1501)), packet()).join()).toMatch(/outside 20–1500/);
  });
});
