import { DeskStatusAdapter, feedText, type HubStatusLike } from './desk-status.adapter';

const NOW = Date.UTC(2026, 10, 27, 7, 30);

const status = (over: Partial<HubStatusLike> = {}): HubStatusLike => ({
  socketUp: true,
  slots: { live: 27, cap: 30 },
  prices: { fresh: 40, stale: 2, marketClosed: 0, unavailable: 1, oldestP0AgeMs: 3_200, unpricedP0: 0 },
  lastError: null,
  candles: { lastTickWriteAt: NOW - 4_000, lines: { stale: [] } },
  ...over,
});

describe('desk status adapter (health block)', () => {
  it('feed: hub socket, slots, price freshness and the last tick age', () => {
    const t = feedText(status(), null, NOW);
    expect(t).toMatch(/^hub socket UP/);
    expect(t).toMatch(/slots 27\/30/);
    expect(t).toMatch(/fresh 40, stale 2, unavailable 1/);
    expect(t).toMatch(/oldest P0 price 3 s/);
    expect(t).toMatch(/last tick 4 s ago/);
  });

  it('feed: socket down with the broker error and stale lines', () => {
    const t = feedText(status({ socketUp: false, lastError: 'AB1004 session expired', candles: { lastTickWriteAt: NOW - 900_000, lines: { stale: ['NFO:1', 'MCX:2'] } } }), null, NOW);
    expect(t).toMatch(/^hub socket DOWN/);
    expect(t).toMatch(/last tick 900 s ago/);
    expect(t).toMatch(/stale lines NFO:1, MCX:2/);
    expect(t).toMatch(/AB1004 session expired/);
  });

  it('feed: no hub engine says why', () => {
    expect(feedText(null, 'no owner session', NOW)).toBe('hub not running: no owner session');
  });

  it('feed via the hub service; a missing hub module is said, never "unknown"', async () => {
    const a = new DeskStatusAdapter({ hub: () => ({ status: () => status(), disabledReason: () => null }), now: () => NOW });
    expect(await a.feed()).toMatch(/hub socket UP/);
    const none = new DeskStatusAdapter({ hub: () => null, now: () => NOW });
    expect(await none.feed()).toBe('hub not running: market hub service not found');
  });

  it('agents off: one line saying the calls run in-process', async () => {
    const a = new DeskStatusAdapter({ env: { AI_AGENTS: 'off' }, hub: () => null });
    expect(await a.agents()).toEqual({ all: 'off (AI_AGENTS off: AI calls run in the API process)' });
  });

  it('agents on: each container health (up with load, or down with the reason)', async () => {
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('reading')) throw new Error('connect ECONNREFUSED');
      return {
        ok: true,
        status: 200,
        json: async () => ({ group: 'trading', protocol: 1, rssMb: 91.4, agents: { 'desk.manager': { inFlight: 1, limit: 4, queued: 0, okLast5m: 7, errLast5m: 1 } } }),
      };
    });
    const a = new DeskStatusAdapter({ env: { AI_AGENTS: 'on', SENTINEL_JUDGE: 'vertex' }, fetch, hub: () => null });
    const out = await a.agents();
    expect(out.trading).toMatch(/^up: rss 91 MB, in flight 1\/4, ok 7 \/ err 1 in 5 min/);
    expect(out.reading).toMatch(/^down: connect ECONNREFUSED/);
    expect(Object.keys(out).sort()).toEqual(['background', 'reading', 'trading']);
  });
});
