import {
  EXEC_BOOK_MAX_AGE_MS, contractBookOf, execConfirm, execHolds, execPriceOf, floorReadingAtExec, freshHubBook, ladderTrailTripsAt, parseExecConfirmMode,
  type ContractBook,
} from './exec-price-confirm';
import type { HardFloorInput } from './hard-floor';

/**
 * Prod 2026-11-23 10:51 IST, the owner's real GOLDM27NOV26126500CE long: floor armed 1144.29, FLOOR_HARD_EXIT
 * GREEN_TO_RED fired on a stale last trade 1121.5 (volume 14 that minute, both confirming reads saw the same
 * print); the MARKET SELL filled 1146.5. The bid was the only price that showed the floor had not broken.
 */
const NOW = Date.parse('2026-11-23T05:21:20.000Z');
const book = (over: Partial<ContractBook> = {}): ContractBook => ({ bid: 1146.5, ask: 1149, volume: 1234, at: NOW - 1000, source: 'hub', ...over });

/** GOLDM long CE (BULLISH exposure). The GREEN_TO_RED read at the stale print 1121.5. */
const GOLDM: HardFloorInput = {
  side: 'LONG', exposure: 'BULLISH', ltp: 1121.5, floor: { price: 1144.29, armed: true },
  netPnl: -120, underlying: 126480, bestUnderlying: 126520, nUnderlying: 30, k: 2, lockGreen: true, noise: null, noiseConfirmN: 0,
};

describe('parseExecConfirmMode (FLOOR_EXEC_PRICE_CONFIRM)', () => {
  it('defaults to observe; off / act exactly; a typo stays observe and is reported', () => {
    expect(parseExecConfirmMode(undefined)).toEqual({ mode: 'observe', problem: null });
    expect(parseExecConfirmMode('  ')).toEqual({ mode: 'observe', problem: null });
    expect(parseExecConfirmMode('off').mode).toBe('off');
    expect(parseExecConfirmMode('OBSERVE').mode).toBe('observe');
    expect(parseExecConfirmMode('act').mode).toBe('act');
    const typo = parseExecConfirmMode('acts');
    expect(typo.mode).toBe('observe');
    expect(typo.problem).toMatch(/FLOOR_EXEC_PRICE_CONFIRM=acts/);
  });
});

describe('contractBookOf', () => {
  it('takes the best bid / ask (best first) and the day volume; 0 / missing is null', () => {
    const depth = { bids: [{ price: 1146.5 }, { price: 1146 }], asks: [{ price: 1149 }] };
    expect(contractBookOf(depth, 1234, NOW, 'hub')).toEqual({ bid: 1146.5, ask: 1149, volume: 1234, at: NOW, source: 'hub' });
    expect(contractBookOf({ bids: [], asks: [{ price: 1149 }] }, 0, NOW, 'rest')).toEqual({ bid: null, ask: 1149, volume: null, at: NOW, source: 'rest' });
    expect(contractBookOf(undefined, 1234, NOW, 'hub')).toEqual({ bid: null, ask: null, volume: 1234, at: NOW, source: 'hub' });
    expect(contractBookOf(undefined, 0, NOW, 'hub')).toBeNull();
  });
});

describe('execPriceOf', () => {
  it('a long sells at the best bid, a short buys back at the best ask', () => {
    expect(execPriceOf('LONG', book())).toBe(1146.5);
    expect(execPriceOf('SHORT', book())).toBe(1149);
  });
  it('a missing, zero or non-finite side is no price', () => {
    expect(execPriceOf('LONG', book({ bid: 0 }))).toBeNull();
    expect(execPriceOf('LONG', book({ bid: null }))).toBeNull();
    expect(execPriceOf('SHORT', book({ ask: Number.NaN }))).toBeNull();
    expect(execPriceOf('LONG', null)).toBeNull();
  });
});

describe('freshHubBook', () => {
  it('uses the hub book only when received ≤ 3 s ago and it has the side\'s price', () => {
    expect(freshHubBook('LONG', book({ at: NOW - EXEC_BOOK_MAX_AGE_MS }), NOW)).not.toBeNull();
    expect(freshHubBook('LONG', book({ at: NOW - EXEC_BOOK_MAX_AGE_MS - 1 }), NOW)).toBeNull();
    expect(freshHubBook('LONG', book({ bid: 0 }), NOW)).toBeNull();
    expect(freshHubBook('SHORT', book({ bid: 0 }), NOW)).not.toBeNull();
    expect(freshHubBook('LONG', null, NOW)).toBeNull();
  });
});

