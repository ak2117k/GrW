import { istDay, istMidnight } from '../candles/trading-calendar';
import { LANE, refKey, type InstrumentRef, type Lane } from '../hub.types';
import type { QuoteOutcome } from '../quote-batcher';
import { chunkRefs } from '../quote-batcher';
import type { SessionClock } from '../session-clock';
import type { ChainRepo, OiCaptureRepo } from './chain-repository';
import type { FutureContract, FuturesOiStatus, OiRow } from './chain.types';
import { OI_SNAPSHOT_EVERY_MS } from './oi-snapshot-job';

/** Angel's marketData takes ≤ 50 tokens a call (the QuoteBatcher's cap too). */
export const FUTURES_QUOTE_MAX = 50;
/** Gap between this job's quote calls, so ~5 calls spread over ~10 s instead of one burst. */
export const FUTURES_CALL_GAP_MS = 2_000;
/** Ticks run every 30 s; allow a run a little early so a 3-minute cadence does not drift to 3.5. */
const EARLY_MS = 15_000;

export interface FuturesOiJobDeps {
  repo: Pick<OiCaptureRepo, 'futures'> & Pick<ChainRepo, 'baseline' | 'writeOi'>;
  /** The hub's quoteNow (batcher → Governor quote budget → the owner's session). Never rejects. */
  quoteNow(refs: readonly InstrumentRef[], lane: Lane): Promise<Map<string, QuoteOutcome>>;
  clock: Pick<SessionClock, 'isOpen'>;
  log?: (m: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The capture set: each underlying's nearest future, and on its expiry day also the next one (so
 * tomorrow's contract has an OI baseline, the same rule as the option core list).
 */
export function selectFutures(rows: readonly FutureContract[], today: string): FutureContract[] {
  const byName = new Map<string, FutureContract[]>();
  for (const r of rows) {
    if (r.expiry < today) continue;
    const list = byName.get(r.name) ?? [];
    list.push(r);
    byName.set(r.name, list);
  }
  const out: FutureContract[] = [];
  for (const list of byName.values()) {
    list.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0));
    const [nearest, next] = list;
    out.push(nearest);
    if (nearest.expiry === today && next && next.expiry !== today) out.push(next);
  }
  return out;
}

/**
 * Quote outcomes → oi_snapshots rows. A contract without an ok tick, or whose tick carries no finite
 * OI, is `missing` (the SDK's empty answers land here, never as a throw).
 */
export function futuresRows(
  contracts: readonly FutureContract[],
  quotes: ReadonlyMap<string, QuoteOutcome>,
  baseline: ReadonlyMap<string, number>,
  at: Date,
): { rows: OiRow[]; missing: number } {
  const rows: OiRow[] = [];
  let missing = 0;
  for (const c of contracts) {
    const q = quotes.get(refKey(c.ref));
    const oi = q?.kind === 'ok' ? Number(q.tick.oi) : Number.NaN;
    if (q?.kind !== 'ok' || q.tick.oi == null || !Number.isFinite(oi) || oi < 0) {
      missing++;
      continue;
    }
    const base = baseline.get(c.instrumentId);
    const volume = Number(q.tick.volume);
    rows.push({
      instrumentId: c.instrumentId,
      oi,
      oiChange: base === undefined ? null : oi - base,
      volume: Number.isFinite(volume) && volume > 0 ? volume : 0,
      ltp: Number.isFinite(q.tick.ltp) && q.tick.ltp > 0 ? q.tick.ltp : null,
      at,
    });
  }
  return { rows, missing };
}

/**
 * Every 3 minutes while NFO is open (plus one run at the close), one oi_snapshots row — OI, change vs
 * the previous session, day volume and LTP — per near-month NFO future (every F&O stock plus the index
 * futures, ≈ 215 contracts), from FULL quotes in ≤ 50-token calls spaced FUTURES_CALL_GAP_MS apart on
 * the Routine lane. No WebSocket slot is used. Never throws; an empty answer counts as a failure.
 */
