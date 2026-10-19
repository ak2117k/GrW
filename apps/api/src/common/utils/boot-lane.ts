/**
 * BOOT LANE — the broker-heavy boot jobs run ONE AT A TIME, in priority order.
 *
 * Every service used to start its boot pass from its own `onModuleInit`, so on
 * each deploy six jobs hit Angel in the same few seconds (universe + daily
 * backfills, the gap scan, sector-index quotes, the MBM catch-up, swing-ohlc).
 * Prod 2026-10-19: ~30 "no quote returned" errors in the first minute and 9 of
 * 11 MBM series throttled (`data:null`) — the jobs starved each other of the same
 * rate limits, and nothing was wrong with any one of them.
 *
 * `runInBootLane(name, priority, job)` queues the job; the lane starts once
 * enqueueing has settled (`START_DELAY_MS`), runs lowest priority number first,
 * waits `GAP_MS` between jobs, and never lets one stuck job hold the rest for
 * more than `MAX_WAIT_MS` (it keeps running in the background; the lane moves
 * on). The returned promise settles when the job does; it never rejects — a
 * failed job is logged here.
 *
 * Priorities used (lower first): 10 universe daily backfill (level books seed
 * from it before the open) · 20 MBM bar catch-up · 30 sector-index quotes ·
 * 40 swing-ohlc · 50 daily-candle backfill · 60 gap scan.
 *
 * Under Jest the lane runs each job immediately, so specs that drive
 * `onModuleInit` keep their timing; boot-lane.spec.ts tests the real queue.
 */
import { Logger } from '@nestjs/common';

const logger = new Logger('BootLane');
export const BOOT_LANE_START_DELAY_MS = 3_000;
export const BOOT_LANE_GAP_MS = 5_000;
export const BOOT_LANE_MAX_WAIT_MS = 5 * 60_000;

interface Entry { name: string; priority: number; seq: number; job: () => Promise<unknown>; done: () => void }

type Timers = { sleep: (ms: number) => Promise<void>; now: () => number };
const realTimers: Timers = {
  sleep: (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }),
  now: () => Date.now(),
};

let timers: Timers = realTimers;
let immediate = process.env.JEST_WORKER_ID !== undefined;
let queue: Entry[] = [];
let seq = 0;
let draining: Promise<void> | null = null;

/** Tests only: drive the real queue with fake timers (`immediate=false`). */
export function __configureBootLane(o: { timers?: Timers | null; immediate?: boolean }): void {
  timers = o.timers ?? realTimers;
  if (o.immediate !== undefined) immediate = o.immediate;
  queue = [];
  seq = 0;
  draining = null;
}

function runGuarded(name: string, job: () => Promise<unknown>): Promise<void> {
  let p: Promise<unknown>;
  try {
    p = Promise.resolve(job());
  } catch (err) {
    p = Promise.reject(err);
  }
  return p.then(
    () => undefined,
    (err) => logger.warn(`[boot-lane] ${name} failed: ${err instanceof Error ? err.message : String(err)}`),
  );
}

async function drain(): Promise<void> {
  await timers.sleep(BOOT_LANE_START_DELAY_MS);
  let first = true;
  while (queue.length > 0) {
    queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const e = queue.shift()!;
    if (!first) await timers.sleep(BOOT_LANE_GAP_MS);
    first = false;
    const started = timers.now();
    const run = runGuarded(e.name, e.job).finally(e.done);
    const finishedInTime = await Promise.race([
      run.then(() => true),
      timers.sleep(BOOT_LANE_MAX_WAIT_MS).then(() => false),
    ]);
    const secs = Math.round((timers.now() - started) / 1000);
    logger.log(finishedInTime
      ? `[boot-lane] ${e.name} done in ${secs}s`
      : `[boot-lane] ${e.name} still running after ${secs}s — moving on, it continues in the background`);
  }
  draining = null;
}

export function runInBootLane(name: string, priority: number, job: () => Promise<unknown>): Promise<void> {
  if (immediate) return runGuarded(name, job);
  return new Promise<void>((done) => {
    queue.push({ name, priority, seq: seq++, job, done });
    if (!draining) draining = drain();
  });
}
