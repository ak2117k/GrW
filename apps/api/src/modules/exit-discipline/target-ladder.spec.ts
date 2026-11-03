import { parseExitDisciplineConfig } from './config';
import { decideExit } from './decision';
import { evaluateExitGate, type GateFacts } from './gate';
import { readPacketFacts } from './packet-facts';
import { defaultLadderStop, ladderReading, ladderTargets, parseLadderMode, type LadderInput } from './target-ladder';

const L = (over: Partial<LadderInput>): LadderInput => ({
  side: 'LONG', entry: 100, targets: [120, 140, 160], best: 100, ltp: 100, nContract: null, trailN: 2, prevStop: null, ...over,
});

describe('target ladder (real positions, same rules as paper)', () => {
  it('orders the targets nearest first and drops wrong-side ones', () => {
    expect(ladderTargets('LONG', 100, [140, 90, 120, 120])).toEqual([120, 140]);
    expect(ladderTargets('SHORT', 100, [60, 80, 110])).toEqual([80, 60]);
    expect(ladderTargets('LONG', 100, null)).toEqual([]);
  });

  it('before T1: no stop of its own, no exit', () => {
    expect(ladderReading(L({ best: 119, ltp: 110 }))).toMatchObject({ stage: 0, stop: null, trip: null });
  });

  it('T1 → stop to the entry; T2 → stop to T1; the last target → exit', () => {
    expect(ladderReading(L({ best: 121, ltp: 118 }))).toMatchObject({ stage: 1, stop: 100, trip: null });
    expect(ladderReading(L({ best: 145, ltp: 141 }))).toMatchObject({ stage: 2, stop: 120, trip: null });
    expect(ladderReading(L({ best: 160, ltp: 150 }))).toMatchObject({ stage: 3, lastHit: true, trip: 'TARGET' });
  });

  it('the moved stop exits once crossed (TARGET_TRAIL) — the best price is remembered, so a pullback does not undo the stage', () => {
    expect(ladderReading(L({ best: 125, ltp: 99.5 }))).toMatchObject({ stage: 1, stop: 100, trip: 'TARGET_TRAIL' });
    expect(ladderReading(L({ best: 141, ltp: 119 }))).toMatchObject({ stage: 2, stop: 120, trip: 'TARGET_TRAIL' });
  });

  it('never loosens: a stop already tighter (memory / the last packet) is kept', () => {
    expect(ladderReading(L({ best: 121, ltp: 125, prevStop: 120 }))).toMatchObject({ stop: 120 });
    // An unknown best (the LTP stands in) cannot drop a stop already reached.
    expect(ladderReading(L({ best: null, ltp: 110, prevStop: 100 }))).toMatchObject({ stage: 0, stop: 100, trip: null });
  });

  it('one target: reaching it does not exit — the noise trail takes over, floored at the entry', () => {
    const one = { targets: [120], nContract: 3, trailN: 2 };
    expect(ladderReading(L({ ...one, best: 121, ltp: 120 }))).toMatchObject({ stage: 1, trailing: true, stop: 115, trip: null, lastHit: false });
    expect(ladderReading(L({ ...one, best: 103, ltp: 103 }))).toMatchObject({ stage: 0, stop: null });
    // Trail ratchets with the best; the floor is the entry.
    expect(ladderReading(L({ ...one, best: 150, ltp: 146, prevStop: 115 }))).toMatchObject({ stop: 144, trip: null });
    expect(ladderReading(L({ ...one, best: 150, ltp: 143.9, prevStop: 144 }))).toMatchObject({ stop: 144, trip: 'TARGET_TRAIL' });
    // N unknown: the trail sits at the entry.
    expect(ladderReading(L({ targets: [120], best: 130, ltp: 125, nContract: null }))).toMatchObject({ stop: 100 });
  });

  it('shorts mirror it', () => {
    const s = { side: 'SHORT' as const, entry: 200, targets: [180, 160] };
    expect(ladderReading(L({ ...s, best: 179, ltp: 185 }))).toMatchObject({ stage: 1, stop: 200, trip: null });
    expect(ladderReading(L({ ...s, best: 179, ltp: 200 }))).toMatchObject({ trip: 'TARGET_TRAIL' });
    expect(ladderReading(L({ ...s, best: 160, ltp: 170 }))).toMatchObject({ trip: 'TARGET', lastHit: true });
  });

  it('the default R for an unknown stop: 1× daily ATR ≈ N × √375, a long capped at half the entry', () => {
    expect(defaultLadderStop('LONG', 100, 1)).toBeCloseTo(100 - Math.sqrt(375), 2);
    expect(defaultLadderStop('LONG', 30, 3)).toBe(15);
    expect(defaultLadderStop('SHORT', 100, 1)).toBeCloseTo(100 + Math.sqrt(375), 2);
    expect(defaultLadderStop('LONG', 100, null)).toBeNull();
  });

  it('TARGET_LADDER mode: on by default; observe / off', () => {
    expect(parseLadderMode(undefined)).toBe('on');
    expect(parseLadderMode('observe')).toBe('observe');
    expect(parseLadderMode('OFF')).toBe('off');
  });
});

