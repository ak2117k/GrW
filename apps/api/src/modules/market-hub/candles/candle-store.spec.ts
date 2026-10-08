import type { GovRequest, GovResult } from '../governor';
import { LANE, type InstrumentRef, type Lane } from '../hub.types';
import { SessionClock } from '../session-clock';
import { MemoryCandleRepo } from '../testing/memory-candle-repo';
import type { BrokerInterval, HubCandle } from './candle.types';
import { CandleStore } from './candle-store';
import { addDays, istMidnight } from './trading-calendar';

const ist = (s: string) => Date.parse(`${s}+05:30`);
const REF: InstrumentRef = { exchange: 'NSE', token: '2885', symbol: 'RELIANCE' };
const clock = new SessionClock({
  holidays: { 2026: [{ date: '2026-10-02', name: 'Gandhi Jayanti', exchanges: ['NSE', 'BSE', 'NFO', 'MCX'] }] },
});

/** NSE 1-minute bars on `ymd` for IST minutes [fromMin, toMin). */
function minutes(ymd: string, fromMin = 555, toMin = 930): HubCandle[] {
  const out: HubCandle[] = [];
  for (let m = fromMin; m < toMin; m++) {
    out.push({ ts: istMidnight(ymd) + m * 60_000, open: 100, high: 101, low: 99, close: 100, volume: 1 });
  }
  return out;
}

