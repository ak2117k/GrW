import { SessionClock } from '../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import type { MessagesTransport } from '../ai-gateway/transport.types';
import type { NewsRow } from '../night-report/domain/night-report.logic';
import { NewsIdeasService } from './news-ideas.service';
import { NEWS_IDEAS_SYSTEM_PROMPT, newsIdeasSystemPrompt } from './domain/news-ideas-ai';
import { UNAVAILABLE_CHAINS, type WatchlistWriter } from './ports';
import { ScorecardEngine, STORED_MOOD_MAX_AGE_MS } from './scorecard-engine';
import { ScorecardBarBackfill } from './scorecard-bar-backfill';
import { shapeOf } from './domain/positions';
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

  it('self-review lessons (scope NEWS_IDEAS) ride in the user message and add one system line; none ⇒ the prompt is unchanged', async () => {
    const lesson = { key: 'wait-for-oi', text: 'Wait for OI to confirm a results gap.', right: 3, wrong: 0 };
    const inject = jest.fn(() => [lesson]);
    const f = fakeRepo();
    const l = llm(ideaJson);
    await new NewsIdeasService(f.repo, engineFor(f.repo), cfg(), clock, () => NOW, l.t, watch(), null, { inject }).run('NIGHT', NOW);
    expect(inject).toHaveBeenCalledWith('NEWS_IDEAS');
    const p = l.calls[0] as { system: Array<{ text: string }>; messages: Array<{ content: string }> };
    expect(JSON.parse(p.messages[0].content).lessons).toEqual([lesson]);
    expect(p.system[0].text).toBe(newsIdeasSystemPrompt(true));
    expect(p.system[0].text).toContain('never rules');

    const f2 = fakeRepo();
    const l2 = llm(ideaJson);
    await new NewsIdeasService(f2.repo, engineFor(f2.repo), cfg(), clock, () => NOW, l2.t, watch(), null, { inject: () => [] }).run('NIGHT', NOW);
    const p2 = l2.calls[0] as { system: Array<{ text: string }>; messages: Array<{ content: string }> };
    expect(p2.system[0].text).toBe(NEWS_IDEAS_SYSTEM_PROMPT);
    expect('lessons' in JSON.parse(p2.messages[0].content)).toBe(false);
  });

  it('skips when off, or the night before the holiday', async () => {
    const f = fakeRepo();
    const l = llm(ideaJson);
    expect((await new NewsIdeasService(f.repo, engineFor(f.repo), cfg({ newsIdeas: false }), clock, () => NOW, l.t, watch()).run('NIGHT', NOW)).ran).toBe(false);
    expect((await new NewsIdeasService(f.repo, engineFor(f.repo), cfg(), clock, () => NOW, l.t, watch()).run('NIGHT', ist('2026-10-19T23:30:00'))).ran).toBe(false);
    expect(l.calls).toHaveLength(0);
  });

  it('captures the F&O candidates\' chains BEFORE scoring them, so OI reads a snapshot', async () => {
    const f = fakeRepo();
    const order: string[] = [];
    const chains = {
      latest: async (s: string) => { order.push(`read:${s}`); return null; },
      history: async () => [],
    };
    const capture = { captureFor: jest.fn(async (s: readonly string[]) => { order.push(`capture:${s.join(',')}`); }) };
    const engine = new ScorecardEngine(f.repo, chains, null, null, clock);
    const svc = new NewsIdeasService(f.repo, engine, cfg(), clock, () => NOW, llm(ideaJson).t, watch(), capture);
    expect((await svc.run('NIGHT', NOW)).stored).toBe(1);
    expect(capture.captureFor).toHaveBeenCalledWith(['INFY']);
    expect(order).toEqual(['capture:INFY', 'read:INFY']);
  });

  it('a failed candidate capture is soft: the batch still scores and stores', async () => {
    const f = fakeRepo();
    const capture = { captureFor: jest.fn(async () => { throw new Error('throttled'); }) };
    const svc = new NewsIdeasService(f.repo, engineFor(f.repo), cfg(), clock, () => NOW, llm(ideaJson).t, watch(), capture);
    expect(await svc.run('NIGHT', NOW)).toEqual({ ran: true, candidates: 1, stored: 1 });
  });
});

