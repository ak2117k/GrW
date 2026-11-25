import {
  FLOOR_REPLAY_NEW_CEILINGS,
  FLOOR_REPLAY_OLD_ENV,
  replayFixture,
  replayTrade,
  type FloorFixtureRow,
  type RawBar,
} from '../../../scripts/floor-replay';

/**
 * Desk plan 1, Task 2 — the floor replay on tiny synthetic 15-minute paths. NIFTY CE, 75 qty LONG @ 100.
 * With charges, net −₹2,000 sits near 73.9 and net −₹5,000 near 33.9 (the INDEX_OPT ceiling).
 */
const MIN = 60_000;
const M15 = 15 * MIN;
// 2026-11-20 (Fri) 09:30 IST = 04:00 UTC: a 15-minute bucket start on the NSE grid.
const T0 = Date.parse('2026-11-20T04:00:00.000Z');
const SYMBOL = 'NIFTY24NOV2626000CE';
const FLOOR_REASON = 'FLOOR_HARD_EXIT (code rule, not a judgement) MAX_LOSS: net ₹-2010 reached the hard loss exit of ₹2000';

const oldEnv = { ...FLOOR_REPLAY_OLD_ENV };
const newEnv = { ...FLOOR_REPLAY_OLD_ENV, HARD_LOSS_CEILING_BY_CLASS: FLOOR_REPLAY_NEW_CEILINGS };

/** One 1-minute bar per 15-minute bucket carries the bucket's whole OHLC (the replay rolls 1m → 15m). */
const contract = (ohlc: Array<[number, number, number, number]>): RawBar[] => ohlc.map(([o, h, l, c], k) => [T0 + k * M15, o, h, l, c]);
/** The underlying, one 1-minute bar per minute, flat at `level` unless `moves` sets a bucket's level. */
function underlying1m(buckets: number, level: number, moves: Record<number, number> = {}): RawBar[] {
  const out: RawBar[] = [];
  for (let m = -125; m < buckets * 15; m++) {
    const k = Math.floor(m / 15);
    const u = moves[k] ?? level;
    out.push([T0 + m * MIN, u, u + 1, u - 1, u]);
  }
  return out;
}
/** 20 prior 15m buckets with a 30-point range: N15 = 30. */
function underlying15m(level: number): RawBar[] {
  const out: RawBar[] = [];
  // The day before (Thu 2026-11-19) from 09:15 IST: 20 session buckets.
  const thu = Date.parse('2026-11-19T03:45:00.000Z');
  for (let k = 0; k < 20; k++) out.push([thu + k * M15, level, level + 15, level - 15, level]);
  return out;
}

function row(over: Partial<FloorFixtureRow> & { bars: Array<[number, number, number, number]> }): FloorFixtureRow {
  const { bars, ...rest } = over;
  return {
    trackerId: 'trk1',
    symbol: SYMBOL,
    exchange: 'NFO',
    token: '111',
    name: 'NIFTY',
    qty: 75,
    lotSize: 75,
    entryTime: new Date(T0).toISOString(),
    entryPrice: 100,
    exitTime: new Date(T0 + 2 * M15 - 5 * MIN).toISOString(),
    exitPrice: 73.9,
    exitReason: { status: 'FILLED', reason: FLOOR_REASON, at: new Date(T0 + 2 * M15 - 5 * MIN).toISOString(), fillPrice: 73.9 },
    signal: { decisionId: 'd1', side: 'BUY', targets: [130], sl: 80, source: 'signal' },
    underlyingRef: { exchange: 'NSE', token: '99926000' },
    contract1m: contract(bars),
    underlying1m: underlying1m(bars.length, 26000),
    underlying15m: underlying15m(26000),
    ...rest,
  };
}

const opts = { oldEnv, newEnv, hold: [] as string[] };

