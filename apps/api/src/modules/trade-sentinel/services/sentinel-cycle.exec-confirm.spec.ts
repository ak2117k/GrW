import { Logger } from '@nestjs/common';
import { FLOOR_HARD_EXIT_STAMP, SentinelCycleService, TARGET_LADDER_STAMP, type TickReading } from './sentinel-cycle.service';
import type { RosterEntry } from './roster.service';
import { parseExitDisciplineConfig } from '../../exit-discipline/config';
import type { ContractBook } from '../../exit-discipline/exec-price-confirm';
import type { LadderPlan } from '../ports/ladder-plans.port';

/**
 * EXECUTABLE-PRICE CONFIRM in the cycle (owner-approved 2026-11-23, after GOLDM27NOV26126500CE: GREEN_TO_RED fired
 * on a stale 1121.5 print under the 1144.29 floor and the MARKET SELL filled 1146.5). FLOOR_EXEC_PRICE_CONFIRM=
 * off|observe|act. The floor harness is the CRUDEOILM 9350 PE one (peak 380.4 ⇒ noise floor 376.8, entry 362.55 × 20).
 */
const USER = 'u1';
const SYMBOL = 'CRUDEOILM17NOV269350PE';
const ist = (hms: string) => new Date(`2026-10-29T${hms}+05:30`);
const REF = { exchange: 'MCX', token: '445566', symbol: SYMBOL };

const entry = (over: Partial<RosterEntry> = {}): RosterEntry => ({
  userId: USER, trackerId: 't-pe', symbol: SYMBOL, exchange: 'MCX', kind: 'POSITION', ownership: 'SENTINEL', watched: true,
  reason: 'unowned position — sentinel claims it', ...over,
});

const tick = (ltp: number, underlying: number, over: Partial<TickReading> = {}): TickReading => ({
  segment: 'OPT', side: 'LONG', entryPrice: 362.55, qty: 20, ltp, underlyingLtp: underlying, underlyingLtpAt: null,
  underlyingLtpSource: 'hub', underlyingLtpReason: null, structureSymbol: 'CRUDEOILM', nearestSupport: 9500, nearestResistance: 9620,
  structureReason: null, structureAt: null, structureSource: 'level book', holdingHigh: 380.4, holdingLow: 362.55,
  entryTime: new Date('2026-10-29T14:40:00.000Z'), expiry: '2026-11-17', volumeRatio: null, freshNewsCount: null,
  factorValues: {}, factorsReason: null, contractRef: REF,
  // No underlying noise unit: the floor break is the price-only rule (GREEN_TO_RED fires on red alone).
  noise: { contract: { n: 1.8, method: 'atr14-1m', bars: 60, at: 'x' }, underlying1m: null, reason: null },
  ...over,
});

/** A hub book received 0.5 s before the pass at `hms`. */
const hubBook = (hms: string, over: Partial<ContractBook> = {}): ContractBook => ({ bid: 377, ask: 378, volume: 5000, at: ist(hms).getTime() - 500, source: 'hub', ...over });

function makeSvc(opts: { entries?: RosterEntry[]; restBook?: jest.Mock | null; ladder?: LadderPlan } = {}) {
  const build = jest.fn().mockResolvedValue(opts.entries ?? [entry()]);
  const evaluate = jest.fn().mockReturnValue({ fires: [], heartbeat: false, shouldEvaluate: false, trigger: null });
  const buildPacket = jest.fn().mockImplementation((_e, t) =>
    Promise.resolve({ position: {}, money: { netPnl: 1, greenFloorPrice: t.noiseFloor?.level ?? null, greenFloorArmed: !!t.noiseFloor?.armed, ...(t.ladder ? { ladder: t.ladder } : {}) } }));
  const judge = jest.fn();
  const record = jest.fn().mockResolvedValue({});
  const recentForTracker = jest.fn().mockResolvedValue([]);
  const tickFor = jest.fn();
  const restBook = opts.restBook === undefined ? jest.fn().mockResolvedValue(null) : opts.restBook;
  const ticks = restBook ? { tickFor, restBook } : { tickFor };
  const reader = opts.ladder ? { mode: 'on' as const, planFor: jest.fn().mockResolvedValue(opts.ladder) } : undefined;
  const svc = new SentinelCycleService(
    { build } as never, { evaluate } as never, { build: buildPacket } as never,
    { ensureFor: jest.fn().mockResolvedValue({ direction: 'SHORT', reason: 'x', levelPrice: 1, targetPrice: 1, invalidation: 1, source: 'INFERRED' }) } as never,
    { judge, promptVersion: 'v9/t1' } as never, { record, recentForTracker } as never,
    { captureAndCompare: jest.fn().mockResolvedValue({ now: null, prev: null }) } as never, ticks as never,
    undefined, opts.ladder ? undefined : parseExitDisciplineConfig({}), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, reader,
  );
  const pass = async (hms: string, t: TickReading, at: (hms: string) => Date = ist) => {
    tickFor.mockResolvedValueOnce(t);
    return svc.runForUser(USER, at(hms));
  };
  return { svc, record, judge, restBook, pass, warn: Logger.prototype.warn as jest.Mock };
}