describe('ScorecardEngine: short candles + after-hours mood', () => {
  const NOW = ist('2026-10-19T15:45:00');
  const shape = shapeOf('RELIANCE28OCT261400CE', 'NFO', 500);
  const rising = (n: number) => Array.from({ length: n }, (_, i) => ({ day: `d${i}`, open: 100 + i, close: 100 + i + Math.sin(i) }));

  it('fewer than 35 daily bars ⇒ one backfill per timeframe, then re-read: indicators available', async () => {
    let filled = false;
    const f = fakeRepo({ bars: async () => (filled ? rising(60) : rising(3)) });
    const backfill = { fill: jest.fn(async (_name: string, _tf: '1d' | '15m') => { filled = true; return 60; }) };
    const engine = new ScorecardEngine(f.repo, UNAVAILABLE_CHAINS, null, null, clock, backfill);
    const sc = await engine.score(await engine.context('OVERNIGHT', NOW), { userId: 'owner', symbol: 'X', exchange: 'NFO', shape, window: 'OVERNIGHT' });
    expect(backfill.fill.mock.calls.map((c) => c[1]).sort()).toEqual(['15m', '1d']);
    expect(sc.factors.find((x) => x.name === 'indicators')).toMatchObject({ available: true });
  });

  it('enough stored bars ⇒ no backfill; a failing backfill keeps "unavailable"', async () => {
    const deep = fakeRepo({ bars: async () => rising(60) });
    const noCall = { fill: jest.fn(async () => 0) };
    const e1 = new ScorecardEngine(deep.repo, UNAVAILABLE_CHAINS, null, null, clock, noCall);
    await e1.score(await e1.context('OVERNIGHT', NOW), { userId: 'owner', symbol: 'X', exchange: 'NFO', shape, window: 'OVERNIGHT' });
    expect(noCall.fill).not.toHaveBeenCalled();

    const short = fakeRepo({ bars: async () => rising(3) });
    const failing = { fill: jest.fn(async () => { throw new Error('no session'); }) };
    const e2 = new ScorecardEngine(short.repo, UNAVAILABLE_CHAINS, null, null, clock, failing);
    const sc = await e2.score(await e2.context('OVERNIGHT', NOW), { userId: 'owner', symbol: 'X', exchange: 'NFO', shape, window: 'OVERNIGHT' });
    expect(sc.factors.find((x) => x.name === 'indicators')).toMatchObject({ available: false, reason: 'unavailable: fewer than 35 daily candles' });
  });

  it('live MBM behaviour absent ⇒ the last session\'s stored NIFTY predictions, labelled with their as-of', async () => {
    const storedMood = jest.fn(async () => ({ asOf: ist('2026-10-19T15:25:00'), horizons: { '30m': { p: 0.3, regime: 'NORMAL' }, '60m': { p: 0.71, regime: 'ACTIVE' } } }));
    const f = fakeRepo({ storedMood });
    const mood = { behaviour: async () => ({ status: 'absent' as const }) };
    const engine = new ScorecardEngine(f.repo, UNAVAILABLE_CHAINS, null, mood, clock);
    const sc = await engine.score(await engine.context('OVERNIGHT', NOW), { userId: 'owner', symbol: 'X', exchange: 'NFO', shape, window: 'OVERNIGHT' });
    expect(storedMood).toHaveBeenCalledWith('NIFTY', NOW, STORED_MOOD_MAX_AGE_MS);
    expect(sc.factors.find((x) => x.name === 'mood')).toMatchObject({
      points: 0, available: true, value: 'NIFTY 60m: p(big) 0.71 → big move (beta n/a, as of 2026-10-19 15:25 IST)',
    });
  });

  it('a stock long option gets its beta to NIFTY from the daily bars, and the expected move votes', async () => {
    const series = (k: number) => {
      let x = 100;
      return Array.from({ length: 61 }, (_, i) => ({ day: `2026-07-${i}`, open: x, close: (x *= Math.exp(k * 0.01 * Math.sin(i * 1.3))) }));
    };
    const bars = jest.fn(async (name: string, _tf?: string) => (name === 'NIFTY' ? series(1) : series(1.5)));
    const f = fakeRepo({ bars, storedMood: async () => ({ asOf: ist('2026-10-19T15:29:00'), horizons: { '60m': { p: 0.71, regime: 'ACTIVE' } } }) });
    const engine = new ScorecardEngine(f.repo, UNAVAILABLE_CHAINS, null, null, clock);
    const ctx = await engine.context('OVERNIGHT', NOW);
    const sc = await engine.score(ctx, { userId: 'owner', symbol: 'X', exchange: 'NFO', shape, window: 'OVERNIGHT' });
    expect(sc.factors.find((x) => x.name === 'mood')).toMatchObject({
      points: 1, value: 'NIFTY 60m: p(big) 0.71 → big move (beta 1.50, as of 2026-10-19 15:29 IST)',
    });
    // NIFTY's dailies are read once per run, however many stocks are scored.
    await engine.score(ctx, { userId: 'owner', symbol: 'Y', exchange: 'NFO', shape: shapeOf('TCS28OCT263000CE', 'NFO', 100), window: 'OVERNIGHT' });
    expect(bars.mock.calls.filter((c) => c[0] === 'NIFTY' && c[1] === '1d')).toHaveLength(1);
  });

  it('live MBM behaviour ok ⇒ stored predictions are not read', async () => {
    const storedMood = jest.fn();
    const f = fakeRepo({ storedMood });
    const mood = { behaviour: async () => ({ status: 'ok' as const, horizons: { '30m': { p: 0.2, regime: 'QUIET' } } }) };
    const engine = new ScorecardEngine(f.repo, UNAVAILABLE_CHAINS, null, mood, clock);
    const ctx = await engine.context('OVERNIGHT', NOW);
    expect(storedMood).not.toHaveBeenCalled();
    expect(ctx.mood).toMatchObject({ status: 'ok', horizons: { '30m': { regime: 'QUIET' } } });
  });
});