describe('exit gate: TARGET_LADDER clause', () => {
  const CFG = parseExitDisciplineConfig({});
  const BASE: GateFacts = {
    exposure: 'BULLISH', positionSide: 'LONG', ltpNow: 119, underlying: 9003, invalidation: 8932,
    holdRef: { id: 'vh', underlying: 8998, support: 8946, resistance: 9020, at: '2026-10-14T10:50:00.000Z' },
    vwap: 9000, nContract: 4.5, nUnderlying: 3.1, floor: { price: 100, armed: false, basis: 'noise' },
    netPnlNow: 1500, maxLossPerTrade: 2000, minutesToClose: 200, productType: 'INTRADAY', isExpiryDay: false, dailyLossLatched: false,
  };
  const at = (r: ReturnType<typeof evaluateExitGate>) => r.clauses.find((c) => c.id === 'TARGET_LADDER');

  it('absent without an enforced ladder (every other packet reads exactly as before)', () => {
    const r = evaluateExitGate(BASE, CFG);
    expect(at(r)).toBeUndefined();
    expect(r).toMatchObject({ justified: false, ladder: false });
  });

  it('a crossed stop needs BOTH reads beyond it; the last target needs none', () => {
    const crossed = evaluateExitGate({ ...BASE, ltpNow: 119.5, ladder: { stop: 120, stage: 2, lastHit: false, packetLtp: 119.8 } }, CFG);
    expect(crossed).toMatchObject({ justified: true, justification: 'TARGET_LADDER', ladder: true });
    const recovered = evaluateExitGate({ ...BASE, ltpNow: 122, ladder: { stop: 120, stage: 2, lastHit: false, packetLtp: 119.8 } }, CFG);
    expect(at(recovered)?.pass).toBe(false);
    expect(recovered.justified).toBe(false);
    const last = evaluateExitGate({ ...BASE, ltpNow: 150, ladder: { stop: 140, stage: 3, lastHit: true, packetLtp: 160 } }, CFG);
    expect(last.justification).toBe('TARGET_LADDER');
  });

  it('skips persistence (the cycle confirmed it), not the opening guard', () => {
    const facts: GateFacts = { ...BASE, ltpNow: 119.5, ladder: { stop: 120, stage: 2, lastHit: false, packetLtp: 119.8 } };
    const cur = { id: 'v1', createdAt: new Date('2026-11-04T06:00:00Z') };
    const now = new Date('2026-11-04T06:00:10Z');
    expect(decideExit({ facts, current: cur, history: [], cfg: CFG, now })).toMatchObject({ outcome: 'PASS', justification: 'TARGET_LADDER' });
    expect(decideExit({ facts: { ...facts, minutesSinceOpen: 2 }, current: cur, history: [], cfg: CFG, now }).outcome).toBe('AWAITING_CONFIRMATION');
  });

  it('packet facts read money.ladder', () => {
    const packet = {
      position: { symbol: 'NIFTY04NOV2625000CE', side: 'LONG', qty: 75, entryPrice: 100, ltp: 119 },
      money: { netPnl: 1400, charges: 40, greenFloorPrice: null, greenFloorArmed: false, ladder: { v: 1, stop: 120, stage: 2, lastHit: false, enforced: true } },
    };
    const f = readPacketFacts(packet);
    expect('unreadable' in f ? null : f.ladder).toEqual({ stop: 120, stage: 2, lastHit: false, enforced: true });
  });
});