function setup(
  opts: {
    budget?: number;
    result?: (req: GovRequest<HubCandle[]>) => GovResult<HubCandle[]> | null;
    /** Hold Background-lane calls until release() so a test can read before they land. */
    holdBackground?: boolean;
    /** Coalesce identical keys while in flight, like the real Governor (regardless of lane). */
    coalesce?: boolean;
  } = {},
) {
  let now = ist('2026-10-07T16:00:00');
  const repo = new MemoryCandleRepo();
  const calls: Array<{ interval: BrokerInterval; from: Date; to: Date }> = [];
  const lanes: Lane[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let respond: (interval: BrokerInterval, from: Date, to: Date) => HubCandle[] = () => [];
  let fetchGate: Promise<void> | null = null;
  const fetch = async (_ref: InstrumentRef, interval: BrokerInterval, from: Date, to: Date) => {
    calls.push({ interval, from, to });
    if (fetchGate) await fetchGate;
    return respond(interval, from, to);
  };
  const inflight = new Map<string, Promise<unknown>>();
  const submit = async <T>(req: GovRequest<T>): Promise<GovResult<T>> => {
    lanes.push(req.lane);
    if (opts.holdBackground && req.lane === LANE.BACKGROUND) await held;
    const forced = opts.result?.(req as unknown as GovRequest<HubCandle[]>);
    if (forced) return forced as unknown as GovResult<T>;
    return { kind: 'ok', value: await req.run() };
  };
  const governor = {
    submit: <T>(req: GovRequest<T>): Promise<GovResult<T>> => {
      if (!opts.coalesce || !req.key) return submit(req);
      const key = req.key;
      const existing = inflight.get(key);
      if (existing) return existing as Promise<GovResult<T>>;
      const p = submit(req);
      inflight.set(key, p);
      void p.then(() => inflight.delete(key));
      return p;
    },
  };
  const store = new CandleStore({ repo, governor, clock, fetch, interactiveCallBudget: opts.budget ?? 6, now: () => now });
  return {
    store, repo, calls, lanes, release,
    setNow: (t: number) => { now = t; },
    respond: (fn: typeof respond) => { respond = fn; },
    /** Make broker fetches wait until the returned function is called. */
    gateFetch: () => {
      let open!: () => void;
      fetchGate = new Promise<void>((r) => (open = r));
      return () => { fetchGate = null; open(); };
    },
  };
}
const DAY = 86_400_000;
const day = (ymd: string) => [istMidnight(ymd), istMidnight(ymd) + DAY] as const;
/** Let chained promises (and setImmediate) run to completion. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

describe('CandleStore', () => {
  it('serves from the database without calling the broker when every bar is there', async () => {
    const t = setup();
    await t.repo.upsert('1m', REF, minutes('2026-10-06'), 'broker');
    // A past 1m day is "there" once the broker has answered for it (F3: a full but uncovered day is re-fetched).
    await t.repo.markCovered('1m', REF, ['2026-10-06']);
    const r = await t.store.candles(REF, '1m', ...day('2026-10-06'), { lane: LANE.INTERACTIVE });
    expect(r.candles).toHaveLength(375);
    expect(r.incomplete).toEqual([]);
    expect(t.calls).toHaveLength(0);
  });

  it('fills a missing past day once and remembers it, even when the broker has fewer bars than expected', async () => {
    const t = setup();
    t.respond(() => minutes('2026-10-06', 555, 855)); // illiquid: 300 of 375 minutes traded
    const first = await t.store.candles(REF, '1m', ...day('2026-10-06'), { lane: LANE.INTERACTIVE });
    expect(t.calls).toEqual([{ interval: 'ONE_MINUTE', from: new Date(istMidnight('2026-10-06')), to: new Date(istMidnight('2026-10-07')) }]);
    expect(first.candles).toHaveLength(300);
    const second = await t.store.candles(REF, '1m', ...day('2026-10-06'), { lane: LANE.INTERACTIVE });
    expect(t.calls).toHaveLength(1);
    expect(second.candles).toHaveLength(300);
  });

  it('a throttled fill is reported as incomplete and retried next time', async () => {
    let throttle = true;
    const t = setup({ result: () => (throttle ? { kind: 'throttled', retryAfterMs: 1000 } : null) });
    t.respond(() => minutes('2026-10-06'));
    const r = await t.store.candles(REF, '1m', ...day('2026-10-06'), { lane: LANE.INTERACTIVE });
    expect(r.candles).toEqual([]);
    expect(r.incomplete).toEqual([{ from: istMidnight('2026-10-06'), to: istMidnight('2026-10-07'), reason: 'throttled' }]);
    throttle = false;
    const again = await t.store.candles(REF, '1m', ...day('2026-10-06'), { lane: LANE.INTERACTIVE });
    expect(again.candles).toHaveLength(375);
    expect(again.incomplete).toEqual([]);
  });

  it('waits for at most the interactive budget, newest first, and fills the rest in the background', async () => {
    const t = setup({ budget: 2, holdBackground: true });
    t.setNow(ist('2026-10-10T12:00:00')); // Saturday: Mon 5 .. Fri 9 Oct are all complete
    // from + 5h30m = 00:00 UTC on the requested IST date, so this names the day asked for.
    t.respond((_i, from) => minutes(new Date(from.getTime() + 19_800_000).toISOString().slice(0, 10)));
    const r = await t.store.candles(REF, '30m', istMidnight('2026-10-05'), istMidnight('2026-10-10'), { lane: LANE.INTERACTIVE });
    expect(t.lanes).toEqual([LANE.INTERACTIVE, LANE.INTERACTIVE, LANE.BACKGROUND, LANE.BACKGROUND, LANE.BACKGROUND]);
    expect(t.calls.map((c) => c.from)).toEqual([new Date(istMidnight('2026-10-09')), new Date(istMidnight('2026-10-08'))]);
    expect(r.incomplete).toEqual([
      { from: istMidnight('2026-10-07'), to: istMidnight('2026-10-08'), reason: 'deferred' },
      { from: istMidnight('2026-10-06'), to: istMidnight('2026-10-07'), reason: 'deferred' },
      { from: istMidnight('2026-10-05'), to: istMidnight('2026-10-06'), reason: 'deferred' },
    ]);
    expect(r.candles.length).toBe(2 * 13); // two filled days × 13 thirty-minute bars (09:15 … 15:15)
    expect(t.store.metrics().deferredFills).toBe(3);
    t.release();
    await settle();
    expect(t.calls).toHaveLength(5);
    const after = await t.store.candles(REF, '30m', istMidnight('2026-10-05'), istMidnight('2026-10-10'), { lane: LANE.INTERACTIVE });
    expect(after.incomplete).toEqual([]);
    expect(after.candles.length).toBe(5 * 13);
    expect(t.calls).toHaveLength(5); // nothing re-fetched
  });

  it('an interactive reload does not wait on a deferred background fill', async () => {
    const t = setup({ budget: 1, holdBackground: true });
    t.setNow(ist('2026-10-10T12:00:00')); // Saturday: Mon 5 .. Fri 9 Oct are all complete
    t.respond((_i, from) => minutes(new Date(from.getTime() + 19_800_000).toISOString().slice(0, 10)));
    const range = [istMidnight('2026-10-05'), istMidnight('2026-10-10')] as const;
    await t.store.candles(REF, '30m', ...range, { lane: LANE.INTERACTIVE });
    expect(t.calls).toHaveLength(1); // Oct 9 filled; Oct 5..8 deferred and held
    const deferred = ['2026-10-08', '2026-10-07', '2026-10-06', '2026-10-05'].map((d) => ({
      from: istMidnight(d), to: istMidnight(addDays(d, 1)), reason: 'deferred' as const,
    }));
    // The background fills are still held: the reload must resolve without waiting on them.
    const second = await Promise.race([
      t.store.candles(REF, '30m', ...range, { lane: LANE.INTERACTIVE }),
      settle().then(() => 'still waiting' as const),
    ]);
    expect(second).not.toBe('still waiting');
    if (second === 'still waiting') return;
    expect(second.incomplete).toEqual(deferred);
    expect(second.candles.length).toBe(13);
    expect(t.lanes).toHaveLength(5); // nothing new submitted for the deferred windows
    expect(t.calls).toHaveLength(1);
    expect(t.store.metrics().deferredFills).toBe(4); // the reload started no new fill
    t.release();
    await settle();
    expect(t.calls).toHaveLength(5);
    const after = await t.store.candles(REF, '30m', ...range, { lane: LANE.INTERACTIVE });
    expect(after.incomplete).toEqual([]);
  });

  it('coalesced today reads keep the broker’s cut-off', async () => {
    const t = setup({ coalesce: true });
    t.setNow(ist('2026-10-07T10:00:30'));
    t.respond(() => minutes('2026-10-07', 555, 601)); // includes the 10:00 bar, forming at 10:00:30
    const open = t.gateFetch();
    const first = t.store.candles(REF, '1m', ...day('2026-10-07'), { lane: LANE.INTERACTIVE });
    await settle(); // the broker has been asked at 10:00:30
    expect(t.calls).toHaveLength(1);
    t.setNow(ist('2026-10-07T10:01:05')); // the 10:00 bar is complete by now, but not by the broker's answer
    const second = t.store.candles(REF, '1m', ...day('2026-10-07'), { lane: LANE.INTERACTIVE });
    await settle();
    open();
    const [a, b] = await Promise.all([first, second]);
    expect(t.calls).toHaveLength(1); // coalesced onto the one broker call
    expect(await t.repo.read('1m', REF, ist('2026-10-07T10:00:00'), ist('2026-10-07T10:01:00'))).toEqual([]);
    expect(a.candles).toHaveLength(45);
    expect(b.candles).toHaveLength(45);
  });

  it('today-coverage is pruned when the IST day changes', async () => {
    const t = setup();
    // White-box: the private today-coverage map, to check the daily prune (bounded memory).
    const coverage = () => (t.store as unknown as { todayCoverage: Map<string, { day: string }> }).todayCoverage;
    t.setNow(ist('2026-10-07T10:00:30'));
    await t.store.candles(REF, '1m', ...day('2026-10-07'), { lane: LANE.INTERACTIVE });
    expect([...coverage().values()].map((v) => v.day)).toEqual(['2026-10-07']);
    t.setNow(ist('2026-10-08T10:00:30'));
    const OTHER: InstrumentRef = { exchange: 'NSE', token: '11536', symbol: 'TCS' };
    await t.store.candles(OTHER, '1m', ...day('2026-10-08'), { lane: LANE.INTERACTIVE });
    expect([...coverage().values()].map((v) => v.day)).toEqual(['2026-10-08']);
  });

  it('today: drops the forming bar and re-fetches only after a new bar completes', async () => {
    const t = setup();
    t.setNow(ist('2026-10-07T10:00:30'));
    t.respond(() => minutes('2026-10-07', 555, 601)); // includes the forming 10:00 bar
    const r = await t.store.candles(REF, '1m', ...day('2026-10-07'), { lane: LANE.INTERACTIVE });
    expect(r.candles).toHaveLength(45); // 09:15 .. 09:59
    t.setNow(ist('2026-10-07T10:00:50'));
    await t.store.candles(REF, '1m', ...day('2026-10-07'), { lane: LANE.INTERACTIVE });
    expect(t.calls).toHaveLength(1);
    t.setNow(ist('2026-10-07T10:01:05'));
    await t.store.candles(REF, '1m', ...day('2026-10-07'), { lane: LANE.INTERACTIVE });
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1].to).toEqual(new Date(ist('2026-10-07T10:01:05')));
  });

  it('1h: completed days from candles_1h, today grouped from 1m at 09:15', async () => {
    const t = setup();
    t.setNow(ist('2026-10-07T10:15:30'));
    const hourly = [555, 615, 675, 735, 795, 855, 915].map((m) => ({ ts: istMidnight('2026-10-06') + m * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 60 }));
    await t.repo.upsert('1h', REF, hourly, 'broker');
    await t.repo.markCovered('1h', REF, ['2026-10-06']);
    await t.repo.upsert('1m', REF, minutes('2026-10-07', 555, 615), 'tick');
    const r = await t.store.candles(REF, '1h', istMidnight('2026-10-06'), ist('2026-10-07T10:15:30'), { lane: LANE.INTERACTIVE });
    expect(t.calls).toHaveLength(0);
    expect(r.candles).toHaveLength(8);
    expect(r.candles[7]).toMatchObject({ ts: ist('2026-10-07T09:15:00'), volume: 60 });
  });

  it('1w rolls up daily bars and widens the lower bound to five years', async () => {
    const t = setup();
    t.respond(() => []);
    const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-05', '2026-10-06'];
    await t.repo.upsert('1d', REF, days.map((d, i) => ({ ts: istMidnight(d), open: i, high: 10 + i, low: i, close: i, volume: 1 })), 'broker');
    const to = istMidnight('2026-10-07');
    const r = await t.store.candles(REF, '1w', to - 7 * DAY, to, { lane: LANE.BACKGROUND });
    expect(r.candles.map((c) => c.volume)).toEqual([4, 2]); // Sep 28–Oct 1 (Oct 2 holiday), Oct 5–6
    // The fill reaches back ~5 years (first window starts at the first trading day on/after to − 1825 days).
    expect(Math.min(...t.calls.map((c) => c.from.getTime()))).toBeLessThanOrEqual(to - 1820 * DAY);
    expect(t.calls.length).toBe(2); // 1825 days > one 1800-day window
    expect(t.calls.every((c) => c.interval === 'ONE_DAY')).toBe(true);
  });

  it('1d during market hours includes today’s forming bar built from 1m', async () => {
    const t = setup();
    t.setNow(ist('2026-10-07T10:15:30'));
    await t.repo.upsert('1d', REF, [{ ts: istMidnight('2026-10-06'), open: 1, high: 1, low: 1, close: 1, volume: 375 }], 'broker');
    await t.repo.markCovered('1d', REF, ['2026-10-06']);
    await t.repo.upsert('1m', REF, minutes('2026-10-07', 555, 615), 'tick'); // 09:15 .. 10:14
    const r = await t.store.candles(REF, '1d', istMidnight('2026-10-06'), ist('2026-10-07T10:15:30'), { lane: LANE.INTERACTIVE });
    expect(t.calls).toHaveLength(0);
    expect(r.incomplete).toEqual([]);
    expect(r.candles).toHaveLength(2);
    expect(r.candles[1]).toEqual({ ts: istMidnight('2026-10-07'), open: 100, high: 101, low: 99, close: 100, volume: 60 });
  });

  it('1d during market hours fills today’s missing minutes on the 1m table', async () => {
    const t = setup();
    t.setNow(ist('2026-10-07T10:15:30'));
    t.respond((interval) => (interval === 'ONE_MINUTE' ? minutes('2026-10-07', 555, 616) : []));
    const r = await t.store.candles(REF, '1d', istMidnight('2026-10-07'), ist('2026-10-07T10:15:30'), { lane: LANE.INTERACTIVE });
    expect(t.calls.map((c) => c.interval)).toEqual(['ONE_MINUTE']);
    expect(r.candles).toEqual([{ ts: istMidnight('2026-10-07'), open: 100, high: 101, low: 99, close: 100, volume: 60 }]); // forming 10:15 dropped
  });

  it('1w during market hours includes today', async () => {
    const t = setup();
    t.setNow(ist('2026-10-07T10:15:30')); // Wednesday
    t.respond(() => []);
    await t.repo.upsert('1d', REF, ['2026-10-05', '2026-10-06'].map((d) => ({ ts: istMidnight(d), open: 1, high: 1, low: 1, close: 1, volume: 1 })), 'broker');
    await t.repo.upsert('1m', REF, minutes('2026-10-07', 555, 615), 'tick');
    const r = await t.store.candles(REF, '1w', istMidnight('2026-10-05'), ist('2026-10-07T10:15:30'), { lane: LANE.BACKGROUND });
    const last = r.candles[r.candles.length - 1];
    expect(last.ts).toBe(istMidnight('2026-10-05')); // the week of Mon 5 Oct
    expect(last.volume).toBe(1 + 1 + 60); // Mon + Tue daily bars + today's partial day
    expect(last.close).toBe(100); // today's last minute
  });

  it('a full but uncovered past 1m day (tick-built) is re-fetched once from the broker and then covered', async () => {
    const t = setup(); // now: 2026-10-07 16:00
    await t.repo.upsert('1m', REF, minutes('2026-10-06').map((c) => ({ ...c, volume: 7 })), 'tick'); // 375/375 bars
    t.respond(() => minutes('2026-10-06'));
    const first = await t.store.candles(REF, '1m', ...day('2026-10-06'), { lane: LANE.INTERACTIVE });
    expect(t.calls).toHaveLength(1);
    expect(first.candles.every((c) => c.volume === 1)).toBe(true); // the broker's bars replaced the tick bars
    expect(await t.repo.coveredDays('1m', REF, ['2026-10-06'])).toEqual(new Set(['2026-10-06']));
    await t.store.candles(REF, '1m', ...day('2026-10-06'), { lane: LANE.INTERACTIVE });
    expect(t.calls).toHaveLength(1);
  });

  it('a full but uncovered past 1h day keeps the count rule (no re-fetch)', async () => {
    const t = setup();
    const hourly = [555, 615, 675, 735, 795, 855, 915].map((m) => ({ ts: istMidnight('2026-10-06') + m * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 60 }));
    await t.repo.upsert('1h', REF, hourly, 'broker');
    await t.store.candles(REF, '1h', ...day('2026-10-06'), { lane: LANE.INTERACTIVE });
    expect(t.calls).toHaveLength(0);
  });

  it('a 1m read years back is clamped to 180 days', async () => {
    const t = setup(); // now: 2026-10-07 16:00
    const now = ist('2026-10-07T16:00:00');
    const long = await t.store.candles(REF, '1m', ist('2023-01-01T00:00:00'), now, { lane: LANE.BACKGROUND });
    expect(t.calls.length).toBeGreaterThan(100); // ~6 months of trading days, one call each
    expect(Math.min(...t.calls.map((c) => c.from.getTime()))).toBeGreaterThanOrEqual(now - 180 * DAY);
    expect(long.incomplete).toEqual([]);
    const before = t.calls.length;
    const old = await t.store.candles(REF, '5m', ist('2024-01-01T00:00:00'), ist('2024-01-10T00:00:00'), { lane: LANE.INTERACTIVE });
    expect(old).toEqual({ candles: [], incomplete: [] });
    expect(t.calls).toHaveLength(before);
  });

  it('no more than 30 windows are queued per read', async () => {
    const t = setup({ budget: 2, holdBackground: true });
    t.setNow(ist('2026-10-10T12:00:00')); // Saturday
    const r = await t.store.candles(REF, '1m', istMidnight('2026-08-01'), istMidnight('2026-10-10'), { lane: LANE.INTERACTIVE });
    const interactive = t.lanes.filter((l) => l === LANE.INTERACTIVE).length;
    const queued = t.lanes.filter((l) => l === LANE.BACKGROUND).length;
    expect(interactive).toBe(2);
    expect(queued).toBe(30);
    expect(t.store.metrics().deferredFills).toBe(30);
    // Every window not fetched now is still reported, queued or not.
    expect(r.incomplete.length).toBeGreaterThan(30);
    expect(r.incomplete.every((w) => w.reason === 'deferred')).toBe(true);
    t.release();
    await settle();
    // The next read queues the next batch (at most 30 again).
    await t.store.candles(REF, '1m', istMidnight('2026-08-01'), istMidnight('2026-10-10'), { lane: LANE.INTERACTIVE });
    expect(t.lanes.filter((l) => l === LANE.BACKGROUND).length - queued).toBeLessThanOrEqual(30);
  });

  it('ignores broker bars outside the window (Angel’s todate is inclusive)', async () => {
    const t = setup();
    t.respond(() => [
      { ts: istMidnight('2026-10-06'), open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { ts: istMidnight('2026-10-07'), open: 9, high: 9, low: 9, close: 9, volume: 9 },
    ]);
    const r = await t.store.candles(REF, '1d', ...day('2026-10-06'), { lane: LANE.INTERACTIVE });
    expect(r.candles).toEqual([{ ts: istMidnight('2026-10-06'), open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    expect(await t.repo.read('1d', REF, istMidnight('2026-10-07'), istMidnight('2026-10-08'))).toEqual([]);
  });

  it('a weekend-only range needs no broker call and is not incomplete', async () => {
    const t = setup();
    const r = await t.store.candles(REF, '1m', istMidnight('2026-10-10'), istMidnight('2026-10-12'), { lane: LANE.INTERACTIVE });
    expect(r).toEqual({ candles: [], incomplete: [] });
    expect(t.calls).toHaveLength(0);
  });

  it('records read latency', async () => {
    const t = setup();
    await t.store.candles(REF, '1m', ...day('2026-10-10'), { lane: LANE.INTERACTIVE });
    expect(t.store.metrics()).toMatchObject({ reads: 1, fillErrors: 0, lastError: null });
  });

  it('nightly fix-up replaces tick bars with the broker’s for 1m, 1h and the last week of 1d', async () => {
    const t = setup();
    t.setNow(ist('2026-10-08T00:15:00'));
    await t.repo.upsert('1m', REF, [{ ts: ist('2026-10-07T10:00:00'), open: 1, high: 1, low: 1, close: 1, volume: 999 }], 'tick');
    t.respond((interval) =>
      interval === 'ONE_MINUTE' ? minutes('2026-10-07') :
      interval === 'ONE_HOUR' ? [{ ts: ist('2026-10-07T09:15:00'), open: 1, high: 1, low: 1, close: 1, volume: 1 }] :
      [{ ts: istMidnight('2026-10-07'), open: 1, high: 1, low: 1, close: 1, volume: 1 }],
    );
    const report = await t.store.fixup('2026-10-07', [REF]);
    expect(report).toMatchObject({ day: '2026-10-07', instruments: 1, calls: 3, failures: 0 });
    expect(t.calls.map((c) => c.interval)).toEqual(['ONE_MINUTE', 'ONE_HOUR', 'ONE_DAY']);
    expect(t.lanes).toEqual([LANE.BACKGROUND, LANE.BACKGROUND, LANE.BACKGROUND]);
    const [tenAm] = await t.repo.read('1m', REF, ist('2026-10-07T10:00:00'), ist('2026-10-07T10:01:00'));
    expect(tenAm.volume).toBe(1); // broker replaced the tick bar
    expect(await t.repo.coveredDays('1m', REF, ['2026-10-07'])).toEqual(new Set(['2026-10-07']));
  });

  it('nightly fix-up skips an instrument whose exchange did not trade that day', async () => {
    const t = setup();
    const report = await t.store.fixup('2026-10-02', [REF]); // holiday
    expect(report).toMatchObject({ instruments: 0, calls: 0 });
  });
});
