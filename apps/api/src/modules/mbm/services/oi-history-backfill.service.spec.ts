import { AngelThrottleError } from '../../market-data/services/angel-throttle';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import type { OiPoint } from '../../market-data/services/oi-data.util';
import { SessionClock } from '../../market-hub/session-clock';
import { parseOiHistoryConfig, sessionsIn, type OiContract } from '../domain/oi-history';
import { parseMbmConfig } from '../mbm.config';
import type { OiProgress } from '../repositories/oi-history.repository';
import { OiHistoryBackfillService } from './oi-history-backfill.service';

const cal = new SessionClock({ holidays: MARKET_HOLIDAYS });
/** Sat 24 Oct 2026 01:30 IST. */
const NIGHT = '2026-10-23T20:00:00Z';
const DAY = 86_400_000;

const F1: OiContract = { token: 'F1', symbol: 'NIFTY27OCT26FUT', kind: 'FUT', expiry: '2026-10-27', strike: null };
const F2: OiContract = { token: 'F2', symbol: 'NIFTY24NOV26FUT', kind: 'FUT', expiry: '2026-11-24', strike: null };
const CE: OiContract = { token: 'C1', symbol: 'NIFTY27OCT2625000CE', kind: 'CE', expiry: '2026-10-27', strike: 25000 };
const PE: OiContract = { token: 'P1', symbol: 'NIFTY27OCT2625000PE', kind: 'PE', expiry: '2026-10-27', strike: 25000 };
/** First session each token has OI on. */
const LISTED: Record<string, string> = { F1: '2026-07-27', F2: '2026-08-25', C1: '2026-09-01', P1: '2026-09-01' };

interface World {
  intervals?: string[];
  /** Keep only the newest N session days of any window (Angel silently truncating). */
  truncateTo?: number;
  throttle?: boolean;
}

function memRepo() {
  const rows = new Map<string, OiPoint>();
  const prog = new Map<string, OiProgress & { kind: string }>();
  return {
    rows,
    prog,
    futures: jest.fn(async () => [F1, F2]),
    optionExpiries: jest.fn(async () => ['2026-10-27']),
    options: jest.fn(async () => [CE, PE]),
    progress: jest.fn(async (iv: string, tokens: readonly string[]) => {
      const m = new Map<string, OiProgress>();
      for (const t of tokens) {
        const p = prog.get(`${t}|${iv}`);
        if (p) m.set(t, { ...p });
      }
      return m;
    }),
    saveProgress: jest.fn(async (c: OiContract, iv: string, p: OiProgress) => {
      prog.set(`${c.token}|${iv}`, { ...p, kind: c.kind });
    }),
    insert: jest.fn(async (c: OiContract, iv: string, pts: readonly OiPoint[]) => {
      let n = 0;
      for (const p of pts) {
        const k = `${c.token}|${iv}|${p.ts.toISOString()}`;
        if (!rows.has(k)) {
          rows.set(k, p);
          n++;
        }
      }
      return n;
    }),
    summary: jest.fn(async (iv: string) => {
      const by = new Map<string, { kind: string; contracts: number; done: number; earliest: Date | null; rows: number }>();
      for (const [k, p] of prog) {
        if (!k.endsWith(`|${iv}`)) continue;
        const s = by.get(p.kind) ?? { kind: p.kind, contracts: 0, done: 0, earliest: null, rows: 0 };
        s.contracts++;
        if (p.done) s.done++;
        if (p.earliestTs && (!s.earliest || p.earliestTs < s.earliest)) s.earliest = p.earliestTs;
        s.rows += p.rows;
        by.set(p.kind, s);
      }
      return [...by.values()].sort((a, b) => a.kind.localeCompare(b.kind));
    }),
    pending: jest.fn(async () => {
      const all = [...prog.values()];
      const stalest = all.map((p) => p.coveredTo).sort((a, b) => (a?.getTime() ?? 0) - (b?.getTime() ?? 0))[0] ?? null;
      return { total: all.length, pending: all.filter((p) => !p.done).length, stalest };
    }),
  };
}