const rows = (record: jest.Mock, stamp: string) => record.mock.calls.map((c) => c[0]).filter((r) => r.promptVersion === stamp);
const floorRows = (record: jest.Mock) => rows(record, FLOOR_HARD_EXIT_STAMP);
const warned = (pattern: RegExp) => (Logger.prototype.warn as jest.Mock).mock.calls.some((c) => pattern.test(String(c[0])));

describe('SentinelCycleService — executable-price confirm (FLOOR_EXEC_PRICE_CONFIRM)', () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    delete process.env.FLOOR_EXEC_PRICE_CONFIRM;
    delete process.env.HARD_LOSS_EXIT_RUPEES;
    process.env.PROFIT_LOCK_ARM_RUPEES = '0';
  });
  afterEach(() => {
    process.env = { ...ENV };
    jest.restoreAllMocks();
  });

  /** Arm the floor (peak 380.4 ⇒ floor 376.8), then two GREEN_TO_RED reads at a stale 364 print. */
  const greenToRed = async (t: ReturnType<typeof makeSvc>, book1: ContractBook | null, book2: ContractBook | null) => {
    await t.pass('21:00:00', tick(380.4, 9531));
    await t.pass('21:20:00', tick(364, 9545, book1 ? { contractBook: book1 } : {}));
    await t.pass('21:20:30', tick(364, 9545, book2 ? { contractBook: book2 } : {}));
  };

  describe('act', () => {
    beforeEach(() => {
      process.env.FLOOR_EXEC_PRICE_CONFIRM = 'act';
    });

    it('the 2026-11-23 shape: the bid is above the floor ⇒ HOLD, STALE_PRINT_HELD logged, no REST call, the run starts over', async () => {
      const t = makeSvc();
      await greenToRed(t, hubBook('21:20:00'), hubBook('21:20:30'));
      expect(floorRows(t.record)).toHaveLength(0);
      expect(t.restBook).not.toHaveBeenCalled();
      expect(warned(/STALE_PRINT_HELD — CRUDEOILM17NOV269350PE .*GREEN_TO_RED not fired: ltp 364, bid 377, floor 376\.8/)).toBe(true);
      // The confirm memo was reset: the next tripping read is a FIRST read again (no fire), the one after confirms.
      await t.pass('21:21:00', tick(363.8, 9546, { contractBook: hubBook('21:21:00', { bid: 363 }) }));
      expect(floorRows(t.record)).toHaveLength(0);
      await t.pass('21:21:30', tick(363.8, 9546, { contractBook: hubBook('21:21:30', { bid: 363 }) }));
      expect(floorRows(t.record)).toHaveLength(1);
    });

    it('the bid is below the floor and net red there ⇒ GREEN_TO_RED fires, the reason unchanged', async () => {
      const t = makeSvc();
      await greenToRed(t, hubBook('21:20:00', { bid: 363 }), hubBook('21:20:30', { bid: 363 }));
      const r = floorRows(t.record);
      expect(r).toHaveLength(1);
      expect(r[0].reason).toMatch(/GREEN_TO_RED: premium 364 below the armed floor 376\.8 and net ₹-?\d+ — the trade turned red$/);
    });

    it('the bid under the floor but net green there (the green-lock case) still fires', async () => {
      const t = makeSvc();
      await greenToRed(t, hubBook('21:20:00', { bid: 372 }), hubBook('21:20:30', { bid: 372 }));
      expect(floorRows(t.record)).toHaveLength(1);
    });

    it('a stale hub book (> 3 s) is not used: ONE REST read decides (bid above the floor ⇒ hold)', async () => {
      const restBook = jest.fn().mockResolvedValue({ bid: 377.5, ask: 378, volume: 5000, at: 0, source: 'rest' });
      const t = makeSvc({ restBook });
      await greenToRed(t, hubBook('21:20:00', { at: ist('21:20:00').getTime() - 4000 }), hubBook('21:20:30', { at: ist('21:20:30').getTime() - 4000 }));
      expect(restBook).toHaveBeenCalledTimes(1);
      expect(restBook).toHaveBeenCalledWith(USER, REF);
      expect(floorRows(t.record)).toHaveLength(0);
    });

    it('a REST bid below the floor fires', async () => {
      const restBook = jest.fn().mockResolvedValue({ bid: 363, ask: 364, volume: 5000, at: 0, source: 'rest' });
      const t = makeSvc({ restBook });
      await greenToRed(t, null, null);
      expect(restBook).toHaveBeenCalledTimes(1);
      expect(floorRows(t.record)).toHaveLength(1);
    });

    it('no book anywhere: the day volume ROSE between the confirming reads ⇒ fires', async () => {
      const t = makeSvc();
      await greenToRed(t, hubBook('21:20:00', { bid: null, ask: null, volume: 5000 }), hubBook('21:20:30', { bid: null, ask: null, volume: 5014 }));
      expect(t.restBook).toHaveBeenCalledTimes(1);
      expect(floorRows(t.record)).toHaveLength(1);
    });

    it('no book anywhere: the volume is FLAT (the same print read twice) ⇒ holds', async () => {
      const t = makeSvc();
      await greenToRed(t, hubBook('21:20:00', { bid: null, ask: null, volume: 5000 }), hubBook('21:20:30', { bid: null, ask: null, volume: 5000 }));
      expect(floorRows(t.record)).toHaveLength(0);
      expect(warned(/STALE_PRINT_HELD .*volume 5000 → 5000 flat/)).toBe(true);
    });

    it('nothing known (no book, no volume, the REST read failing) ⇒ fires: today\'s LTP behaviour', async () => {
      const restBook = jest.fn().mockRejectedValue(new Error('broker down'));
      const t = makeSvc({ restBook });
      await greenToRed(t, null, null);
      expect(floorRows(t.record)).toHaveLength(1);
    });

    it('a tick source without restBook and no hub book ⇒ fires (fail toward exiting)', async () => {
      const t = makeSvc({ restBook: null });
      await greenToRed(t, null, null);
      expect(floorRows(t.record)).toHaveLength(1);
    });

    it('MAX_LOSS is untouched: a bid far above the loss still exits by the hard loss rule', async () => {
      process.env.HARD_LOSS_EXIT_RUPEES = '200';
      process.env.HARD_LOSS_BY_TRADE_VALUE = 'off';
      process.env.HARD_LOSS_NOISE_N = '0';
      const t = makeSvc();
      await t.pass('21:00:00', tick(380.4, 9531));
      // net ≈ (350 − 362.55) × 20 ≈ −₹251 − charges: past −₹200. The "book" says 377 — ignored by MAX_LOSS.
      await t.pass('21:20:00', tick(350, 9545, { contractBook: hubBook('21:20:00') }));
      await t.pass('21:20:30', tick(350, 9545, { contractBook: hubBook('21:20:30') }));
      const r = floorRows(t.record);
      expect(r).toHaveLength(1);
      expect(r[0].reason).toMatch(/MAX_LOSS/);
      expect(t.restBook).not.toHaveBeenCalled();
    });

    it('a paper trade is exactly as before (no book read, no hold)', async () => {
      const t = makeSvc({ entries: [entry({ trackerId: 'paper:pt-1' })] });
      await greenToRed(t, hubBook('21:20:00'), hubBook('21:20:30'));
      expect(floorRows(t.record)).toHaveLength(1);
      expect(t.restBook).not.toHaveBeenCalled();
    });
  });

  describe('observe (the default)', () => {
    it('changes nothing — the exit fires — but writes the hold it WOULD have made on the verdict', async () => {
      const t = makeSvc();
      await greenToRed(t, hubBook('21:20:00'), hubBook('21:20:30'));
      const r = floorRows(t.record);
      expect(r).toHaveLength(1);
      expect(r[0].reason).toMatch(/the trade turned red \[exec-confirm observe: WOULD HOLD — ltp 364 but exec 377 \(hub book\) is not through the floor 376\.8 — stale print\]$/);
    });

    it('a book that confirms leaves the reason exactly as today', async () => {
      const t = makeSvc();
      await greenToRed(t, hubBook('21:20:00', { bid: 363 }), hubBook('21:20:30', { bid: 363 }));
      expect(floorRows(t.record)[0].reason).toMatch(/the trade turned red$/);
    });
  });

  describe('off', () => {
    it('byte-for-byte today: no book read, the same verdict row as with no confirm at all', async () => {
      process.env.FLOOR_EXEC_PRICE_CONFIRM = 'off';
      const t = makeSvc();
      await greenToRed(t, hubBook('21:20:00'), hubBook('21:20:30'));
      const withBook = floorRows(t.record);
      expect(withBook).toHaveLength(1);
      expect(t.restBook).not.toHaveBeenCalled();
      const plain = makeSvc({ restBook: null });
      await greenToRed(plain, null, null);
      const without = floorRows(plain.record);
      expect(withBook[0].reason).toBe(without[0].reason);
      expect({ ...withBook[0], packet: undefined }).toEqual({ ...without[0], packet: undefined });
    });
  });

  describe('TARGET_LADDER trail stop', () => {
    const NIFTY = 'NIFTY04NOV2625000CE';
    const at = (hms: string) => new Date(`2026-11-04T${hms}+05:30`);
    const PLAN: LadderPlan = { targets: [120, 140], riskStop: 90, source: 'signal', detail: 'T 120 / 140' };
    const lt = (ltp: number, high: number, over: Partial<TickReading> = {}): TickReading => ({
      ...tick(ltp, 25010), entryPrice: 100, qty: 75, holdingHigh: high, holdingLow: 98, structureSymbol: 'NIFTY', noise: null,
      contractRef: { exchange: 'NFO', token: '777', symbol: NIFTY }, ...over,
    });
    const ladderBook = (hms: string, bid: number | null, ask: number | null = null, volume: number | null = 9000): ContractBook =>
      ({ bid, ask, volume, at: at(hms).getTime() - 500, source: 'hub' });
    const ladderSvc = (side: 'LONG' | 'SHORT' = 'LONG') =>
      makeSvc({ entries: [entry({ symbol: NIFTY, exchange: 'NFO', trackerId: 't-ce' })], ladder: side === 'LONG' ? PLAN : { ...PLAN, targets: [80, 60] } });
    const ladderRows = (record: jest.Mock) => rows(record, TARGET_LADDER_STAMP);

    beforeEach(() => {
      process.env.FLOOR_EXEC_PRICE_CONFIRM = 'act';
    });

    it('T1 reached ⇒ stop at the entry 100; LTP 99 but the bid 100.5 ⇒ HOLD', async () => {
      const t = ladderSvc();
      await t.pass('10:00:00', lt(121, 121), at);
      await t.pass('10:05:00', lt(99.5, 121, { contractBook: ladderBook('10:05:00', 100.5) }), at);
      await t.pass('10:05:30', lt(99, 121, { contractBook: ladderBook('10:05:30', 100.5) }), at);
      expect(ladderRows(t.record)).toHaveLength(0);
      expect(warned(/\[target-ladder\] STALE_PRINT_HELD — NIFTY04NOV2625000CE .*TARGET_TRAIL not fired: ltp 99, bid 100\.5, ladder stop 100/)).toBe(true);
    });

    it('the bid through the stop ⇒ fires', async () => {
      const t = ladderSvc();
      await t.pass('10:00:00', lt(121, 121), at);
      await t.pass('10:05:00', lt(99.5, 121, { contractBook: ladderBook('10:05:00', 99) }), at);
      await t.pass('10:05:30', lt(99, 121, { contractBook: ladderBook('10:05:30', 98.9) }), at);
      expect(ladderRows(t.record)).toHaveLength(1);
    });

    it('a short is re-priced at the ASK (the bid is ignored)', async () => {
      const t = ladderSvc('SHORT');
      const s = (ltp: number, low: number, b: ContractBook | null) => lt(ltp, 102, { side: 'SHORT', holdingLow: low, ...(b ? { contractBook: b } : {}) });
      await t.pass('10:00:00', s(79, 79, null), at);
      // Stop at the entry 100: LTP 100.5 crosses it; the ask 99.5 does not (bid 101 would have).
      await t.pass('10:05:00', s(100.5, 79, ladderBook('10:05:00', 101, 99.5)), at);
      await t.pass('10:05:30', s(100.5, 79, ladderBook('10:05:30', 101, 99.5)), at);
      expect(ladderRows(t.record)).toHaveLength(0);
      expect(warned(/TARGET_TRAIL not fired: ltp 100\.5, ask 99\.5, ladder stop 100/)).toBe(true);
    });

    it('the last target reached (a take-profit, not a stop) is never re-priced', async () => {
      const t = ladderSvc();
      await t.pass('10:00:00', lt(141, 141, { contractBook: ladderBook('10:00:00', 120) }), at);
      await t.pass('10:00:30', lt(141, 141, { contractBook: ladderBook('10:00:30', 120) }), at);
      expect(ladderRows(t.record)).toHaveLength(1);
      expect(t.restBook).not.toHaveBeenCalled();
    });
  });
});
