import { EMPTY_ANCHORS, solveCycleAnchors, storedAnchors } from './cycle-anchors';

const at = (iso: string) => new Date(iso);
const base = { side: 'LONG' as const, entryPrice: 362.55, floorArmed: false, last: undefined, memory: EMPTY_ANCHORS };

describe('solveCycleAnchors (FLOOR_HARD_EXIT fixed references)', () => {
  it('the best point moves only to a better price — with the underlying of the pass that first saw it — never to a later read', () => {
    const a = solveCycleAnchors({ ...base, ltp: 380.4, peak: 380.4, underlying: 9531, now: at('2026-10-29T15:30:00Z') });
    expect(a.anchors.best).toEqual({ ltp: 380.4, underlying: 9531, at: '2026-10-29T15:30:00.000Z' });
    const b = solveCycleAnchors({ ...base, memory: a.memory, ltp: 371, peak: 380.4, underlying: 9557, now: at('2026-10-29T15:45:00Z') });
    expect(b.anchors.best).toEqual(a.anchors.best);
    const c = solveCycleAnchors({ ...base, memory: b.memory, ltp: 381, peak: 381, underlying: 9528, now: at('2026-10-29T15:50:00Z') });
    expect(c.anchors.best).toMatchObject({ ltp: 381, underlying: 9528 });
  });

  it('SHORT: the best point is the LOW', () => {
    const a = solveCycleAnchors({ ...base, side: 'SHORT', entryPrice: 100, ltp: 95, peak: 94, underlying: 95, now: at('2026-10-29T05:00:00Z') });
    expect(a.anchors.best).toMatchObject({ ltp: 94 });
    expect(solveCycleAnchors({ ...base, side: 'SHORT', entryPrice: 100, memory: a.memory, ltp: 97, peak: 94, underlying: 97, now: at('2026-10-29T05:01:00Z') }).anchors.best).toMatchObject({ ltp: 94 });
  });

  it('the floor arm point latches at the first armed pass and survives a pass that reads unarmed', () => {
    const a = solveCycleAnchors({ ...base, ltp: 373, peak: 373, underlying: 9547, floorArmed: true, now: at('2026-10-29T15:24:00Z') });
    expect(a.anchors.floorArm).toEqual({ ltp: 373, underlying: 9547, at: '2026-10-29T15:24:00.000Z' });
    const b = solveCycleAnchors({ ...base, memory: a.memory, ltp: 376, peak: 376, underlying: 9540, floorArmed: false, now: at('2026-10-29T15:25:00Z') });
    expect(b.anchors.floorArm).toEqual(a.anchors.floorArm);
  });

  it('a restart reads the last live packet at the same entry (no re-anchoring); a different entry starts afresh', () => {
    const last = { packet: { position: { entryPrice: 362.55 }, money: { anchors: { best: { ltp: 380.4, underlying: 9531, at: 'x' }, floorArm: { ltp: 373, underlying: 9547, at: 'y' } } } } };
    expect(storedAnchors(last, 362.55)).toEqual({ best: { ltp: 380.4, underlying: 9531, at: 'x' }, floorArm: { ltp: 373, underlying: 9547, at: 'y' } });
    const r = solveCycleAnchors({ ...base, last, ltp: 371, peak: 380.4, underlying: 9557, floorArmed: true, now: at('2026-10-29T15:45:00Z') });
    expect(r.anchors).toEqual(storedAnchors(last, 362.55));
    expect(storedAnchors(last, 360)).toEqual({ best: null, floorArm: null });
    expect(storedAnchors({ packet: { position: { entryPrice: 362.55 }, money: { anchors: { best: { ltp: 'x' } } } } }, 362.55)).toEqual({ best: null, floorArm: null });
    // In-process memory for another entry (a re-entry) is ignored.
    const other = solveCycleAnchors({ ...base, memory: { ...r.memory, entry: 350 }, ltp: 365, peak: 365, underlying: 9600, now: at('2026-10-29T16:00:00Z') });
    expect(other.anchors.best).toMatchObject({ ltp: 365, underlying: 9600 });
  });
});

describe('anchors stored on another instrument\'s scale (2026-11-05 reused token: COFORGE ~2100 vs NIFTY ~24400)', () => {
  const mem = { best: { ltp: 228, underlying: 2108.1, at: '2026-11-05T04:20:00.000Z' }, floorArm: { ltp: 70, underlying: 2073.1, at: '2026-11-05T03:46:00.000Z' }, entry: 47 };
  it('re-pairs a wrong-scale underlying with the live one, keeping the contract price and time', () => {
    const a = solveCycleAnchors({ side: 'LONG', entryPrice: 47, floorArmed: true, last: undefined, memory: mem, ltp: 212.9, peak: 228, underlying: 24410, now: at('2026-11-05T06:21:46Z') });
    expect(a.anchors.best).toEqual({ ltp: 228, underlying: 24410, at: '2026-11-05T04:20:00.000Z' });
    expect(a.anchors.floorArm).toEqual({ ltp: 70, underlying: 24410, at: '2026-11-05T03:46:00.000Z' });
  });
  it('a same-scale anchor is left alone', () => {
    const same = { ...mem, best: { ltp: 228, underlying: 24450, at: '2026-11-05T04:20:00.000Z' } };
    const a = solveCycleAnchors({ side: 'LONG', entryPrice: 47, floorArmed: true, last: undefined, memory: same, ltp: 212.9, peak: 228, underlying: 24410, now: at('2026-11-05T06:21:46Z') });
    expect(a.anchors.best?.underlying).toBe(24450);
  });
});
