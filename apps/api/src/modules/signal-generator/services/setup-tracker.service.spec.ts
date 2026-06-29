import { SetupTrackerService, LockInput } from './setup-tracker.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { SetupRepository } from '../repositories/setup.repository';
import { IndicatorReadings } from '../types/setup-context.types';

type RepoMock = {
  create: jest.Mock;
  update: jest.Mock;
  findActiveByToken: jest.Mock;
  findById: jest.Mock;
};

const buildRepoMock = (): RepoMock => ({
  // Resolve sync-ish so the in-memory dbId assignment lands before the
  // first updateFromTick. randomUUID() keeps each row identifiable.
  create: jest.fn(async (data: any) => ({ id: `db_${data.symbol}_${Date.now()}`, ...data })),
  update: jest.fn(async (id: string, data: any) => ({ id, ...data })),
  findActiveByToken: jest.fn(async () => []),
  findById: jest.fn(async () => null),
});

/** Wait one microtask tick so the create() promise resolves and dbId is set. */
const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

const baseIndicators: IndicatorReadings = {
  ema9: 100,
  ema21: 99,
  rsi14: 55,
  macdHistogram: 0.5,
  bollingerPosition: 0.2,
  roc10: 1.0,
  alignment: { ema: 1, rsi: 1, macd: 1, bollinger: 1, momentum: 1 },
  agreement: 5,
};

// Use a recent IST trading-hours timestamp so sessionEnded() returns false
// during the simulated tick processing. Pick 11:00 IST on a weekday.
const nextWeekday11Ist = (): Date => {
  const now = new Date();
  // 11:00 IST = 05:30 UTC
  const utc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 5, 30, 0),
  );
  // Bump to next weekday if it lands on a weekend.
  const day = utc.getUTCDay();
  if (day === 0) utc.setUTCDate(utc.getUTCDate() + 1);
  else if (day === 6) utc.setUTCDate(utc.getUTCDate() + 2);
  return utc;
};

const buyInput = (overrides?: Partial<LockInput>): LockInput => ({
  token: 'TKN-1',
  symbol: 'NIFTY',
  exchange: 'NSE',
  side: 'BUY',
  setupType: 'BREAKOUT',
  levelType: 'PDH',
  levelValue: 100,
  entry: 100,
  stoploss: 95,
  target: 115,
  partialTakeAt: 105, // entry + slDist (= 5)
  grade: 'A',
  atr14: 10,
  indicators: baseIndicators,
  higherTimeframeTrend: null,
  regime: 'normal',
  intradayRangeRatio: 1.0,
  reason: 'test',
  ...overrides,
});

const sellInput = (overrides?: Partial<LockInput>): LockInput =>
  buyInput({
    token: 'TKN-2',
    side: 'SELL',
    levelValue: 100,
    entry: 100,
    stoploss: 105,
    target: 85,
    partialTakeAt: 95, // entry - slDist (= 5)
    ...overrides,
  });

