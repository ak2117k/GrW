import { SessionClock } from '../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import type { MessagesTransport } from '../ai-gateway/transport.types';
import type { NewsRow } from '../night-report/domain/night-report.logic';
import { NewsIdeasService } from './news-ideas.service';
import { UNAVAILABLE_CHAINS, type WatchlistWriter } from './ports';
import { ScorecardEngine } from './scorecard-engine';
import type { ScorecardConfig } from './scorecard.config';
import { parseScorecardConfig } from './scorecard.config';
import type { ScorecardRepository } from './scorecard.repository';
import { ScorecardService } from './scorecard.service';
import type { Scorecard } from './scorecard.types';

const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });
const ist = (s: string) => new Date(`${s}+05:30`);
const cfg = (over: Partial<ScorecardConfig> = {}): ScorecardConfig => ({ mode: 'observe', newsIdeas: true, ownerUserId: 'owner', model: 'claude-sonnet-5', ...over });

const news = (id: string, instruments: string[], score: number): NewsRow => ({
  id, title: `${instruments[0]} news ${id}`, summary: null, source: 'ET', url: `https://n/${id}`, category: 'company',
  sentiment: score > 0 ? 'bullish' : 'bearish', sentimentScore: score, relatedSymbols: [], instruments, sectors: [], indices: [],
  markets: [], publishedAt: ist('2026-10-20T19:00:00'),
});

function fakeRepo(over: Partial<Record<keyof ScorecardRepository, unknown>> = {}) {
  const inserted: Scorecard[] = [];
  const ideas: unknown[] = [];
  const filled: Array<{ id: string; moveBp: number }> = [];
  const repo = {
    openTrackers: async () => [
      { id: 't1', userId: 'owner', symbol: 'RELIANCE28OCT261400CE', exchange: 'NFO', kind: 'POSITION', qty: 500, status: 'OPEN' },
      { id: 't2', userId: 'owner', symbol: 'TCS-EQ', exchange: 'NSE', kind: 'HOLDING', qty: 10, status: 'OPEN' },
      { id: 't3', userId: 'owner', symbol: 'CRUDEOIL19NOV26FUT', exchange: 'MCX', kind: 'POSITION', qty: 1, status: 'OPEN' },
    ],
    tracker: async (_u: string, id: string) => (id === 't1' ? { id: 't1', userId: 'owner', symbol: 'RELIANCE28OCT261400CE', exchange: 'NFO', kind: 'POSITION', qty: 500, status: 'OPEN' } : null),
    bars: async () => [{ day: '2026-10-21', open: 1250, close: 1275 }],
    vixCloses: async () => [],
    newsBetween: async () => [news('a', ['INFY'], 0.8), news('b', ['RELIANCE'], 0.9), news('c', ['NOTFNO'], 0.9)],
    articleUrls: async () => new Map(),
    dailySetups: async () => [],
    fnoNames: async () => new Set(['INFY', 'RELIANCE', 'TCS']),
    ideaNewsIdsSince: async () => new Set<string>(),
    insertScorecard: async (sc: Scorecard) => { inserted.push(sc); return `sc${inserted.length}`; },
    insertIdeas: async (items: unknown[]) => { ideas.push(...items); return items.length; },
    latestScorecard: async () => null,
    unfilled: async () => [
      { table: 'scorecard', id: 's1', underlying: 'RELIANCE', at: ist('2026-10-19T15:40:00') },
      { table: 'idea', id: 'i1', underlying: 'INFY', at: ist('2026-10-21T08:40:00') },
    ],
    fill: async (t: { id: string }, o: { moveBp: number }) => { filled.push({ id: t.id, moveBp: o.moveBp }); },
    ...over,
  };
  return { repo: repo as unknown as ScorecardRepository, inserted, ideas, filled };
}

const engineFor = (repo: ScorecardRepository) => new ScorecardEngine(repo, UNAVAILABLE_CHAINS, null, null, clock);

describe('config', () => {
  it('flags default off', () => {
    expect(parseScorecardConfig({})).toMatchObject({ mode: 'off', newsIdeas: false, ownerUserId: null, model: 'claude-sonnet-5' });
    expect(parseScorecardConfig({ SCORECARD_ENABLED: 'observe', NEWS_IDEAS_ENABLED: 'on', AI_AUTO_EXIT_USER_IDS: 'a,b' })).toMatchObject({ mode: 'observe', newsIdeas: true, ownerUserId: 'a' });
  });
});