function build(opts: { now?: () => Date; env?: NodeJS.ProcessEnv; world?: World } = {}) {
  const world = opts.world ?? {};
  const repo = memRepo();
  const feeds = {
    fetchCandleWindow: jest.fn(async () => [{ timestamp: new Date(NIGHT), open: 25000, high: 26000, low: 24000, close: 25000, volume: 1 }]),
    fetchOIWindow: jest.fn(async (_u: string, ref: { token: string }, iv: string, from: Date, to: Date): Promise<OiPoint[]> => {
      if (world.throttle) throw new AngelThrottleError('Angel One getOIData throttled');
      if (!(world.intervals ?? ['ONE_MINUTE', 'THREE_MINUTE', 'FIVE_MINUTE']).includes(iv)) return [];
      let days = sessionsIn(cal, from, to).filter((d) => d >= LISTED[ref.token]);
      if (world.truncateTo) days = days.slice(-world.truncateTo);
      return days.map((d) => ({ ts: new Date(Date.parse(`${d}T03:45:00Z`)), oi: 100 }));
    }),
  };
  const now = opts.now ?? (() => new Date(NIGHT));
  const svc = new OiHistoryBackfillService(
    parseOiHistoryConfig({ OI_BACKFILL_INTERVAL: 'ONE_MINUTE', ...(opts.env ?? {}) }),
    parseMbmConfig({ MBM_FEED_USER_ID: 'owner' }),
    cal,
    now,
    feeds as never,
    repo as never,
    undefined,
    async () => undefined,
  );
  return { svc, feeds, repo };
}

const oiCalls = (feeds: { fetchOIWindow: jest.Mock }) => feeds.fetchOIWindow.mock.calls as Array<[string, { token: string }, string, Date, Date]>;