describe('SetupTrackerService – partial-TP + trailing-SL', () => {
  let tracker: SetupTrackerService;
  let now: Date;

  beforeEach(() => {
    const stubFeed = {
      isMarketOpen: () => true,
      getQuote: () => null,
    } as unknown as MarketFeedService;
    now = nextWeekday11Ist();
    // Pin the wall clock so SetupTrackerService.lock()'s `new Date()`
    // (which we don't control) coincides with the synthetic `now` the
    // tests drive ticks with. Otherwise, when the test runs on a
    // weekend the helper bumps to Mon 11:00 IST while lock() stamps
    // createdAt at the real Sat/Sun wall clock — the gap exceeds the
    // 8 h EOD_AGE_MS and every assertion short-circuits to "EOD".
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'setTimeout', 'setInterval', 'clearImmediate', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
    jest.setSystemTime(now);
    tracker = new SetupTrackerService(stubFeed);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // The existing 9 partial-TP/trailing-SL tests construct the tracker
  // without a SetupRepository (default null injection). They are
  // unchanged: in-memory behaviour MUST keep working when persistence
  // is absent.

  it('BUY: ACTIVE → PARTIAL_BOOKED at 1×SL profit, trailingSl pinned to entry', () => {
    const setup = tracker.lock(buyInput())!;
    expect(setup.status).toBe('PENDING');
    // Trigger PENDING → ACTIVE
    tracker.updateFromTick('TKN-1', 100, now);
    expect(tracker.getActive('TKN-1')!.status).toBe('ACTIVE');
    // Reach partialTakeAt (105)
    tracker.updateFromTick('TKN-1', 105, new Date(now.getTime() + 1000));
    const after = tracker.getActive('TKN-1')!;
    expect(after.status).toBe('PARTIAL_BOOKED');
    expect(after.trailingSl).toBe(100); // break-even = entry
    expect(after.partialBookedAt).not.toBeNull();
  });

  it('BUY: PARTIAL_BOOKED ratchets trailingSl up as spot moves further in profit', () => {
    tracker.lock(buyInput());
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE
    tracker.updateFromTick('TKN-1', 105, new Date(now.getTime() + 1000)); // PARTIAL_BOOKED
    // Spot moves to 108 → trailingSl candidate = 108-5 = 103, which beats 100 (entry)
    tracker.updateFromTick('TKN-1', 108, new Date(now.getTime() + 2000));
    expect(tracker.getActive('TKN-1')!.trailingSl).toBe(103);
    // Spot moves to 112 → trailingSl candidate = 107
    tracker.updateFromTick('TKN-1', 112, new Date(now.getTime() + 3000));
    expect(tracker.getActive('TKN-1')!.trailingSl).toBe(107);
  });

  it('BUY: trailingSl never moves backward when spot retraces (only ratchets up)', () => {
    tracker.lock(buyInput());
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE
    tracker.updateFromTick('TKN-1', 105, new Date(now.getTime() + 1000)); // PARTIAL_BOOKED
    tracker.updateFromTick('TKN-1', 112, new Date(now.getTime() + 2000));
    expect(tracker.getActive('TKN-1')!.trailingSl).toBe(107);
    // Retrace to 109 — candidate would be 104, NOT allowed to drop trailingSl from 107
    tracker.updateFromTick('TKN-1', 109, new Date(now.getTime() + 3000));
    expect(tracker.getActive('TKN-1')!.trailingSl).toBe(107);
  });

  it('BUY: PARTIAL_BOOKED → TRAIL_STOPPED when spot crosses below trailingSl', () => {
    tracker.lock(buyInput());
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE
    tracker.updateFromTick('TKN-1', 105, new Date(now.getTime() + 1000)); // PARTIAL_BOOKED, trailingSl=100
    tracker.updateFromTick('TKN-1', 110, new Date(now.getTime() + 2000)); // ratchet to 105
    // Spot drops to 104 → below trailingSl (105) → TRAIL_STOPPED
    tracker.updateFromTick('TKN-1', 104, new Date(now.getTime() + 3000));
    const closed =
      tracker.getActive('TKN-1') ?? tracker.getHistory('TKN-1')[0];
    expect(closed.status).toBe('TRAIL_STOPPED');
    expect(closed.runnerExitAt).not.toBeNull();
  });

  it('BUY: PARTIAL_BOOKED → TARGET_HIT when spot reaches the original target', () => {
    tracker.lock(buyInput());
    tracker.updateFromTick('TKN-1', 100, now);
    tracker.updateFromTick('TKN-1', 105, new Date(now.getTime() + 1000)); // PARTIAL_BOOKED
    tracker.updateFromTick('TKN-1', 115, new Date(now.getTime() + 2000)); // TARGET_HIT
    const closed =
      tracker.getActive('TKN-1') ?? tracker.getHistory('TKN-1')[0];
    expect(closed.status).toBe('TARGET_HIT');
  });

  it('SELL: ACTIVE → PARTIAL_BOOKED at 1×SL profit, then trailingSl ratchets DOWN', () => {
    tracker.lock(sellInput());
    tracker.updateFromTick('TKN-2', 100, now); // ACTIVE
    // Reach partialTakeAt (95) — moves DOWN
    tracker.updateFromTick('TKN-2', 95, new Date(now.getTime() + 1000));
    let s = tracker.getActive('TKN-2')!;
    expect(s.status).toBe('PARTIAL_BOOKED');
    expect(s.trailingSl).toBe(100);
    // Spot moves to 92 → candidate = 92+5 = 97, which is BELOW 100 (entry) → ratchet
    tracker.updateFromTick('TKN-2', 92, new Date(now.getTime() + 2000));
    s = tracker.getActive('TKN-2')!;
    expect(s.trailingSl).toBe(97);
    // Spot moves to 88 → candidate = 93
    tracker.updateFromTick('TKN-2', 88, new Date(now.getTime() + 3000));
    s = tracker.getActive('TKN-2')!;
    expect(s.trailingSl).toBe(93);
    // Retrace UP to 90 — candidate = 95, NOT allowed (would be a backward move for SELL)
    tracker.updateFromTick('TKN-2', 90, new Date(now.getTime() + 4000));
    s = tracker.getActive('TKN-2')!;
    expect(s.trailingSl).toBe(93);
  });

  it('SELL: PARTIAL_BOOKED → TRAIL_STOPPED when spot crosses above trailingSl', () => {
    tracker.lock(sellInput());
    tracker.updateFromTick('TKN-2', 100, now);
    tracker.updateFromTick('TKN-2', 95, new Date(now.getTime() + 1000));
    tracker.updateFromTick('TKN-2', 90, new Date(now.getTime() + 2000)); // ratchet to 95
    // Spot pops to 96 — above trailingSl (95) → TRAIL_STOPPED
    tracker.updateFromTick('TKN-2', 96, new Date(now.getTime() + 3000));
    const closed =
      tracker.getActive('TKN-2') ?? tracker.getHistory('TKN-2')[0];
    expect(closed.status).toBe('TRAIL_STOPPED');
  });

  it('BUY: ACTIVE → STOPPED if spot hits SL before reaching partialTakeAt', () => {
    tracker.lock(buyInput());
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE
    tracker.updateFromTick('TKN-1', 95, new Date(now.getTime() + 1000));
    const closed =
      tracker.getActive('TKN-1') ?? tracker.getHistory('TKN-1')[0];
    expect(closed.status).toBe('STOPPED');
  });

  it('BUY: single-tick teleport past partialTakeAt to target → TARGET_HIT (target wins same-tick)', () => {
    tracker.lock(buyInput());
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE
    // Spot teleports straight to 116 — above both partialTakeAt (105) and target (115).
    // Target check is evaluated first inside ACTIVE, so the setup closes TARGET_HIT
    // without ever entering PARTIAL_BOOKED. This is the intended best-case outcome.
    tracker.updateFromTick('TKN-1', 116, new Date(now.getTime() + 1000));
    const closed =
      tracker.getActive('TKN-1') ?? tracker.getHistory('TKN-1')[0];
    expect(closed.status).toBe('TARGET_HIT');
    expect(closed.partialBookedAt).toBeNull();
  });
});

describe('SetupTrackerService – adaptive invalidation', () => {
  let tracker: SetupTrackerService;
  let now: Date;
  const TIMEFRAME_MS = 15 * 60 * 1000;

  beforeEach(() => {
    const stubFeed = {
      isMarketOpen: () => true,
      getQuote: () => null,
    } as unknown as MarketFeedService;
    now = nextWeekday11Ist();
    // Pin the wall clock so SetupTrackerService.lock()'s `new Date()`
    // (which we don't control) coincides with the synthetic `now` the
    // tests drive ticks with. Otherwise, when the test runs on a
    // weekend the helper bumps to Mon 11:00 IST while lock() stamps
    // createdAt at the real Sat/Sun wall clock — the gap exceeds the
    // 8 h EOD_AGE_MS and every assertion short-circuits to "EOD".
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'setTimeout', 'setInterval', 'clearImmediate', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
    jest.setSystemTime(now);
    tracker = new SetupTrackerService(stubFeed);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // As above: these adaptive-invalidation tests run the tracker without
  // a SetupRepository to keep the in-memory contract isolated.

  // ── A. Structural invalidation ──────────────────────────────

  it('A.1 BUY: MFE reaches 0.6×R then spot retraces to entry → INVALIDATED structural', () => {
    tracker.lock(buyInput());
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE
    // Push to 103 → mfe = (103-100)/5 = 0.6 R
    tracker.updateFromTick('TKN-1', 103, new Date(now.getTime() + 1000));
    expect(tracker.getActive('TKN-1')!.mfeR).toBeCloseTo(0.6, 5);
    // Drop back to 100 (entry) → retraces through entry after 0.6×R MFE
    tracker.updateFromTick('TKN-1', 100, new Date(now.getTime() + 2000));
    const closed =
      tracker.getActive('TKN-1') ?? tracker.getHistory('TKN-1')[0];
    expect(closed.status).toBe('INVALIDATED');
    expect(closed.invalidationKind).toBe('structural');
    expect(closed.invalidationReason).toMatch(/momentum failed/);
  });

  it('A.2 BUY: MFE only reaches 0.4×R, then drops — no structural invalidation, eventually hits SL', () => {
    tracker.lock(buyInput());
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE
    // Push to 102 → mfe = 0.4 R, below 0.5 trigger
    tracker.updateFromTick('TKN-1', 102, new Date(now.getTime() + 1000));
    expect(tracker.getActive('TKN-1')!.mfeR).toBeCloseTo(0.4, 5);
    // Drop back to entry — would retrace, but mfeR < 0.5 so no structural exit
    tracker.updateFromTick('TKN-1', 100, new Date(now.getTime() + 2000));
    expect(tracker.getActive('TKN-1')!.status).toBe('ACTIVE');
    // Continue down to SL at 95
    tracker.updateFromTick('TKN-1', 95, new Date(now.getTime() + 3000));
    const closed =
      tracker.getActive('TKN-1') ?? tracker.getHistory('TKN-1')[0];
    expect(closed.status).toBe('STOPPED');
    expect(closed.invalidationKind).toBeNull();
  });

  it('A.3 SELL: MFE reaches 0.6×R then spot retraces back to entry → INVALIDATED structural', () => {
    tracker.lock(sellInput());
    tracker.updateFromTick('TKN-2', 100, now); // ACTIVE
    // Push down to 97 → mfe = (100-97)/5 = 0.6 R for SELL
    tracker.updateFromTick('TKN-2', 97, new Date(now.getTime() + 1000));
    expect(tracker.getActive('TKN-2')!.mfeR).toBeCloseTo(0.6, 5);
    // Pop back up to entry (100) — retraces through entry from below
    tracker.updateFromTick('TKN-2', 100, new Date(now.getTime() + 2000));
    const closed =
      tracker.getActive('TKN-2') ?? tracker.getHistory('TKN-2')[0];
    expect(closed.status).toBe('INVALIDATED');
    expect(closed.invalidationKind).toBe('structural');
  });

  // ── B. Counter-confirmation invalidation ────────────────────

  it('B BUY active → counter SELL flag → INVALIDATED counter-setup', () => {
    tracker.lock(buyInput());
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE
    expect(tracker.getActive('TKN-1')!.status).toBe('ACTIVE');

    const closed = tracker.flagCounterSetup(
      'TKN-1',
      'SELL',
      'PDH',
      'rejection candle',
    );
    expect(closed).not.toBeNull();
    expect(closed!.status).toBe('INVALIDATED');
    expect(closed!.invalidationKind).toBe('counter-setup');
    expect(closed!.invalidationReason).toMatch(/Counter SELL setup fired on PDH/);

    // Subsequent getActive returns null — setup moved to history
    expect(tracker.getActive('TKN-1')).toBeNull();
    expect(tracker.getHistory('TKN-1')[0].status).toBe('INVALIDATED');
  });

  it('B no-op: same-side counter (BUY against active BUY) → no change, returns null', () => {
    tracker.lock(buyInput());
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE

    const result = tracker.flagCounterSetup(
      'TKN-1',
      'BUY',
      'PDH',
      'second BUY',
    );
    expect(result).toBeNull();
    // Original setup still active and untouched
    const stillActive = tracker.getActive('TKN-1');
    expect(stillActive).not.toBeNull();
    expect(stillActive!.status).toBe('ACTIVE');
    expect(stillActive!.invalidationKind).toBeNull();
  });

  // ── C. Time-based MFE stop ──────────────────────────────────

  it('C.1 BUY: 9 bars elapsed with mfeR < 0.5 → INVALIDATED time-mfe', () => {
    tracker.lock(buyInput());
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE at `now`
    // Drift the price just slightly so mfeR stays below 0.5 R (= 2.5 pts).
    // Push to 101 → mfeR = 0.2.
    tracker.updateFromTick('TKN-1', 101, new Date(now.getTime() + 1000));
    expect(tracker.getActive('TKN-1')!.mfeR).toBeCloseTo(0.2, 5);

    // Advance time by 9 × 15min = 135 minutes. Spot still 101, still
    // below SL/target/partial — only the time-MFE check should fire.
    const future = new Date(now.getTime() + 9 * TIMEFRAME_MS);
    tracker.updateFromTick('TKN-1', 101, future);

    const closed =
      tracker.getActive('TKN-1') ?? tracker.getHistory('TKN-1')[0];
    expect(closed.status).toBe('INVALIDATED');
    expect(closed.invalidationKind).toBe('time-mfe');
    expect(closed.invalidationReason).toMatch(/no follow-through/);
  });

  it('C.2 BUY: 9 bars elapsed but mfeR >= 0.5 → no time-mfe invalidation', () => {
    tracker.lock(buyInput());
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE
    // Push to 103 → mfeR = 0.6, above the 0.5 progress threshold.
    // (Don't drop back through entry — we don't want structural to fire.)
    tracker.updateFromTick('TKN-1', 103, new Date(now.getTime() + 1000));
    expect(tracker.getActive('TKN-1')!.mfeR).toBeCloseTo(0.6, 5);

    // Advance 9 bars at the same 103 spot — no retrace, mfeR stays at 0.6.
    const future = new Date(now.getTime() + 9 * TIMEFRAME_MS);
    tracker.updateFromTick('TKN-1', 103, future);
    // Setup must still be open: time-MFE shouldn't fire because mfeR
    // already cleared the progress threshold.
    const stillActive = tracker.getActive('TKN-1');
    expect(stillActive).not.toBeNull();
    expect(stillActive!.status).toBe('ACTIVE');
    expect(stillActive!.invalidationKind).toBeNull();
  });

  // ── D. PENDING short-circuit ────────────────────────────────

  it('PENDING ignored: structural / time-MFE skip until ACTIVE', () => {
    tracker.lock(buyInput());
    // Stays PENDING — spot below entry. mfeR shouldn't be touched.
    tracker.updateFromTick('TKN-1', 99, now);
    expect(tracker.getActive('TKN-1')!.status).toBe('PENDING');
    expect(tracker.getActive('TKN-1')!.mfeR).toBe(0);

    // Counter-setup flag while PENDING also no-ops (returns null).
    const counterResult = tracker.flagCounterSetup(
      'TKN-1',
      'SELL',
      'PDH',
      'flip',
    );
    expect(counterResult).toBeNull();
    // Still PENDING, untouched.
    expect(tracker.getActive('TKN-1')!.status).toBe('PENDING');

    // Advance way past TIME_MFE_BARS while still PENDING — no
    // time-mfe invalidation should fire (only kicks in on ACTIVE+).
    const future = new Date(now.getTime() + 12 * TIMEFRAME_MS);
    tracker.updateFromTick('TKN-1', 99, future);
    // EOD age cap is 8h; 12 × 15min = 3h, well under it.
    const stillPending = tracker.getActive('TKN-1');
    expect(stillPending).not.toBeNull();
    expect(stillPending!.status).toBe('PENDING');
    expect(stillPending!.invalidationKind).toBeNull();
  });
});

// ====================================================================
// Persistence — verifies the SetupRepository wiring without changing
// the in-memory contract. Tests cover the three call sites: lock(),
// close() (target/SL/EOD), and invalidate() / counter-flag.
// ====================================================================
describe('SetupTrackerService – persistence wiring', () => {
  let tracker: SetupTrackerService;
  let now: Date;
  let repo: RepoMock;

  beforeEach(() => {
    const stubFeed = {
      isMarketOpen: () => true,
      getQuote: () => null,
    } as unknown as MarketFeedService;
    repo = buildRepoMock();
    now = nextWeekday11Ist();
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'setTimeout', 'setInterval', 'clearImmediate', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
    jest.setSystemTime(now);
    tracker = new SetupTrackerService(
      stubFeed,
      repo as unknown as SetupRepository,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('lock() calls repo.create with the locked payload', async () => {
    tracker.lock(buyInput());
    await flushMicrotasks();

    expect(repo.create).toHaveBeenCalledTimes(1);
    const arg = repo.create.mock.calls[0][0];
    expect(arg.symbol).toBe('NIFTY');
    expect(arg.side).toBe('BUY');
    expect(arg.entry).toBe(100);
    expect(arg.stoploss).toBe(95);
    expect(arg.target).toBe(115);
    expect(arg.status).toBe('PENDING');
    expect(arg.grade).toBe('A');
    expect(typeof arg.token).toBe('number');
  });

  it('close() on TARGET_HIT persists closeReason=TARGET_HIT + maeR/mfeR', async () => {
    tracker.lock(buyInput());
    await flushMicrotasks();

    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE
    // Force a small adverse move first so maeR > 0 gets persisted.
    tracker.updateFromTick('TKN-1', 98, new Date(now.getTime() + 500));
    tracker.updateFromTick('TKN-1', 116, new Date(now.getTime() + 1000));
    await flushMicrotasks();

    // Find the close-time update call (last one with closeReason set).
    const closeCalls = repo.update.mock.calls.filter(
      ([, data]) => data.closeReason !== undefined && data.closeReason !== null,
    );
    expect(closeCalls.length).toBeGreaterThanOrEqual(1);
    const [, payload] = closeCalls[closeCalls.length - 1];
    expect(payload.closeReason).toBe('TARGET_HIT');
    expect(payload.status).toBe('CLOSED');
    expect(payload.mfeR).toBeGreaterThan(0);
    expect(payload.maeR).toBeGreaterThan(0);
  });

  it('invalidate() persists status=INVALIDATED + closeReason=MANUAL', async () => {
    tracker.lock(buyInput());
    await flushMicrotasks();
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE

    tracker.invalidate('TKN-1', 'user-flagged stale');
    await flushMicrotasks();

    const closeCall = repo.update.mock.calls.find(
      ([, data]) => data.closeReason === 'MANUAL',
    );
    expect(closeCall).toBeDefined();
    expect(closeCall![1].status).toBe('INVALIDATED');
    expect(closeCall![1].invalidationReason).toBe('user-flagged stale');
  });

  it('flagCounterSetup persists status=INVALIDATED + closeReason=INVALIDATED_COUNTER', async () => {
    tracker.lock(buyInput());
    await flushMicrotasks();
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE

    const closed = tracker.flagCounterSetup(
      'TKN-1',
      'SELL',
      'PDH',
      'rejection',
    );
    await flushMicrotasks();

    expect(closed).not.toBeNull();
    const closeCall = repo.update.mock.calls.find(
      ([, data]) => data.closeReason === 'INVALIDATED_COUNTER',
    );
    expect(closeCall).toBeDefined();
    expect(closeCall![1].status).toBe('INVALIDATED');
    expect(closeCall![1].invalidationKind).toBe('counter-setup');
  });

  it('repo.create failure does NOT crash the tracker — in-memory state stays intact', async () => {
    repo.create.mockRejectedValueOnce(new Error('db down'));
    const setup = tracker.lock(buyInput());
    await flushMicrotasks();

    expect(setup).not.toBeNull();
    expect(tracker.getActive('TKN-1')).not.toBeNull();
    // dbId never gets set, so subsequent updates skip silently.
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE
    tracker.updateFromTick('TKN-1', 116, new Date(now.getTime() + 1000));
    const closed =
      tracker.getActive('TKN-1') ?? tracker.getHistory('TKN-1')[0];
    expect(closed.status).toBe('TARGET_HIT');
  });

  // ── tp1Source / tp1Obstacle round-trip ────────────────────────────
  // These fields were added to SetupContext in b25104a and threaded
  // through LockInput → LockedSetup so the obstacle-aware
  // computeSlAndTarget can record WHY TP1 sits where it does. The chart
  // panel re-renders the locked TP1 on every poll until the trade
  // closes, so the field plumbing through lock → getActive must be
  // regression-safe.
  //
  // Two assertions matter:
  //   - partialTakeAt = 23980 (= obstacle nearEdge 23970 + 0.1×ATR
  //     buffer 10) survives intact on the LockedSetup returned by
  //     getActive — the panel never sees a recomputed default.
  //   - tp1Source + tp1Obstacle round-trip identically so the chart's
  //     "at MEDIUM zone · 5t" subtitle has the data it needs.
  it('persists tp1Source and tp1Obstacle across lock and re-load', async () => {
    const tp1Obstacle = {
      classification: 'MEDIUM' as const,
      touchCount: 5,
      nearEdge: 23970,
    };
    const input: LockInput = {
      ...sellInput({
        token: '99926000',
        symbol: 'NIFTY',
        entry: 24000,
        stoploss: 24050,
        target: 23900,
        partialTakeAt: 23980,
        atr14: 100,
      }),
      tp1Source: 'obstacle',
      tp1Obstacle,
    };

    const locked = tracker.lock(input);
    await flushMicrotasks();
    expect(locked).not.toBeNull();

    const reloaded = tracker.getActive('99926000');
    expect(reloaded).not.toBeNull();
    expect(reloaded!.partialTakeAt).toBe(23980);
    expect(reloaded!.tp1Source).toBe('obstacle');
    expect(reloaded!.tp1Obstacle).toEqual(tp1Obstacle);
  });
});