describe('ScorecardService', () => {
  it('scores only the owner\'s overnight broker positions and stores one row each (OI unavailable pre-merge)', async () => {
    const f = fakeRepo();
    const svc = new ScorecardService(f.repo, engineFor(f.repo), cfg(), clock, () => ist('2026-10-19T15:40:00'));
    const r = await svc.run('OVERNIGHT', ist('2026-10-19T15:40:00'));
    expect(r).toEqual({ ran: true, stored: 1 });
    expect(f.inserted[0]).toMatchObject({ symbol: 'RELIANCE28OCT261400CE', side: 'BULLISH', window: 'OVERNIGHT', userId: 'owner' });
    expect(f.inserted[0].factors.find((x) => x.name === 'oi')).toMatchObject({ available: false, points: 0 });
    expect(f.inserted[0].factors.find((x) => x.name === 'news')).toMatchObject({ available: true, points: 2 });
  });

  it('does nothing when off or on the Dussehra holiday', async () => {
    const f = fakeRepo();
    expect((await new ScorecardService(f.repo, engineFor(f.repo), cfg({ mode: 'off' }), clock, () => new Date()).run('OVERNIGHT', ist('2026-10-19T15:40:00'))).ran).toBe(false);
    expect((await new ScorecardService(f.repo, engineFor(f.repo), cfg(), clock, () => new Date()).run('OVERNIGHT', ist('2026-10-20T15:40:00'))).ran).toBe(false);
    expect(f.inserted).toHaveLength(0);
  });

  it('latest() feeds the sentinel only with SCORECARD_ENABLED=on', async () => {
    const card = { id: 'x' } as Scorecard;
    const f = fakeRepo({ latestScorecard: async () => card });
    const now = () => ist('2026-10-19T15:45:00');
    expect(await new ScorecardService(f.repo, engineFor(f.repo), cfg({ mode: 'observe' }), clock, now).latest('owner', 't1')).toBeNull();
    expect(await new ScorecardService(f.repo, engineFor(f.repo), cfg({ mode: 'on' }), clock, now).latest('owner', 't1')).toBe(card);
    expect(await new ScorecardService(f.repo, engineFor(f.repo), cfg({ mode: 'on' }), clock, now).latest('owner', 'nope')).toBeNull();
  });

  it('outcome filler fills rows whose next session closed and leaves the rest', async () => {
    const f = fakeRepo();
    const svc = new ScorecardService(f.repo, engineFor(f.repo), cfg(), clock, () => new Date());
    expect(await svc.fillOutcomes(ist('2026-10-21T18:30:00'))).toBe(2);
    expect(f.filled).toEqual([{ id: 's1', moveBp: 200 }, { id: 'i1', moveBp: 200 }]);
  });
});

describe('NewsIdeasService', () => {
  const NOW = ist('2026-10-20T23:30:00'); // Dussehra night, Wed opens
  const reply = (text: string) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
  const llm = (text: string | Error) => {
    const calls: unknown[] = [];
    const t: MessagesTransport = {
      messages: { create: async (p) => { calls.push(p); if (text instanceof Error) throw text; return reply(text); } },
    };
    return { t, calls };
  };
  const watch = (): WatchlistWriter & { added: string[] } => {
    const added: string[] = [];
    return { added, add: async (s) => { added.push(...s.map((x) => x.symbol)); } };
  };
  const ideaJson = JSON.stringify({ ideas: [{ symbol: 'INFY', idea: 'CE_IDEA', rationale: 'r', invalidation: 'i', whatToDo: 'w' }] });

  it('one Sonnet call per batch; F&O, not held; stores ideas with their scorecards; registers the watchlist', async () => {
    const f = fakeRepo();
    const l = llm(ideaJson);
    const w = watch();
    const svc = new NewsIdeasService(f.repo, engineFor(f.repo), cfg(), clock, () => NOW, l.t, w);
    const r = await svc.run('NIGHT', NOW);
    expect(r).toEqual({ ran: true, candidates: 1, stored: 1 });
    expect(l.calls).toHaveLength(1);
    expect((l.calls[0] as { model: string }).model).toBe('claude-sonnet-5');
    expect(w.added).toEqual(['INFY']); // RELIANCE is held, NOTFNO has no F&O
    expect(f.ideas[0]).toMatchObject({ scorecard: { window: 'NEWS_IDEA', userId: null, side: 'BULLISH' }, idea: { symbol: 'INFY', idea: 'CE_IDEA', newsIds: ['a'] } });
  });

  it.each([
    ['invalid JSON', 'not json'],
    ['schema violation', JSON.stringify({ ideas: [{ symbol: 'INFY', idea: 'BUY', rationale: 'r', invalidation: 'i', whatToDo: 'w' }] })],
    ['transport failure', new Error('rate limited')],
  ])('%s ⇒ stores nothing', async (_l, text) => {
    const f = fakeRepo();
    const svc = new NewsIdeasService(f.repo, engineFor(f.repo), cfg(), clock, () => NOW, llm(text).t, watch());
    const r = await svc.run('NIGHT', NOW);
    expect(r.stored).toBe(0);
    expect(f.ideas).toHaveLength(0);
  });

  it('skips when off, or the night before the holiday', async () => {
    const f = fakeRepo();
    const l = llm(ideaJson);
    expect((await new NewsIdeasService(f.repo, engineFor(f.repo), cfg({ newsIdeas: false }), clock, () => NOW, l.t, watch()).run('NIGHT', NOW)).ran).toBe(false);
    expect((await new NewsIdeasService(f.repo, engineFor(f.repo), cfg(), clock, () => NOW, l.t, watch()).run('NIGHT', ist('2026-10-19T23:30:00'))).ran).toBe(false);
    expect(l.calls).toHaveLength(0);
  });
});
