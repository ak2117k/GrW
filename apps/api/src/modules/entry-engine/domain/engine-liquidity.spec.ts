import { ENGINE_LIQUIDITY, pickLiquidStrike, type StrikeLiquidity } from './engine-contract';

/** Prod 2026-11-05 GOLD 27NOV CE chain (today's volume, distinct prices): the half-strikes were dead. */
const GOLD = new Map<number, StrikeLiquidity>([
  [145500, { volume: 0, moves: 1 }],
  [145000, { volume: 1014, moves: 12 }],
  [146000, { volume: 125, moves: 6 }],
  [144500, { volume: 29, moves: 1 }],
  [146500, { volume: 0, moves: 1 }],
]);

describe('pickLiquidStrike (2026-11-05 GOLD27NOV26145500CE: bought a strike nobody traded)', () => {
  it('a dead ATM strike moves to the nearest liquid one', () => {
    const r = pickLiquidStrike([145500, 145000, 146000, 144500, 146500], GOLD);
    expect(r).toMatchObject({ ok: true, strike: 145000 });
    expect(r.ok && r.note).toMatch(/ATM 145500 illiquid → nearest liquid 145000/);
  });
  it('a liquid ATM is kept', () => {
    expect(pickLiquidStrike([145000, 145500], GOLD)).toMatchObject({ ok: true, strike: 145000 });
  });
  it('volume without recent price moves is not liquid (a stale print)', () => {
    expect(pickLiquidStrike([144500, 145500], GOLD)).toMatchObject({ ok: false });
  });
  it('no liquid strike in reach ⇒ refused with the reason', () => {
    const r = pickLiquidStrike([145500, 146500], GOLD);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/no liquid strike within 2 of ATM 145500/);
  });
  it('no chain snapshots at all ⇒ ATM, flagged unchecked (the engine keeps working)', () => {
    expect(pickLiquidStrike([24400, 24350], null)).toMatchObject({ ok: true, strike: 24400, note: expect.stringMatching(/unchecked/) });
    expect(pickLiquidStrike([24400], new Map())).toMatchObject({ ok: true, strike: 24400 });
  });
  it('thresholds are the documented ones', () => {
    expect(ENGINE_LIQUIDITY).toEqual({ minVolume: 20, minMoves: 2, recentMin: 30, maxStepsFromAtm: 4 });
  });
});
