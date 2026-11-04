import { SENTINEL_CLOCK } from '../../trade-sentinel/overnight/overnight-calendar';
import type { InputsHealthRepository } from '../repositories/inputs-health.repository';
import { inputsHealthEnabled, InputsHealthService, istDay } from './inputs-health.service';

const ist = (s: string) => new Date(`${s}+05:30`);

/**
 * In-memory repository. `claims` stands in for inputs_health_alerts: shared across service instances
 * below to model a process restart (the table survives, the process memory does not).
 */
function fakeRepo(claims = new Set<string>(), o: { goldBars?: Date | null; news?: Date | null } = {}) {
  const fresh = (now: Date) => new Date(now.getTime() - 60_000);
  let now = new Date();
  const repo = {
    claims,
    setNow: (d: Date) => (now = d),
    openUnderlyings: jest.fn(async () => [{ name: 'RELIANCE', exchange: 'NFO', cashRef: null }]),
    nearestFuture: jest.fn(async (name: string, exchange: string) => ({ exchange, token: `${name}-FUT` })),
    cashLine: jest.fn(async (name: string) => ({ exchange: 'NSE', token: `${name}-EQ` })),
    optionable: jest.fn(async (name: string) => name !== 'CRUDEOILM'),
    lastBarAt: jest.fn(async (refs: Array<{ token: string }>) => (refs.some((r) => r.token.startsWith('GOLD')) ? (o.goldBars ?? null) : fresh(now))),
    lastChainAt: jest.fn(async () => fresh(now)),
    lastNewsAt: jest.fn(async () => (o.news === undefined ? fresh(now) : o.news)),
    engineNews: jest.fn(async () => []),
    claimAlert: jest.fn(async (kind: string, u: string, day: string) => {
      const k = `${kind}|${u}|${day}`;
      if (claims.has(k)) return false;
      claims.add(k);
      return true;
    }),
    releaseAlert: jest.fn(async (kind: string, u: string, day: string) => void claims.delete(`${kind}|${u}|${day}`)),
  };
  return repo as typeof repo & InputsHealthRepository;
}

const make = (repo: ReturnType<typeof fakeRepo>) => new InputsHealthService(repo, SENTINEL_CLOCK);
const env = { HUB_LINE_FUTURES: 'NIFTY,GOLD,CRUDEOILM' };

describe('InputsHealthService', () => {
  it('watches the engine universe, the pinned line futures and open positions’ underlyings', async () => {
    const repo = fakeRepo();
    const now = ist('2026-11-04T11:00:00');
    repo.setNow(now);
    const snap = await make(repo).snapshot(now, env, repo);
    const names = snap.underlyings.map((u) => u.name);
    expect(names).toEqual(expect.arrayContaining(['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'GOLD', 'CRUDEOILM', 'RELIANCE']));
    const nifty = snap.underlyings.find((u) => u.name === 'NIFTY')!;
    expect(nifty.why).toEqual(['ENGINE', 'LINE']);
    expect(nifty.barRefs).toEqual(expect.arrayContaining(['NFO:NIFTY-FUT'])); // + the spot line
    expect(nifty.barRefs.length).toBe(2);
    // a stock derivative's bars come from its future and its NSE cash line
    expect(snap.underlyings.find((u) => u.name === 'RELIANCE')!.barRefs).toEqual(['NFO:RELIANCE-FUT', 'NSE:RELIANCE-EQ']);
    expect(snap.underlyings.find((u) => u.name === 'CRUDEOILM')!.optionable).toBe(false);
  });

  it('sends one alert per (problem, underlying, day), and not again after a restart', async () => {
    const claims = new Set<string>();
    const alert = jest.fn(async () => true);
    const t1 = ist('2026-11-04T11:00:00');
    const r1 = fakeRepo(claims, { goldBars: null });
    r1.setNow(t1);
    const first = await make(r1).run(t1, { env, alert, repo: r1 });
    expect(first.problems.map((p) => `${p.kind}:${p.underlying}`)).toEqual(['NO_BARS:GOLD']);
    expect(first.alerted).toBe(1);
    expect(alert).toHaveBeenCalledWith('inputs-health:NO_BARS:GOLD:2026-11-04', expect.stringContaining('GOLD'));

    const t2 = ist('2026-11-04T11:15:00');
    r1.setNow(t2);
    expect((await make(r1).run(t2, { env, alert, repo: r1 })).alerted).toBe(0);

    // "restart": a new service and repository object over the same stored claims
    const r2 = fakeRepo(claims, { goldBars: null });
    const t3 = ist('2026-11-04T11:30:00');
    r2.setNow(t3);
    expect((await make(r2).run(t3, { env, alert, repo: r2 })).alerted).toBe(0);
    expect(alert).toHaveBeenCalledTimes(1);

    // the next trading day alerts again
    const t4 = ist('2026-11-05T11:00:00');
    r2.setNow(t4);
    expect((await make(r2).run(t4, { env, alert, repo: r2 })).alerted).toBe(1);
  });

  it('releases the claim when Telegram does not accept the message, so the next run retries', async () => {
    const repo = fakeRepo(new Set(), { goldBars: null });
    const now = ist('2026-11-04T11:00:00');
    repo.setNow(now);
    const down = jest.fn(async () => false);
    expect((await make(repo).run(now, { env, alert: down, repo })).alerted).toBe(0);
    expect(repo.claims.size).toBe(0);
    const up = jest.fn(async () => true);
    expect((await make(repo).run(now, { env, alert: up, repo })).alerted).toBe(1);
  });

  it('sends nothing and queries nothing outside every session', async () => {
    const repo = fakeRepo(new Set(), { goldBars: null, news: null });
    const alert = jest.fn(async () => true);
    for (const at of [ist('2026-11-04T08:00:00'), ist('2026-11-04T23:50:00'), ist('2026-11-08T12:00:00')]) {
      const r = await make(repo).run(at, { env, alert, repo });
      expect(r.skipped).toBe('closed');
    }
    expect(alert).not.toHaveBeenCalled();
    expect(repo.openUnderlyings).not.toHaveBeenCalled();
  });

  it('INPUTS_HEALTH=off disables it; default on', async () => {
    expect(inputsHealthEnabled({})).toBe(true);
    expect(inputsHealthEnabled({ INPUTS_HEALTH: 'off' })).toBe(false);
    expect(inputsHealthEnabled({ INPUTS_HEALTH: 'false' })).toBe(false);
    const repo = fakeRepo(new Set(), { goldBars: null });
    const alert = jest.fn(async () => true);
    const r = await make(repo).run(ist('2026-11-04T11:00:00'), { env: { ...env, INPUTS_HEALTH: 'off' }, alert, repo });
    expect(r.skipped).toBe('off');
    expect(alert).not.toHaveBeenCalled();
  });

  it('alerts that the check itself is down when a read fails', async () => {
    const repo = fakeRepo();
    repo.lastNewsAt.mockRejectedValueOnce(new Error('relation "news_impacts" does not exist'));
    const alert = jest.fn(async () => true);
    const r = await make(repo).run(ist('2026-11-04T11:00:00'), { env, alert, repo });
    expect(r.failed).toContain('news_impacts');
    expect(alert).toHaveBeenCalledWith('inputs-health:failed', expect.stringContaining('could not run'));
  });

  it('istDay is the IST calendar date', () => {
    expect(istDay(new Date('2026-11-04T19:00:00Z'))).toBe('2026-11-05');
  });
});
