import {
  HTF_FOR_TIMEFRAME,
  buildProjectionZones,
  solveFarEdge,
  type BuildProjectionZonesInput,
} from './zone-projection';
import { RR_FLOOR_STRICT, computeSetupPrices, rewardRisk } from './trade-plan';
import type { EvidenceKind, EvidenceLevel } from '../types/evidence-level.types';
import type { StrongZone } from '../types/zone.types';
import type { LevelsSnapshot } from './signal-generator.service';

/**
 * A projection box is an invitation to enter a trade, so the properties worth
 * pinning down are the ones that keep it honest: its far edge is solved rather
 * than guessed, its target is real structure or is labelled as not being real
 * structure, the higher timeframe can only ever take room away, and a box with
 * no room left is absent rather than flat.
 *
 * See docs/superpowers/specs/2026-08-10-projection-zones-design.md §6.
 */

const ATR = 10;

function zone(over: Partial<StrongZone> = {}): StrongZone {
  return {
    id: 'z1',
    token: '18520',
    symbol: 'CUPID',
    exchange: 'NSE',
    type: 'resistance',
    upper: 1000,
    lower: 1000,
    isLine: true,
    strength: 80,
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

function ev(price: number, score: number, kinds: EvidenceKind[] = ['VOLUME']): EvidenceLevel {
  return { price, score, kinds, side: 'resistance', soft: false, distancePct: 0 };
}

/** Broken resistance line at 1000, spot just above it. */
function up(over: Partial<BuildProjectionZonesInput> = {}): BuildProjectionZonesInput {
  return { timeframe: '15m', ltp: 1005, atr14: ATR, zones: [zone()], ...over };
}

/** Mirror of `up`: broken support line at 1000, spot just below it. */
function down(over: Partial<BuildProjectionZonesInput> = {}): BuildProjectionZonesInput {
  return {
    timeframe: '15m',
    ltp: 995,
    atr14: ATR,
    zones: [zone({ type: 'support' })],
    ...over,
  };
}

describe('solveFarEdge — the floor is a solved identity, not a tuned constant', () => {
  /**
   * The one property the whole box rests on. If reward:risk at the far edge is
   * anything other than the floor, the box is offering entries the live engine
   * would reject — the exact disagreement this design exists to prevent.
   */
  it.each([
    ['up-break', 997.5, 1030],
    ['up-break, tight', 999, 1001.5],
    ['down-break', 1002.5, 970],
    ['down-break, tight', 1001, 998.5],
  ])('reward:risk at the far edge equals the floor exactly (%s)', (_label, stop, target) => {
    const farEdge = solveFarEdge(stop as number, target as number);
    expect(rewardRisk(farEdge, stop as number, target as number)).toBeCloseTo(RR_FLOOR_STRICT, 9);
  });

  /**
   * The far edge must sit between stop and target on the reward side; a solve
   * that landed outside would silently invert the box.
   */
  it('lands strictly between the stop and the target', () => {
    expect(solveFarEdge(997.5, 1030)).toBeGreaterThan(997.5);
    expect(solveFarEdge(997.5, 1030)).toBeLessThan(1030);
    expect(solveFarEdge(1002.5, 970)).toBeLessThan(1002.5);
    expect(solveFarEdge(1002.5, 970)).toBeGreaterThan(970);
  });
});

describe('buildProjectionZones — box geometry', () => {
  it('places the near edge on the broken level and the far edge in the direction of the move', () => {
    const box = buildProjectionZones(up()).up!;
    expect(box.side).toBe('UP');
    expect(box.breakLevel).toBe(1000);
    expect(box.entryNear).toBe(1000);
    expect(box.entryFar).toBeGreaterThan(box.entryNear);
    expect(box.stop).toBeLessThan(box.breakLevel);
    expect(box.target).toBeGreaterThan(box.entryFar);
  });

  it('mirrors every inequality for a down-break', () => {
    const box = buildProjectionZones(down()).down!;
    expect(box.side).toBe('DOWN');
    expect(box.entryFar).toBeLessThan(box.entryNear);
    expect(box.stop).toBeGreaterThan(box.breakLevel);
    expect(box.target).toBeLessThan(box.entryFar);
  });

  /**
   * Every entry the box offers must clear the floor, not just its best one —
   * otherwise the band is wider than the trade it represents.
   */
  it('clears the R:R floor at both edges of the entry region', () => {
    for (const box of [buildProjectionZones(up()).up!, buildProjectionZones(down()).down!]) {
      expect(rewardRisk(box.entryNear, box.stop, box.target)).toBeGreaterThanOrEqual(
        RR_FLOOR_STRICT,
      );
      expect(rewardRisk(box.entryFar, box.stop, box.target)).toBeCloseTo(RR_FLOOR_STRICT, 9);
      expect(box.rr).toBeCloseTo(rewardRisk(box.entryNear, box.stop, box.target), 9);
    }
  });

  /**
   * "Already extended" is a legitimate answer. A zero-width band would be read
   * as a real entry region by anyone glancing at the chart.
   */
  it('returns null — never a zero-width box — when structure sits too close to be worth it', () => {
    // A 20-point zone puts the stop 22.5 below the broken edge, so clearing the
    // floor needs 45 points of room. The next structure is 10 points up: the
    // trade is real but not worth taking, and a box would invite it anyway.
    //
    // The collapse has to be driven by STRUCTURE — the ATR fallback is fixed at
    // 3R by construction and can no longer produce a flat box, which is the
    // whole reason it is 3R and not 2R.
    const collapsed = buildProjectionZones(
      up({
        ltp: 1001,
        zones: [
          zone({ lower: 980, upper: 1000, isLine: false }),
          zone({ id: 'z-near', lower: 1010, upper: 1012, isLine: false }),
        ],
      }),
    );
    expect(collapsed.up).toBeNull();
  });

  /**
   * The ARMED case, and the whole reason the feature exists: price is still
   * TRAPPED under the resistance and the box says "if this breaks, here is the
   * plan". Selecting only zones price had already crossed made armed
   * unreachable — on a range-bound chart (the exact case a trader is watching
   * a level for) nothing was ever drawn.
   */
  it('arms a box above a resistance price has NOT broken yet', () => {
    const trapped = buildProjectionZones(
      up({
        ltp: 24591,
        zones: [zone({ lower: 24595, upper: 24600, isLine: false })],
      }),
    );

    expect(trapped.up).not.toBeNull();
    expect(trapped.up!.state).toBe('armed');
    // The box sits ABOVE the level, which is where entry becomes valid.
    expect(trapped.up!.breakLevel).toBe(24600);
    expect(trapped.up!.entryNear).toBe(24600);
    expect(trapped.up!.entryFar).toBeGreaterThan(24600);
  });

  it('arms a box below a support price has NOT broken yet', () => {
    const trapped = buildProjectionZones(
      down({
        ltp: 24591,
        zones: [
          zone({ type: 'support', lower: 24550, upper: 24555, isLine: false }),
        ],
      }),
    );

    expect(trapped.down).not.toBeNull();
    expect(trapped.down!.state).toBe('armed');
    expect(trapped.down!.breakLevel).toBe(24550);
    expect(trapped.down!.entryFar).toBeLessThan(24550);
  });

  /**
   * A confirmed break outranks a level still ahead: once the engine has
   * accepted the break, that is the live trade and the level above becomes its
   * target, not a second box.
   */
  it('prefers a confirmed break over a level still ahead', () => {
    const both = buildProjectionZones(
      up({
        ltp: 1005,
        zones: [
          zone({ id: 'flipped', lower: 998, upper: 1000, isLine: false, flippedAt: 1, wasType: 'resistance', type: 'support' }),
          zone({ id: 'ahead', lower: 1040, upper: 1045, isLine: false }),
        ],
      }),
    );

    expect(both.up!.state).toBe('confirmed');
    expect(both.up!.breakLevel).toBe(1000);
  });

  /**
   * The index case that drew nothing at all.
   *
   * The zone detector needs ten candles, a valid ATR AND clustered pivots, and
   * for an index it routinely produces none — so a chart with ORH, PDH and
   * round levels visibly drawn on it had no anchor and no box. Levels are the
   * fallback anchor precisely so that cannot happen again. Spec §0.4.
   */
  it('anchors on the level book when the detector produced no zones', () => {
    const levels = {
      pdh: 24620,
      pdl: 24500,
      orh: 24610,
      orl: 24560,
      prevOrh: null,
      prevOrl: null,
      vwap: 24580,
      todayHigh: 24618,
      todayLow: 24560,
      atr14: 40,
    } as LevelsSnapshot;

    const fromLevels = buildProjectionZones({
      timeframe: '15m',
      ltp: 24591,
      atr14: 40,
      zones: [],
      levels,
    });

    expect(fromLevels.up ?? fromLevels.down).not.toBeNull();
    // A bare level carries no confirmation, so it can only ever arm.
    for (const box of [fromLevels.up, fromLevels.down]) {
      if (box) expect(box.state).toBe('armed');
    }
  });

  /**
   * The reported incident: a 113-point NIFTY target issued at 12:44 IST on a
   * low-volatility day with most of the daily range already spent. Structurally
   * correct, practically impossible. Spec §0.3.
   */
  it('caps a barrier that today can no longer reach', () => {
    const far = up({
      evidence: [ev(1200, 90, ['OI_CALL'])],
      now: new Date('2026-08-10T07:14:00Z'), // 12:44 IST
      exchange: 'NSE',
      dailyAtr: 200,
      levels: { todayHigh: 1018, todayLow: 1000, atr14: ATR } as LevelsSnapshot,
    });

    const box = buildProjectionZones(far).up!;
    expect(box.cappedBySession).toBe(true);
    expect(box.target).toBeLessThan(1200);
    // The barrier is still NAMED — a capped box says what it could not reach.
    expect(box.reason).toMatch(/beyond today's remaining range/);
  });

  /**
   * A budget so small that the capped target can no longer clear the R:R floor
   * yields NO box. That is deliberate: a box drawn to two points of remaining
   * range would promise a trade the day cannot pay for. The card is what has to
   * explain the absence — the geometry's job is to refuse.
   */
  it('suppresses the box when the day has no worthwhile move left', () => {
    const spent = up({
      evidence: [ev(1200, 90, ['OI_CALL'])],
      now: new Date('2026-08-10T09:50:00Z'), // 15:20 IST, ten minutes left
      exchange: 'NSE',
      dailyAtr: 20,
      levels: { todayHigh: 1019, todayLow: 1000, atr14: ATR } as LevelsSnapshot,
    });

    expect(buildProjectionZones(spent).up).toBeNull();
  });

  it('leaves a reachable barrier alone', () => {
    const near = up({
      evidence: [ev(1012, 90, ['OI_CALL'])],
      now: new Date('2026-08-10T04:00:00Z'), // 09:30 IST, session barely begun
      exchange: 'NSE',
      dailyAtr: 60,
      levels: { todayHigh: 1002, todayLow: 1000, atr14: ATR } as LevelsSnapshot,
    });

    const box = buildProjectionZones(near).up!;
    expect(box.cappedBySession).toBe(false);
    expect(box.target).toBe(1012);
  });

  /**
   * No clock, or no daily ATR, means the day could not be SIZED. That must not
   * silently become "no room" — it weakens the claim, it does not delete it.
   */
  it('does not cap when the day could not be sized', () => {
    const box = buildProjectionZones(
      up({ evidence: [ev(1200, 90, ['OI_CALL'])], now: null }),
    ).up!;
    expect(box.cappedBySession).toBe(false);
    expect(box.target).toBe(1200);
  });

  /**
   * The boundary that made projections flicker between timeframes.
   *
   * A LEVEL anchor is a line, so risk is SL_BUFFER_ATR (0.25) x ATR, while the
   * barrier noise filter admits targets from 0.5 x ATR — exactly 2 x risk. Entry
   * room is (n - 2) / 3 x risk, so a barrier sitting right at that threshold
   * produced EXACTLY zero room and the old guard deleted the whole box. The
   * projection is the TRAVEL now; a degenerate inner band is not a reason to
   * draw nothing.
   */
  it('still projects when the entry region collapses to the break level', () => {
    const levels = {
      pdh: 1005, // exactly 0.5 x ATR beyond the 1000 anchor
      pdl: 900,
      orh: 1000,
      orl: 950,
      prevOrh: null,
      prevOrl: null,
      vwap: 940,
      todayHigh: 1002,
      todayLow: 995,
      atr14: ATR,
    } as LevelsSnapshot;

    const box = buildProjectionZones({
      timeframe: '15m',
      ltp: 998,
      atr14: ATR,
      zones: [],
      levels,
    }).up;

    expect(box).not.toBeNull();
    // Entry collapses onto the break level rather than inverting past it.
    expect(box!.entryFar).toBeGreaterThanOrEqual(box!.breakLevel);
    // The travel span — the thing actually drawn — is still real.
    expect(box!.target).toBeGreaterThan(box!.breakLevel);
  });

  it('only ever emits the side that actually broke', () => {
    expect(buildProjectionZones(up()).down).toBeNull();
    expect(buildProjectionZones(down()).up).toBeNull();
  });
});

describe('buildProjectionZones — geometry parity with the live setup maths', () => {
  /**
   * The parity the spec exists to guarantee: a box and the TradeTrigger it
   * becomes are produced by the SAME arithmetic, so they cannot disagree about
   * where the STOP is — the number that decides how much is lost when the
   * thesis fails, and the one a trader acts on identically in both views.
   *
   * The TARGET is deliberately NOT shared. `computeSetupPrices` measures its
   * reward from a breakout entry just past the zone's far side, whereas a box's
   * entry region starts at the broken edge — so a shared target would put the
   * whole reward inside the zone and collapse every fallback box to null. The
   * sibling test below makes the same point from the structural direction: a
   * structural target diverges from `computeSetupPrices` too, and must.
   */
  it('reproduces the shared stop for the same level', () => {
    const box = buildProjectionZones(up()).up!;
    const direct = computeSetupPrices({
      setupType: 'BREAKOUT',
      isLong: true,
      level: 1000, // the zone's far side — what the stop hides behind
      atr: ATR,
      candidates: [],
    })!;

    expect(box.stop).toBe(direct.stoploss);
    // Reward is measured from the break level, so it must clear the floor there.
    expect(rewardRisk(box.entryNear, box.stop, box.target)).toBeGreaterThanOrEqual(
      RR_FLOOR_STRICT,
    );
  });

  it('keeps the stop on the shared arithmetic even when the target is structural', () => {
    const box = buildProjectionZones(
      up({ zones: [zone(), zone({ id: 'z2', lower: 1030, upper: 1040 })] }),
    ).up!;
    const direct = computeSetupPrices({
      setupType: 'BREAKOUT',
      isLong: true,
      level: 1000,
      atr: ATR,
      candidates: [],
    })!;

    expect(box.stop).toBe(direct.stoploss);
    expect(box.target).toBe(1030);
  });
});

describe('buildProjectionZones — target selection', () => {
  it('takes an opposing STRONG/MEDIUM zone first', () => {
    const box = buildProjectionZones(
      up({ zones: [zone(), zone({ id: 'z2', lower: 1030, upper: 1040 })] }),
    ).up!;
    expect(box.targetSource).toBe('ZONE');
    expect(box.target).toBe(1030);
  });

  /**
   * Priority is by class, not by distance. A nearby evidence level outranking a
   * further STRONG zone would quietly reorder the spec's table.
   */
  it('prefers a further zone over a nearer evidence level', () => {
    const box = buildProjectionZones(
      up({ zones: [zone(), zone({ id: 'z2', lower: 1050, upper: 1060 })], evidence: [ev(1020, 90)] }),
    ).up!;
    expect(box.targetSource).toBe('ZONE');
    expect(box.target).toBe(1050);
  });

  /**
   * A plain VOLUME cluster is no longer a destination on its own — aiming at
   * whatever level happened to be nearest is what made every projection a
   * treadmill. Only a level with a named reason to stop price (an OI wall, a
   * volume node, a tested zone) qualifies now; the rest is terrain. Spec §0.2,
   * and `barrier-selection.spec.ts` owns the ranking itself.
   */
  it('does not aim at a bare evidence cluster with no barrier kind', () => {
    const box = buildProjectionZones(up({ evidence: [ev(1040, 75)] })).up!;
    expect(box.targetSource).not.toBe('ZONE');
    expect(box.target).not.toBe(1040);
  });

  it('aims at an option-chain wall ahead of it', () => {
    const box = buildProjectionZones(up({ evidence: [ev(1040, 75, ['OI_CALL'])] })).up!;
    expect(box.targetSource).toBe('OI_WALL');
    expect(box.target).toBe(1040);
    // Conviction is derived from the evidence, never a per-class constant.
    expect(box.conviction).toBeGreaterThan(0);
  });

  /** Below the score floor an evidence level is noise, not a destination. */
  it('ignores an evidence cluster under the score floor', () => {
    const box = buildProjectionZones(up({ evidence: [ev(1040, 55)] })).up!;
    expect(box.targetSource).toBe('ATR');
    expect(box.target).not.toBe(1040);
  });

  it.each<[EvidenceKind, string]>([
    ['POC', 'HVN'],
    ['VALUE_AREA', 'VALUE_AREA'],
    ['MAX_PAIN', 'MAX_PAIN'],
  ])('uses a %s level and names it as the source', (kind, source) => {
    const box = buildProjectionZones(up({ evidence: [ev(1040, 70, [kind])] })).up!;
    expect(box.targetSource).toBe(source);
    expect(box.target).toBe(1040);
  });

  /**
   * A fallback presented as structure is the one lie this object must never
   * tell — the trader has to be able to discount it.
   */
  it('labels the ATR fallback, in the source AND in the sentence', () => {
    const box = buildProjectionZones(up()).up!;
    expect(box.targetSource).toBe('ATR');
    expect(box.reason).toMatch(/ATR projection/);
  });

  /**
   * A level behind the break is a level price has already passed. Aiming at it
   * would produce a target on the wrong side of the trade.
   */
  it('never selects a level on the wrong side of the break', () => {
    const box = buildProjectionZones(
      up({
        zones: [zone(), zone({ id: 'z2', lower: 985, upper: 990 })],
        evidence: [ev(980, 95)],
      }),
    ).up!;
    expect(box.target).toBeGreaterThan(box.breakLevel);
    expect(box.targetSource).toBe('ATR');
  });

  it('applies the same side rule downward', () => {
    const box = buildProjectionZones(
      down({
        zones: [zone({ type: 'support' }), zone({ id: 'z2', type: 'support', lower: 1010, upper: 1015 })],
      }),
    ).down!;
    expect(box.target).toBeLessThan(box.breakLevel);
  });
});

describe('buildProjectionZones — higher-timeframe capping', () => {
  const withZones = (over: Partial<BuildProjectionZonesInput> = {}) =>
    up({ zones: [zone(), zone({ id: 'z2', lower: 1050, upper: 1060 })], ...over });

  it('maps each timeframe to exactly one higher timeframe', () => {
    expect(HTF_FOR_TIMEFRAME).toMatchObject({
      '1m': '15m',
      '5m': '1h',
      '15m': '1h',
      '1h': '1d',
      '1d': '1w',
      '1w': null,
      '1mo': null,
    });
  });

  it('caps the target to an intervening HTF zone', () => {
    const box = buildProjectionZones(
      withZones({ htfZones: [zone({ id: 'h1', lower: 1030, upper: 1035 })] }),
    ).up!;
    expect(box.target).toBe(1030);
    expect(box.cappedByHtf).toBe(true);
    expect(box.reason).toMatch(/Capped by 1h/);
  });

  /**
   * The asymmetry is the point: the higher timeframe may say "there is a wall",
   * never "there is more room than you thought".
   */
  it('never extends a target — an HTF zone beyond it changes nothing', () => {
    const box = buildProjectionZones(
      withZones({ htfZones: [zone({ id: 'h1', lower: 1080, upper: 1090 })] }),
    ).up!;
    expect(box.target).toBe(1050);
    expect(box.cappedByHtf).toBe(false);
  });

  it('ignores an HTF zone behind the break level', () => {
    const box = buildProjectionZones(
      withZones({ htfZones: [zone({ id: 'h1', lower: 970, upper: 990 })] }),
    ).up!;
    expect(box.target).toBe(1050);
    expect(box.cappedByHtf).toBe(false);
  });

  it('caps to the NEAREST intervening HTF zone', () => {
    const box = buildProjectionZones(
      withZones({
        htfZones: [
          zone({ id: 'h1', lower: 1040, upper: 1045 }),
          zone({ id: 'h2', lower: 1020, upper: 1025 }),
        ],
      }),
    ).up!;
    expect(box.target).toBe(1020);
  });

  it('ignores a WEAK HTF zone — only STRONG/MEDIUM structure vetoes', () => {
    const box = buildProjectionZones(
      withZones({ htfZones: [zone({ id: 'h1', lower: 1030, upper: 1035, classification: 'WEAK' })] }),
    ).up!;
    expect(box.target).toBe(1050);
    expect(box.cappedByHtf).toBe(false);
  });

  /**
   * A cap that breaks the floor is not a smaller trade, it is no trade. The
   * higher timeframe saying "no room" has to be able to remove the box.
   */
  it('yields a null box when the cap pushes R:R under the floor', () => {
    const zones = buildProjectionZones(
      withZones({ htfZones: [zone({ id: 'h1', lower: 1002, upper: 1004 })] }),
    );
    expect(zones.up).toBeNull();
  });

  /**
   * "Not checked" and "checked, nothing in the way" are different claims. A
   * silently uncapped projection would present the weaker one as the stronger.
   */
  it('says so when the HTF was not consulted', () => {
    const box = buildProjectionZones(withZones({ htfZones: undefined })).up!;
    expect(box.cappedByHtf).toBe(false);
    expect(box.reason).toMatch(/1h structure was not checked/);
  });

  it('stays silent about the HTF on a timeframe that has none', () => {
    const box = buildProjectionZones(withZones({ timeframe: '1w' })).up!;
    expect(box.cappedByHtf).toBe(false);
    expect(box.reason).not.toMatch(/not checked/);
  });

  it('caps a down-break upward-in-price the same way', () => {
    const box = buildProjectionZones(
      down({
        zones: [zone({ type: 'support' }), zone({ id: 'z2', type: 'support', lower: 940, upper: 950 })],
        htfZones: [zone({ id: 'h1', lower: 965, upper: 970 })],
      }),
    ).down!;
    expect(box.target).toBe(970);
    expect(box.cappedByHtf).toBe(true);
  });
});

describe('buildProjectionZones — break state', () => {
  /**
   * A confirmed break and a merely armed one are different bets; the overlay
   * renders them differently, so the flag has to come from the detector's own
   * flip record rather than from price position.
   */
  it('reports armed until the zone records a flip', () => {
    expect(buildProjectionZones(up()).up!.state).toBe('armed');
  });

  it('reports confirmed for a zone the detector has flipped', () => {
    const flipped = zone({ type: 'support', wasType: 'resistance', flippedAt: 1_700_000_000_000 });
    expect(buildProjectionZones(up({ zones: [flipped] })).up!.state).toBe('confirmed');
  });

  /** The break a trader is looking at is the most recent one, not the oldest. */
  it('projects from the nearest broken zone, not the furthest', () => {
    const box = buildProjectionZones(
      up({ zones: [zone({ id: 'far', upper: 900, lower: 900 }), zone({ id: 'near' })] }),
    ).up!;
    expect(box.breakLevel).toBe(1000);
  });
});

describe('buildProjectionZones — honest degradation', () => {
  it('never claims a hit-rate it has not measured', () => {
    expect(buildProjectionZones(up()).up!.hitRate).toBeNull();
    expect(buildProjectionZones(down()).down!.hitRate).toBeNull();
    expect(buildProjectionZones(up()).up!.reason).toMatch(/No measured history yet/);
  });

  it('is empty when there is no zone on that side to project from', () => {
    expect(buildProjectionZones(up({ zones: [] }))).toEqual({ up: null, down: null });
    // Only a SUPPORT zone exists, so the up side has nothing to anchor on —
    // whereas a resistance ahead of price now correctly ARMS a box rather than
    // producing nothing, which is what the two armed cases above pin down.
    expect(
      buildProjectionZones(up({ zones: [zone({ type: 'support', upper: 900, lower: 890 })] })).up,
    ).toBeNull();
  });

  it('is empty without a spot or an ATR — never a box on a number it does not have', () => {
    expect(buildProjectionZones(up({ ltp: null }))).toEqual({ up: null, down: null });
    expect(buildProjectionZones(up({ atr14: null }))).toEqual({ up: null, down: null });
  });

  it('falls back to the levels snapshot for ATR', () => {
    const levels = { atr14: ATR } as unknown as LevelsSnapshot;
    expect(buildProjectionZones(up({ atr14: null, levels })).up).not.toBeNull();
  });

  /**
   * The composite must survive a malformed projection input. A pure helper that
   * can take down /chart-context is worse than one that admits it knows nothing.
   */
  it('never throws — malformed input yields empty zones', () => {
    expect(buildProjectionZones({} as never)).toEqual({ up: null, down: null });
    expect(buildProjectionZones(up({ zones: 'nope' as never }))).toEqual({ up: null, down: null });
    expect(buildProjectionZones(up({ evidence: 'nope' as never })).up).not.toBeNull();
    expect(() => buildProjectionZones(up({ htfZones: 'nope' as never }))).not.toThrow();
  });

  /** Same rule as the trade plan: no engine debug payload reaches a trader. */
  it('emits a plain sentence with no debug payload', () => {
    const box = buildProjectionZones(up()).up!;
    expect(box.reason).not.toMatch(/reject:/);
    expect(box.reason).not.toMatch(/[{}]/);
    expect(box.reason.length).toBeGreaterThan(0);
  });
});