export class FuturesOiJob {
  private lastRunAt = Number.NEGATIVE_INFINITY;
  private wasOpen = false;
  private running = false;
  private day = '';
  private selection: FutureContract[] | null = null;
  private baseline: Map<string, number> | null = null;
  private counts = { rows: 0, calls: 0, failures: 0, missing: 0, lastAt: null as number | null };
  private warned = new Set<string>();

  constructor(private readonly d: FuturesOiJobDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  async tick(now: number): Promise<void> {
    this.rollDay(now);
    if (this.running) return;
    const open = this.d.clock.isOpen('NFO', new Date(now));
    const due = open && now - this.lastRunAt >= OI_SNAPSHOT_EVERY_MS - EARLY_MS;
    const closing = !open && this.wasOpen;
    this.wasOpen = open;
    if (!due && !closing) return;
    this.lastRunAt = now;
    this.running = true;
    try {
      await this.run(now);
    } catch (err) {
      this.counts.failures++;
      this.warnOnce('run', `Futures OI snapshot failed: ${(err as Error)?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }

  status(now: number): FuturesOiStatus {
    this.rollDay(now);
    return {
      enabled: true,
      contracts: this.selection?.length ?? 0,
      rowsToday: this.counts.rows,
      callsToday: this.counts.calls,
      failures: this.counts.failures,
      missingToday: this.counts.missing,
      lastAt: this.counts.lastAt,
    };
  }

  private async run(now: number): Promise<void> {
    const today = istDay(now);
    const contracts = await this.contracts(today);
    if (contracts.length === 0) {
      this.counts.failures++;
      this.warnOnce('none', 'Futures OI snapshot: no active NFO futures in the instrument master');
      return;
    }
    const baseline = await this.baselineFor(contracts, today);
    const chunks = chunkRefs(contracts.map((c) => ({ ref: c.ref, c })), FUTURES_QUOTE_MAX);
    const quotes = new Map<string, QuoteOutcome>();
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await (this.d.sleep ?? defaultSleep)(FUTURES_CALL_GAP_MS);
      this.counts.calls++;
      const out = await this.d.quoteNow(chunks[i].map((x) => x.ref), LANE.ROUTINE);
      for (const [k, v] of out) quotes.set(k, v);
    }
    const { rows, missing } = futuresRows(contracts, quotes, baseline, new Date(this.now()));
    this.counts.missing += missing;
    if (rows.length === 0) {
      this.counts.failures++;
      const kinds = [...new Set([...quotes.values()].map((q) => q.kind))].join('/') || 'none';
      this.warnOnce('empty', `Futures OI snapshot: no OI in ${chunks.length} quote call(s) for ${contracts.length} future(s) (${kinds})`);
      return;
    }
    this.counts.rows += await this.d.repo.writeOi(rows);
    this.counts.lastAt = rows[0].at.getTime();
  }

  /** Once per IST day; an empty or failed read is retried on the next run. */
  private async contracts(today: string): Promise<FutureContract[]> {
    if (this.selection && this.selection.length > 0) return this.selection;
    this.selection = selectFutures(await this.d.repo.futures(today), today);
    return this.selection;
  }

  /** Once per IST day; a failure is not cached and gives "no baseline" (oiChange NULL). */
  private async baselineFor(contracts: readonly FutureContract[], today: string): Promise<Map<string, number>> {
    if (this.baseline) return this.baseline;
    try {
      this.baseline = await this.d.repo.baseline(contracts.map((c) => c.instrumentId), new Date(istMidnight(today)));
      return this.baseline;
    } catch {
      return new Map();
    }
  }

  private rollDay(now: number): void {
    const day = istDay(now);
    if (this.day === day) return;
    this.day = day;
    this.selection = null;
    this.baseline = null;
    this.counts = { rows: 0, calls: 0, failures: 0, missing: 0, lastAt: null };
    this.warned.clear();
  }

  /** Once per message key per IST day: never silent, never a log storm. */
  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.d.log?.(message);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