describe('floor replay — ₹2k rule (old) vs the catastrophe floor (new), on 15-minute bars', () => {
  it('a ₹2k cut inside noise that recovers is CUT_THEN_RECOVERED', () => {
    const r = replayTrade(row({
      bars: [
        [100, 102, 95, 98],
        [98, 99, 70, 75], // old: −₹2,000 touched (plain INDEX rule); new: underlying flat (0 N15) ⇒ HOLD_UNDER_N, cap not touched
        [75, 90, 72, 88],
        [88, 101, 87, 100], // back to entry
      ],
    }), opts);
    expect(r.status).toBe('COUNTED');
    if (r.status !== 'COUNTED') return;
    expect(r.old.kind).toBe('FLOOR');
    expect(r.old.bar).toBe(1);
    expect(r.old.net).toBeLessThan(-1990);
    expect(r.old.net).toBeGreaterThan(-2010);
    expect(r.new.kind).not.toBe('FLOOR');
    expect(r.tag).toBe('CUT_THEN_RECOVERED');
    expect(r.recoveredBar).toBe(3);
  });

  it('a gap through the ceiling exits at the bar\'s open and is NEW_LOSES_MORE', () => {
    const r = replayTrade(row({
      bars: [
        [100, 102, 95, 98],
        [98, 99, 72, 74], // old cut here
        [20, 25, 15, 22], // opens 20, below the −₹5,000 price (~33.9): the new floor exits AT THE OPEN
        [22, 60, 21, 55],
      ],
    }), opts);
    expect(r.status).toBe('COUNTED');
    if (r.status !== 'COUNTED') return;
    expect(r.old.bar).toBe(1);
    expect(r.new.kind).toBe('FLOOR');
    expect(r.new.bar).toBe(2);
    expect(r.new.price).toBe(20);
    expect(r.new.band).toBe('CAP');
    expect(r.new.net).toBeLessThan(-5000);
    expect(r.tag).toBe('NEW_LOSES_MORE');
  });

  it('no look-ahead: a recovery in or after the new floor bar does not count, and later bars never move an earlier decision', () => {
    const bars: Array<[number, number, number, number]> = [
      [100, 102, 95, 98],
      [98, 99, 72, 74], // old cut
      [74, 101, 30, 40], // touches the ceiling AND entry in one bar ⇒ the floor (conservative)
      [40, 140, 39, 135], // recovers to entry and the target after the floor
    ];
    const full = replayTrade(row({ bars }), opts);
    expect(full.status).toBe('COUNTED');
    if (full.status !== 'COUNTED') return;
    expect(full.new.kind).toBe('FLOOR');
    expect(full.new.bar).toBe(2);
    expect(full.recoveredBar).toBeNull();
    expect(full.tag).toBe('NEW_LOSES_MORE');

    // Prefix invariance: cut the path after the floor bar — the decisions are identical.
    const prefix = replayTrade(row({ bars: bars.slice(0, 3) }), opts);
    if (prefix.status !== 'COUNTED') throw new Error('prefix not counted');
    expect(prefix.old).toEqual(full.old);
    expect(prefix.new).toEqual(full.new);
  });

  it('the band decides on 15m closes with N15: 3.3 × N15 against at a −₹2k close exits there (BAND_UNDERLYING)', () => {
    const r0 = row({ bars: [[100, 102, 95, 98], [98, 99, 72, 73], [73, 80, 70, 78]] });
    // NIFTY 100 points down in bucket 1 (N15 = 30 ⇒ 3.33 N15 against a long CE).
    const r = replayTrade({ ...r0, underlying1m: underlying1m(3, 26000, { 1: 25900, 2: 25900 }) }, opts);
    if (r.status !== 'COUNTED') throw new Error('not counted');
    expect(r.new.kind).toBe('FLOOR');
    expect(r.new.bar).toBe(1);
    expect(r.new.band).toBe('BAND_UNDERLYING');
    expect(r.new.price).toBe(73);
    expect(r.n15AtEntry).toBe(30);
  });

  it('the old rule is today\'s prod config: GOLD option plain ₹7,500, NIFTY option plain ₹2,000', () => {
    const r = replayTrade(row({ bars: [[100, 102, 95, 98]] }), opts);
    if (r.status !== 'COUNTED') throw new Error('not counted');
    expect(r.oldCfg).toEqual({ limit: 2000, cap: 2000, band: false });
    expect(r.newCfg).toEqual({ limit: 2000, cap: 5000, band: true });
    const g = replayTrade(row({ bars: [[100, 102, 95, 98]], symbol: 'GOLD26DEC25130000CE', exchange: 'MCX', name: 'GOLD', qty: 1, lotSize: 1, underlyingRef: { exchange: 'MCX', token: '2' } }), opts);
    if (g.status !== 'COUNTED') throw new Error('not counted');
    expect(g.oldCfg).toEqual({ limit: 7500, cap: 7500, band: false });
    expect(g.newCfg).toEqual({ limit: 2000, cap: 7500, band: true });
  });

  it('a HOLD-list trade and a manual trade are excluded, listed, and not counted', () => {
    const bars: Array<[number, number, number, number]> = [[100, 102, 95, 98], [98, 99, 70, 75]];
    const held = row({ bars, trackerId: 'trkHold', symbol: 'MAZDOCK29DEC261760PE', name: 'MAZDOCK', underlyingRef: { exchange: 'NSE', token: '1' } });
    const manual = row({ bars, trackerId: 'trkManual', signal: null });
    const counted = row({ bars, trackerId: 'trkCounted' });
    const out = replayFixture([held, manual, counted], { ...opts, hold: ['MAZDOCK29DEC261760PE'] });
    expect(out.excluded.map((e) => [e.row.trackerId, e.reason])).toEqual([['trkHold', 'HOLD'], ['trkManual', 'MANUAL']]);
    expect(out.counted.map((c) => c.row.trackerId)).toEqual(['trkCounted']);
    expect(out.summary.total.count).toBe(1);
  });
});