describe('floorReadingAtExec', () => {
  const netAt = (px: number) => Math.round((px - 1135) * 10 - 30); // 10 units of premium, ₹30 charges

  it('today\'s GOLDM numbers: bid 1146.5 ≥ floor 1144.29 ⇒ no trip at the executable price', () => {
    const r = floorReadingAtExec(GOLDM, 1146.5, netAt(1146.5));
    expect(r.trip).toBe(false);
    expect(execConfirm({ execPrice: 1146.5, source: 'hub', tripsAtExec: r.trip, volumeBefore: 1220, volumeNow: 1220 }))
      .toMatchObject({ fire: false, basis: 'STALE_PRINT', execPrice: 1146.5 });
  });

  it('bid below the floor and net red at the bid ⇒ GREEN_TO_RED stands', () => {
    const r = floorReadingAtExec(GOLDM, 1130, netAt(1130));
    expect(r).toMatchObject({ trip: true, rule: 'GREEN_TO_RED' });
  });

  it('GREEN_TO_RED at the print but net green at the bid (still under the floor) ⇒ the existing green-lock case', () => {
    expect(floorReadingAtExec(GOLDM, 1143, netAt(1143))).toMatchObject({ trip: true, rule: 'FLOOR_BREAK_GREEN' });
    // Green lock off and no K·N move: today's code would not sell a green break — nor does the bid read.
    expect(floorReadingAtExec({ ...GOLDM, lockGreen: false }, 1143, netAt(1143)).trip).toBe(false);
  });

  it('a short is re-read at the ask: ask ≤ floor holds, ask > floor trips', () => {
    const short: HardFloorInput = { ...GOLDM, side: 'SHORT', exposure: 'BEARISH', ltp: 1150, floor: { price: 1140, armed: true }, netPnl: -50 };
    expect(floorReadingAtExec(short, 1139.5, -10).trip).toBe(false);
    expect(floorReadingAtExec(short, 1141, -60)).toMatchObject({ trip: true, rule: 'GREEN_TO_RED' });
  });
});

describe('ladderTrailTripsAt', () => {
  it('re-prices the trail stop crossing at the executable price, the rule\'s own comparison', () => {
    expect(ladderTrailTripsAt('LONG', 1144.29, 1146.5)).toBe(false);
    expect(ladderTrailTripsAt('LONG', 1144.29, 1144)).toBe(true);
    expect(ladderTrailTripsAt('SHORT', 300, 299)).toBe(false);
    expect(ladderTrailTripsAt('SHORT', 300, 301)).toBe(true);
  });
});

describe('execConfirm', () => {
  it('a book that confirms the trip fires', () => {
    expect(execConfirm({ execPrice: 1130, source: 'rest', tripsAtExec: true, volumeBefore: null, volumeNow: null }))
      .toEqual({ fire: true, basis: 'BOOK_CONFIRMS', execPrice: 1130, source: 'rest', volumeBefore: null, volumeNow: null });
  });

  it('no book: the day volume rose between the confirming reads ⇒ fires', () => {
    expect(execConfirm({ execPrice: null, source: null, tripsAtExec: null, volumeBefore: 1220, volumeNow: 1234 }))
      .toMatchObject({ fire: true, basis: 'VOLUME_ROSE' });
  });

  it('no book: the volume is flat (the same stale print read twice) ⇒ holds', () => {
    expect(execConfirm({ execPrice: null, source: null, tripsAtExec: null, volumeBefore: 1220, volumeNow: 1220 }))
      .toMatchObject({ fire: false, basis: 'VOLUME_FLAT' });
  });

  it('nothing known (no book, no volume, or a 0 "not reported" volume) ⇒ fires: today\'s LTP behaviour', () => {
    for (const [b, n] of [[null, null], [1220, null], [null, 1220], [0, 0]] as const) {
      expect(execConfirm({ execPrice: null, source: null, tripsAtExec: null, volumeBefore: b, volumeNow: n })).toMatchObject({ fire: true, basis: 'UNKNOWN' });
    }
  });
});

describe('execHolds', () => {
  const held = execConfirm({ execPrice: 1146.5, source: 'hub', tripsAtExec: false, volumeBefore: null, volumeNow: null });
  const fired = execConfirm({ execPrice: 1130, source: 'hub', tripsAtExec: true, volumeBefore: null, volumeNow: null });
  it('only act mode holds; observe and off never change the exit', () => {
    expect(execHolds('act', held)).toBe(true);
    expect(execHolds('observe', held)).toBe(false);
    expect(execHolds('off', held)).toBe(false);
    expect(execHolds('act', fired)).toBe(false);
    expect(execHolds('act', null)).toBe(false);
  });
});