describe('ScorecardBarBackfill', () => {
  const inst = { id: 'i1', token: '2885', exchange: 'NSE' };
  const bar = (iso: string, close: number) => ({ timestamp: new Date(iso), open: close, high: close, low: close, close, volume: 10 });
  const build = (now: Date, rows: ReturnType<typeof bar>[], user: string | null = 'owner') => {
    const fetchCandles = jest.fn(async () => rows);
    const saveCandles = jest.fn(async (r: unknown[]) => r.length);
    const repo = { underlyingInstrument: jest.fn(async () => inst) };
    return { b: new ScorecardBarBackfill(repo as never, { fetchCandles } as never, { saveCandles }, user, () => now), fetchCandles, saveCandles, repo };
  };

  it('fetches ~95 days of 1d over the owner session, persists into candles, once per IST day', async () => {
    const now = ist('2026-10-19T23:30:00');
    const t = build(now, [bar('2026-10-16T00:00:00+05:30', 1), bar('2026-10-19T00:00:00+05:30', 2)]);
    expect(await t.b.fill('RELIANCE', '1d')).toBe(2);
    expect(t.fetchCandles).toHaveBeenCalledWith('owner', '2885', 'NSE', '1d', new Date(now.getTime() - 95 * 86_400_000), now);
    expect(t.saveCandles.mock.calls[0][0]).toEqual([
      expect.objectContaining({ instrumentId: 'i1', timeframe: '1d', close: 1 }),
      expect.objectContaining({ instrumentId: 'i1', timeframe: '1d', close: 2 }),
    ]);
    expect(await t.b.fill('RELIANCE', '1d')).toBe(0);
    expect(t.fetchCandles).toHaveBeenCalledTimes(1);
  });

  it('never stores a still-forming bar (today\'s daily before 16:00 IST, the open 15m bar)', async () => {
    const now = ist('2026-10-19T11:07:00');
    const d = build(now, [bar('2026-10-16T00:00:00+05:30', 1), bar('2026-10-19T00:00:00+05:30', 2)]);
    expect(await d.b.fill('RELIANCE', '1d')).toBe(1);
    const m = build(now, [bar('2026-10-19T10:45:00+05:30', 1), bar('2026-10-19T11:00:00+05:30', 2)]);
    expect(await m.b.fill('RELIANCE', '15m')).toBe(1);
  });

  it('no owner session configured ⇒ no broker call', async () => {
    const t = build(ist('2026-10-19T23:30:00'), [], null);
    expect(await t.b.fill('RELIANCE', '1d')).toBe(0);
    expect(t.fetchCandles).not.toHaveBeenCalled();
  });
});
