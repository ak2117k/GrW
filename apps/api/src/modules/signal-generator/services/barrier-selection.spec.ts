import { selectBarrier } from './barrier-selection';
import type { EvidenceKind, EvidenceLevel } from '../types/evidence-level.types';
import type { StrongZone } from '../types/zone.types';

const ATR = 40;

function ev(price: number, kinds: EvidenceKind[], score = 70): EvidenceLevel {
  return {
    price,
    side: 'resistance',
    score,
    kinds,
    soft: false,
    distancePct: 0,
  };
}

function zone(over: Partial<StrongZone>): StrongZone {
  return {
    id: 'z1',
    token: '1',
    symbol: 'NIFTY',
    exchange: 'NSE',
    type: 'resistance',
    upper: 24700,
    lower: 24680,
    isLine: false,
    strength: 70,
    classification: 'STRONG',
    touchCount: 4,
    lastTouchTimestamp: 0,
    scoreBreakdown: {
      touchCount: 0,
      reversalScore: 0,
      volumeScore: 0,
      recencyScore: 0,
      confluenceBonus: 0,
      wickDensity: 0,
    },
    computedAt: 0,
    expiresAt: 0,
    ...over,
  };
}

describe('selectBarrier', () => {
  // ───────────────────────────────────────────────────────────────────────
  // The rule the whole module exists for.
  // ───────────────────────────────────────────────────────────────────────
  describe('nearest within the strongest class present, not nearest overall', () => {
    it('picks a far OI wall over a near round number', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        levels: [24520, 24600], // the treadmill's fuel: 20 and 100 points up
        evidence: [ev(24700, ['OI_CALL'], 88)],
      });

      expect(b).not.toBeNull();
      expect(b!.kind).toBe('OI_WALL');
      expect(b!.price).toBe(24700);
    });

    it('picks a far high-volume node over a near anchored level and a near weak zone', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        levels: [24560],
        zones: [zone({ lower: 24580, upper: 24600, touchCount: 5 })],
        evidence: [ev(24900, ['POC'], 64)],
      });

      expect(b!.kind).toBe('HVN');
      expect(b!.price).toBe(24900);
    });

    it('picks the NEAREST barrier once the class is fixed', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        evidence: [ev(24900, ['OI_CALL'], 95), ev(24700, ['OI_CALL'], 60)],
      });

      // Nearest wins inside the class even though the far one scores higher —
      // price meets it first.
      expect(b!.price).toBe(24700);
      expect(b!.kind).toBe('OI_WALL');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Each kind is selected when it is the strongest present.
  // ───────────────────────────────────────────────────────────────────────
  describe('each kind wins when it is the strongest present', () => {
    it('OI_WALL from OI_CALL on an up-break', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        evidence: [ev(24700, ['OI_CALL'], 90), ev(24650, ['POC'], 90)],
      });
      expect(b!.kind).toBe('OI_WALL');
      expect(b!.price).toBe(24700);
    });

    it('OI_WALL from OI_PUT on a down-break', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: false,
        atr: ATR,
        evidence: [ev(24300, ['OI_PUT'], 80)],
      });
      expect(b!.kind).toBe('OI_WALL');
      expect(b!.price).toBe(24300);
    });

    it('OI_WALL from OI_CHANGE, which is directionless', () => {
      const up = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        evidence: [ev(24700, ['OI_CHANGE'], 70)],
      });
      const down = selectBarrier({
        from: 24500,
        isUp: false,
        atr: ATR,
        evidence: [ev(24300, ['OI_CHANGE'], 70)],
      });
      expect(up!.kind).toBe('OI_WALL');
      expect(down!.kind).toBe('OI_WALL');
    });

    it('HVN from POC', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        evidence: [ev(24700, ['POC'], 70)],
        levels: [24600],
      });
      expect(b!.kind).toBe('HVN');
    });

    it('VALUE_AREA from VALUE_AREA evidence', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        evidence: [ev(24700, ['VALUE_AREA'], 70)],
        levels: [24600],
      });
      expect(b!.kind).toBe('VALUE_AREA');
    });

    it('MAX_PAIN from MAX_PAIN evidence', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        evidence: [ev(24700, ['MAX_PAIN'], 70)],
        levels: [24600],
      });
      expect(b!.kind).toBe('MAX_PAIN');
    });

    it('ZONE when only zones and levels are available', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        zones: [zone({ lower: 24700, upper: 24730, touchCount: 4 })],
        levels: [24600],
      });
      expect(b!.kind).toBe('ZONE');
      expect(b!.price).toBe(24700); // near edge, not the midpoint
    });

    it('ZONE uses the upper edge on a down-break', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: false,
        atr: ATR,
        zones: [zone({ lower: 24280, upper: 24300, touchCount: 4 })],
      });
      expect(b!.price).toBe(24300);
    });

    it('LEVEL only as the fallback, and it says so', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        levels: [24600],
      });
      expect(b!.kind).toBe('LEVEL');
      expect(b!.price).toBe(24600);
      expect(b!.reason).toMatch(/weakest/i);
    });

    it('rejects zones that have not earned it', () => {
      const weakByClass = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        zones: [zone({ lower: 24700, classification: 'WEAK', touchCount: 9 })],
      });
      const weakByTouches = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        zones: [zone({ lower: 24700, classification: 'STRONG', touchCount: 2 })],
      });
      expect(weakByClass).toBeNull();
      expect(weakByTouches).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Side and distance filtering.
  // ───────────────────────────────────────────────────────────────────────
  describe('a barrier must lie strictly beyond the break, on the break side', () => {
    it('never selects a level below the break on an up-break', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        levels: [24000, 24200],
        evidence: [ev(24100, ['OI_CALL'], 95)],
        zones: [zone({ lower: 24050, upper: 24100, touchCount: 6 })],
      });
      expect(b).toBeNull();
    });

    it('never selects a level above the break on a down-break', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: false,
        atr: ATR,
        levels: [24900],
        evidence: [ev(25000, ['OI_PUT'], 95)],
      });
      expect(b).toBeNull();
    });

    it('a level exactly at the break level is not a destination', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        levels: [24500],
      });
      expect(b).toBeNull();
    });

    it('a CE wall does not bar a down move, nor a PE wall an up move', () => {
      const down = selectBarrier({
        from: 24500,
        isUp: false,
        atr: ATR,
        evidence: [ev(24300, ['OI_CALL'], 95)],
      });
      const up = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        evidence: [ev(24700, ['OI_PUT'], 95)],
      });
      expect(down).toBeNull();
      expect(up).toBeNull();
    });
  });

  describe('near-noise exclusion at 0.5 x ATR', () => {
    it('drops a level inside 0.5 ATR of the break', () => {
      // 0.5 x 40 = 20 points. 24510 is 10 points up: noise.
      const b = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        levels: [24510],
      });
      expect(b).toBeNull();
    });

    it('keeps the next level out and skips the noisy one', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        levels: [24510, 24600],
      });
      expect(b!.price).toBe(24600);
    });

    it('applies the same exclusion to strong classes', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        evidence: [ev(24505, ['OI_CALL'], 95)],
        levels: [24700],
      });
      // The wall is inside the noise band, so it is not a destination; the
      // projection falls back to the level class rather than aiming 5 points up.
      expect(b!.kind).toBe('LEVEL');
      expect(b!.price).toBe(24700);
    });

    it('accepts a barrier exactly at 0.5 ATR', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        levels: [24520],
      });
      expect(b!.price).toBe(24520);
    });

    it('drops the noise filter rather than guessing when ATR is unusable', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: true,
        atr: 0,
        levels: [24501],
      });
      expect(b!.price).toBe(24501);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Null is a legitimate answer.
  // ───────────────────────────────────────────────────────────────────────
  describe('null when nothing qualifies', () => {
    it('returns null with no inputs at all', () => {
      expect(selectBarrier({ from: 24500, isUp: true, atr: ATR })).toBeNull();
    });

    it('returns null for empty and null collections', () => {
      expect(
        selectBarrier({ from: 24500, isUp: true, atr: ATR, zones: null, evidence: null, levels: null }),
      ).toBeNull();
      expect(
        selectBarrier({ from: 24500, isUp: true, atr: ATR, zones: [], evidence: [], levels: [] }),
      ).toBeNull();
    });

    it('returns null for an unusable break level', () => {
      expect(selectBarrier({ from: Number.NaN, isUp: true, atr: ATR, levels: [24600] })).toBeNull();
    });

    it('ignores evidence kinds that are not barriers', () => {
      const b = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        evidence: [ev(24700, ['ROUND', 'HISTORY'], 95)],
      });
      expect(b).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Conviction is computed, not stamped.
  // ───────────────────────────────────────────────────────────────────────
  describe('conviction responds to the underlying evidence', () => {
    it('a heavier OI wall scores above a lighter one', () => {
      const heavy = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        evidence: [ev(24700, ['OI_CALL'], 95)],
      })!;
      const light = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        evidence: [ev(24700, ['OI_CALL'], 20)],
      })!;
      expect(heavy.conviction).toBeGreaterThan(light.conviction);
    });

    it('a zone with more touches and more strength scores higher', () => {
      const strong = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        zones: [zone({ lower: 24700, classification: 'STRONG', strength: 92, touchCount: 8 })],
      })!;
      const thin = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        zones: [zone({ lower: 24700, classification: 'MEDIUM', strength: 40, touchCount: 3 })],
      })!;
      expect(strong.conviction).toBeGreaterThan(thin.conviction);
    });

    it('a profile barrier scores with its evidence score', () => {
      const good = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        evidence: [ev(24700, ['POC'], 90)],
      })!;
      const poor = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        evidence: [ev(24700, ['POC'], 10)],
      })!;
      expect(good.conviction).toBeGreaterThan(poor.conviction);
    });

    it('a corroborated anchored level beats a bare one', () => {
      const bare = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        levels: [24600],
      })!;
      const backed = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        levels: [24600],
        // Within 0.15 ATR (6 points) of the level, and not a barrier kind of
        // its own, so it colours the level rather than replacing it.
        evidence: [ev(24603, ['HISTORY', 'VOLUME'], 80)],
      })!;
      expect(backed.kind).toBe('LEVEL');
      expect(backed.conviction).toBeGreaterThan(bare.conviction);
    });

    it('class bands never invert: the weakest wall outranks the strongest level and zone', () => {
      const wall = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        evidence: [ev(24700, ['OI_CALL'], 0)],
      })!;
      const profile = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        evidence: [ev(24700, ['POC'], 100)],
      })!;
      const bestZone = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        zones: [zone({ lower: 24700, classification: 'STRONG', strength: 100, touchCount: 20 })],
      })!;
      const bestLevel = selectBarrier({
        from: 24500,
        isUp: true,
        atr: ATR,
        levels: [24600],
        evidence: [ev(24600, ['HISTORY'], 100)],
      })!;

      expect(wall.conviction).toBeGreaterThan(profile.conviction);
      expect(profile.conviction).toBeGreaterThan(bestZone.conviction);
      expect(bestZone.conviction).toBeGreaterThan(bestLevel.conviction);
      expect(wall.conviction).toBeLessThanOrEqual(100);
      expect(bestLevel.conviction).toBeGreaterThan(0);
    });
  });

  it('names the evidence in one plain sentence', () => {
    const b = selectBarrier({
      from: 24500,
      isUp: true,
      atr: ATR,
      evidence: [ev(24700, ['OI_CALL'], 88)],
    })!;
    expect(b.reason).toContain('24,700');
    expect(b.reason).toMatch(/call open interest/i);
    expect(b.reason).not.toMatch(/[{}]/);
  });
});
