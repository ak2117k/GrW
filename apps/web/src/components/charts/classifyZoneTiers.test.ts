import { describe, it, expect } from 'vitest';
import type { StrongZone } from '@/types';
import { classifyZoneTiers } from './classifyZoneTiers';

// Minimal StrongZone factory — only the fields the helper reads matter.
function zone(p: Partial<StrongZone> & {
  type: 'support' | 'resistance';
  classification: 'STRONG' | 'MEDIUM' | 'WEAK';
  upper: number;
  lower: number;
}): StrongZone {
  return {
    id: `${p.type}-${p.upper}`,
    token: '1',
    symbol: 'TEST',
    exchange: 'NSE',
    isLine: p.isLine ?? true,
    strength: p.strength ?? 50,
    touchCount: 3,
    lastTouchTimestamp: 0,
    scoreBreakdown: {
      touchCount: 0, reversalScore: 0, volumeScore: 0,
      recencyScore: 0, confluenceBonus: 0, wickDensity: 0,
    },
    computedAt: 0,
    expiresAt: 0,
    ...p,
  };
}

describe('classifyZoneTiers', () => {
  it('returns [] when ltp is not positive', () => {
    const zones = [zone({ type: 'resistance', classification: 'STRONG', upper: 110, lower: 110 })];
    expect(classifyZoneTiers(zones, 0)).toEqual([]);
    expect(classifyZoneTiers(zones, -5)).toEqual([]);
    expect(classifyZoneTiers(zones, NaN)).toEqual([]);
  });

  it('returns [] for empty input', () => {
    expect(classifyZoneTiers([], 100)).toEqual([]);
  });

  it('drops WEAK zones entirely', () => {
    const zones = [zone({ type: 'resistance', classification: 'WEAK', upper: 110, lower: 110 })];
    expect(classifyZoneTiers(zones, 100)).toEqual([]);
  });

  it('marks the single resistance and single support both as immediate', () => {
    const zones = [
      zone({ type: 'resistance', classification: 'MEDIUM', upper: 110, lower: 110 }),
      zone({ type: 'support', classification: 'MEDIUM', upper: 90, lower: 90 }),
    ];
    const out = classifyZoneTiers(zones, 100);
    const r = out.find((a) => a.zone.type === 'resistance')!;
    const s = out.find((a) => a.zone.type === 'support')!;
    expect(r.tier).toBe('immediate');
    expect(s.tier).toBe('immediate');
    expect(r.isImmediate).toBe(true);
    expect(s.isImmediate).toBe(true);
  });

  it('signs distancePct: + above price, - below', () => {
    const zones = [
      zone({ type: 'resistance', classification: 'MEDIUM', upper: 102, lower: 102 }),
      zone({ type: 'support', classification: 'MEDIUM', upper: 98, lower: 98 }),
    ];
    const out = classifyZoneTiers(zones, 100);
    expect(out.find((a) => a.zone.type === 'resistance')!.distancePct).toBeCloseTo(2, 5);
    expect(out.find((a) => a.zone.type === 'support')!.distancePct).toBeCloseTo(-2, 5);
  });

  it('nearer MEDIUM is immediate, farther STRONG is major (same side)', () => {
    const near = zone({ type: 'resistance', classification: 'MEDIUM', upper: 105, lower: 105 });
    const far = zone({ type: 'resistance', classification: 'STRONG', upper: 120, lower: 120 });
    const out = classifyZoneTiers([near, far], 100);
    const nearA = out.find((a) => a.zone.upper === 105)!;
    const farA = out.find((a) => a.zone.upper === 120)!;
    expect(nearA.tier).toBe('immediate');
    expect(nearA.isImmediate).toBe(true);
    expect(nearA.isMajor).toBe(false);
    expect(farA.tier).toBe('major');
    expect(farA.isMajor).toBe(true);
  });

  it('when the nearest zone is STRONG it is both immediate and major', () => {
    const out = classifyZoneTiers(
      [zone({ type: 'resistance', classification: 'STRONG', upper: 105, lower: 105 })],
      100,
    );
    expect(out[0].isImmediate).toBe(true);
    expect(out[0].isMajor).toBe(true);
    expect(out[0].tier).toBe('immediate');
  });

  it('uses the reachable band edge: lower edge for resistance, upper for support', () => {
    const res = zone({ type: 'resistance', classification: 'MEDIUM', upper: 115, lower: 110, isLine: false });
    const sup = zone({ type: 'support', classification: 'MEDIUM', upper: 90, lower: 85, isLine: false });
    const out = classifyZoneTiers([res, sup], 100);
    expect(out.find((a) => a.zone.type === 'resistance')!.refPrice).toBe(110);
    expect(out.find((a) => a.zone.type === 'support')!.refPrice).toBe(90);
  });

  it('tie in distance: first-in-array wins immediate, equidistant STRONG still gets major', () => {
    const z1 = zone({ type: 'resistance', classification: 'MEDIUM', upper: 105, lower: 105 });
    const z2 = zone({ type: 'resistance', classification: 'STRONG', upper: 105, lower: 105 });
    const out = classifyZoneTiers([z1, z2], 100);
    const first = out.find((a) => a.zone.classification === 'MEDIUM')!;
    const second = out.find((a) => a.zone.classification === 'STRONG')!;
    expect(first.isImmediate).toBe(true);
    expect(first.tier).toBe('immediate');
    expect(second.isMajor).toBe(true);
    expect(second.tier).toBe('major');
  });

  it('drops a band that straddles the LTP (lower < ltp < upper)', () => {
    // A band whose range contains the price can't be cleanly sided; its
    // reachable-edge refPrice would contradict its type — so it is excluded.
    const straddle = zone({ type: 'resistance', classification: 'STRONG', upper: 110, lower: 90, isLine: false });
    const clean = zone({ type: 'support', classification: 'MEDIUM', upper: 80, lower: 80 });
    const out = classifyZoneTiers([straddle, clean], 100);
    expect(out.find((a) => a.zone === straddle)).toBeUndefined();
    expect(out).toHaveLength(1);
    expect(out[0].zone).toBe(clean);
  });

  it('returns [] when ltp is Infinity', () => {
    const zones = [zone({ type: 'resistance', classification: 'STRONG', upper: 110, lower: 110 })];
    expect(classifyZoneTiers(zones, Infinity)).toEqual([]);
  });

  it('keeps a flipped WEAK zone as a forming tier (not dropped)', () => {
    const forming = zone({ type: 'support', classification: 'WEAK', upper: 95, lower: 95, flippedAt: 1, wasType: 'resistance' });
    const out = classifyZoneTiers([forming], 100);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe('forming');
    expect(out[0].isImmediate).toBe(false);
    expect(out[0].isMajor).toBe(false);
  });

  it('a forming zone does not steal immediate from a real zone on the same side', () => {
    const forming = zone({ type: 'support', classification: 'WEAK', upper: 98, lower: 98, flippedAt: 1, wasType: 'resistance' });
    const real = zone({ type: 'support', classification: 'MEDIUM', upper: 95, lower: 95 });
    const out = classifyZoneTiers([forming, real], 100);
    const realA = out.find((a) => a.zone.classification === 'MEDIUM')!;
    const formingA = out.find((a) => a.zone.classification === 'WEAK')!;
    expect(realA.tier).toBe('immediate');
    expect(formingA.tier).toBe('forming');
  });
});