describe('OiHistoryBackfillService', () => {
  it('probes intervals finest-first, sizes chunks, walks back to the listing and stops after 2 empty chunks', async () => {
    const { svc, feeds, repo } = build();
    const r = await svc.run('test');
    expect(r).toMatchObject({ ran: true, stopped: 'complete' });
    const calls = oiCalls(feeds);
    // Interval probe: all three, on the nearest future over Fri 23 Oct's session.
    expect(calls.slice(0, 3).map((c) => [c[1].token, c[2]])).toEqual([
      ['F1', 'ONE_MINUTE'],
      ['F1', 'THREE_MINUTE'],
      ['F1', 'FIVE_MINUTE'],
    ]);
    expect(calls[0][3]).toEqual(new Date('2026-10-23T03:45:00Z'));
    // Chunk probe: 30 days answered in full → chunk=30d.
    expect(calls[3][4].getTime() - calls[3][3].getTime()).toBe(30 * DAY);
    expect(r.line).toContain('interval=ONE_MINUTE');
    expect(r.line).toContain('chunk=30d');
    // F1 (listed 27 Jul): every walk window is 30 days, newest first, until 2 empty windows.
    const f1 = calls.slice(4).filter((c) => c[1].token === 'F1');
    expect(f1.every((c) => c[2] === 'ONE_MINUTE' && c[4].getTime() - c[3].getTime() === 30 * DAY)).toBe(true);
    expect(f1[0][4]).toEqual(new Date(NIGHT));
    for (let i = 1; i < f1.length; i++) expect(f1[i][4]).toEqual(f1[i - 1][3]);
    expect(f1).toHaveLength(5); // 3 windows with data back to 27 Jul + 2 empty
    const p = repo.prog.get('F1|ONE_MINUTE');
    expect(p).toMatchObject({ done: true, emptyStreak: 2 });
    expect(p?.earliestTs).toEqual(new Date('2026-07-27T03:45:00Z'));
    expect(r.line).toMatch(/contracts=4 \(FUT 2, CE 1, PE 1/);
    expect(r.line).toMatch(/earliest=2026-07-27/);
    expect(r.line).toMatch(/per-kind=\{CE: 2026-09-01.*FUT: 2026-07-27.*PE: 2026-09-01/);
  });

  it('uses the preferred FIVE_MINUTE (the default) when it answers, finest-first otherwise', async () => {
    const five = build({ env: { OI_BACKFILL_INTERVAL: 'FIVE_MINUTE' } });
    const r = await five.svc.run('test');
    expect(r.line).toContain('interval=FIVE_MINUTE');
    expect(five.repo.prog.has('F1|FIVE_MINUTE')).toBe(true);
    const noFive = build({ env: { OI_BACKFILL_INTERVAL: 'FIVE_MINUTE' }, world: { intervals: ['ONE_MINUTE'] } });
    expect((await noFive.svc.run('test')).line).toContain('interval=ONE_MINUTE');
  });

  it('falls back to the next interval when the finest returns nothing, and logs which worked', async () => {
    const { svc, repo } = build({ world: { intervals: ['THREE_MINUTE', 'FIVE_MINUTE'] } });
    const r = await svc.run('test');
    expect(r.line).toContain('probe={ONE_MINUTE:empty, THREE_MINUTE:1, FIVE_MINUTE:1}');
    expect(r.line).toContain('interval=THREE_MINUTE');
    expect(repo.prog.has('F1|THREE_MINUTE')).toBe(true);
  });

  it('SDK-empty everywhere: no interval, nothing walked or marked done', async () => {
    const { svc, feeds, repo } = build({ world: { intervals: [] } });
    const r = await svc.run('test');
    expect(r.stopped).toBe('no-interval');
    expect(feeds.fetchOIWindow).toHaveBeenCalledTimes(3);
    expect(repo.saveProgress).not.toHaveBeenCalled();
  });

  it('a truncating API shrinks the chunk to 1 day', async () => {
    const { svc } = build({ world: { truncateTo: 1 }, env: { OI_BACKFILL_LOOKBACK_DAYS: '10' } });
    const r = await svc.run('test');
    expect(r.line).toContain('chunk=1d');
    // The 10-day lookback floor ends every walk, and that is saved.
    expect(r.line).toContain('done=4/4');
  });

  it('is idempotent: a second run spends only the probes and adds no rows', async () => {
    const { svc, feeds, repo } = build();
    const first = await svc.run('test');
    const stored = repo.rows.size;
    feeds.fetchOIWindow.mockClear();
    const second = await svc.run('test');
    expect(second.rows).toBe(0);
    expect(repo.rows.size).toBe(stored);
    expect(feeds.fetchOIWindow).toHaveBeenCalledTimes(4); // 3 interval probes + 1 chunk probe
    expect(first.rows).toBeGreaterThan(0);
  });

  it('nightly increments forward from each contract’s covered edge', async () => {
    let now = new Date(NIGHT);
    const { svc, feeds, repo } = build({ now: () => now });
    await svc.run('test');
    now = new Date(Date.parse(NIGHT) + 3 * DAY); // Tue 27 Oct 01:30 IST: Mon 26 traded
    feeds.fetchOIWindow.mockClear();
    const r = await svc.run('nightly');
    const walk = oiCalls(feeds).slice(4);
    expect(walk.map((c) => c[1].token).sort()).toEqual(['C1', 'F1', 'F2', 'P1']);
    expect(walk.every((c) => c[3].getTime() === Date.parse(NIGHT))).toBe(true);
    expect(r.rows).toBe(4);
    expect(repo.prog.get('F1|ONE_MINUTE')?.coveredTo).toEqual(now);
  });

  it('refuses during NSE market hours (holiday-aware) and stops a run that reaches 08:30 IST', async () => {
    const open = build({ now: () => new Date('2026-10-22T05:00:00Z') }); // Thu 10:30 IST
    expect(await open.svc.run('test')).toMatchObject({ ran: false, stopped: 'market-hours' });
    expect(await open.svc.bootRun()).toMatchObject({ ran: false, stopped: 'market-hours' });
    expect(open.feeds.fetchOIWindow).not.toHaveBeenCalled();

    const holiday = build({ now: () => new Date('2026-10-20T05:00:00Z') }); // Dussehra 10:30 IST
    expect((await holiday.svc.run('test')).ran).toBe(true);

    let t = Date.parse('2026-10-23T02:55:00Z'); // Fri 08:25 IST, the clock moves 1 min per read
    const late = build({ now: () => new Date((t += 60_000)) });
    const r = await late.svc.run('test');
    expect(r.stopped).toBe('market-hours');
    expect(r.line).toContain('stopped=market-hours');
  });

  it('caps calls per run and resumes from the saved cursor next run', async () => {
    const env = { OI_BACKFILL_MAX_CALLS: '8' };
    const { svc, feeds, repo } = build({ env });
    const r = await svc.run('test');
    expect(r).toMatchObject({ stopped: 'budget', calls: 8 });
    expect(r.line).toContain('calls=8/8');
    expect(feeds.fetchOIWindow).toHaveBeenCalledTimes(7); // + 1 spot candle call
    const cursor = repo.prog.get('F1|ONE_MINUTE')?.cursor as Date;
    expect(cursor.getTime()).toBe(Date.parse(NIGHT) - 3 * 30 * DAY);
    feeds.fetchOIWindow.mockClear();
    await svc.run('test');
    const resumed = oiCalls(feeds).slice(4).filter((c) => c[1].token === 'F1');
    expect(resumed[0][4]).toEqual(cursor);
  });

  it('a throttle that outlasts the retries ends the run as throttled', async () => {
    const { svc, feeds } = build({ world: { throttle: true } });
    const r = await svc.run('test');
    expect(r.stopped).toBe('throttled');
    expect(feeds.fetchOIWindow).toHaveBeenCalledTimes(3); // 1 + 2 retries
    expect(r.line).toContain('throttled=3');
  });

  it('boot skips when the stored set is finished and current; disabled flag makes it inert', async () => {
    const { svc, feeds } = build();
    await svc.run('test');
    feeds.fetchOIWindow.mockClear();
    expect(await svc.bootRun()).toMatchObject({ ran: false, stopped: 'nothing-to-do' });
    expect(feeds.fetchOIWindow).not.toHaveBeenCalled();
    const off = build({ env: { OI_BACKFILL_ENABLED: 'off' } });
    expect(await off.svc.run('test')).toMatchObject({ ran: false, stopped: 'disabled' });
  });
});
