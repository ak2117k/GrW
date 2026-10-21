import { Logger } from '@nestjs/common';
import { LessonsService } from './lessons.service';
import { LESSON_CACHE_TTL_MS, type LessonRecord } from './types';
import type { DiagnosisResult } from '../diagnose/types';

/** An in-memory `agentLesson` table — just the calls the service makes. */
function fakeStore(seed: Partial<LessonRecord>[] = []) {
  let n = 0;
  const rows = new Map<string, LessonRecord>();
  const put = (r: Partial<LessonRecord>) => {
    const id = r.id ?? `id${++n}`;
    const full: LessonRecord = {
      id, key: 'k', text: 't', scope: 'ALL', rightCount: 0, wrongCount: 0, status: 'ACTIVE',
      firstSeen: new Date(0), lastSeen: new Date(0), sourceRun: null, ...r,
    };
    rows.set(full.key, full);
    return full;
  };
  seed.forEach(put);
  const byWhere = (w: { key?: string; id?: string }) => [...rows.values()].find((r) => (w.key ? r.key === w.key : r.id === w.id)) ?? null;
  const agentLesson = {
    findMany: jest.fn(async (args: { where?: { status?: string; scope?: { in: string[] } } } = {}) =>
      [...rows.values()].filter(
        (r) => (!args.where?.status || r.status === args.where.status) && (!args.where?.scope || args.where.scope.in.includes(r.scope)),
      ),
    ),
    findUnique: jest.fn(async ({ where }: { where: { key?: string; id?: string } }) => byWhere(where)),
    create: jest.fn(async ({ data }: { data: Partial<LessonRecord> }) => put(data)),
    update: jest.fn(async ({ where, data }: { where: { key?: string; id?: string }; data: Partial<LessonRecord> }) => {
      const r = byWhere(where)!;
      Object.assign(r, data);
      return r;
    }),
  };
  return { rows, agentLesson };
}

const cfg = (mode?: string) => ({ get: (k: string) => (k === 'SELF_REVIEW_LESSONS' ? mode : undefined) }) as never;
const ok = (misses: DiagnosisResult['misses']): DiagnosisResult => ({ status: 'OK', misses, sent: misses.length, dropped: 0, promptVersion: 'd1' });

let t = 1_000_000;
const now = () => t;
let logSpy: jest.SpyInstance;
beforeEach(() => {
  t = 1_000_000;
  logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('LessonsService.upsertFromDiagnosis', () => {
  it('creates a new key with text, counting its cases as right', async () => {
    const store = fakeStore();
    const svc = new LessonsService(store as never, cfg(), now);
    const s = await svc.upsertFromDiagnosis('run1', ok([{ refIds: ['a', 'b'], cause: 'c', category: 'TIMING', lessonKey: 'wait-for-open', lessonText: 'Wait.', scope: 'SENTINEL_OVERNIGHT' }]));
    expect(s).toEqual({ created: ['wait-for-open'], updated: [], retired: [] });
    expect(store.rows.get('wait-for-open')).toMatchObject({ text: 'Wait.', scope: 'SENTINEL_OVERNIGHT', rightCount: 2, wrongCount: 0, status: 'ACTIVE', sourceRun: 'run1' });
  });

  it('does not create a key without text or from a contradiction only', async () => {
    const store = fakeStore();
    const svc = new LessonsService(store as never, cfg(), now);
    await svc.upsertFromDiagnosis('r', ok([{ refIds: ['a'], cause: 'c', category: 'TIMING', lessonKey: 'no-text', contradicts: ['ghost-key'] }]));
    expect(store.rows.size).toBe(0);
  });

  it('bumps counters on an existing key and keeps its text', async () => {
    const store = fakeStore([{ key: 'old-key', text: 'Original.', rightCount: 2, wrongCount: 1 }]);
    const svc = new LessonsService(store as never, cfg(), now);
    const s = await svc.upsertFromDiagnosis('r2', ok([{ refIds: ['a'], cause: 'c', category: 'TIMING', lessonKey: 'old-key', lessonText: 'Rewritten.' }]));
    expect(s.updated).toEqual(['old-key']);
    expect(store.rows.get('old-key')).toMatchObject({ text: 'Original.', rightCount: 3, wrongCount: 1, status: 'ACTIVE' });
  });

  it('auto-retires when wrong > right after ≥ 5 cases', async () => {
    const store = fakeStore([{ key: 'bad-key', rightCount: 2, wrongCount: 1 }]);
    const svc = new LessonsService(store as never, cfg(), now);
    const s = await svc.upsertFromDiagnosis('r3', ok([{ refIds: ['a', 'b'], cause: 'c', category: 'TIMING', contradicts: ['bad-key'] }]));
    expect(s).toEqual({ created: [], updated: ['bad-key'], retired: ['bad-key'] });
    expect(store.rows.get('bad-key')).toMatchObject({ rightCount: 2, wrongCount: 3, status: 'RETIRED' });
  });

  it('counts a RETIRED lesson but never revives it', async () => {
    const store = fakeStore([{ key: 'gone-key', status: 'RETIRED', rightCount: 1, wrongCount: 4 }]);
    const svc = new LessonsService(store as never, cfg(), now);
    const s = await svc.upsertFromDiagnosis('r4', ok([{ refIds: ['a', 'b', 'c', 'd'], cause: 'c', category: 'TIMING', lessonKey: 'gone-key' }]));
    expect(s.retired).toEqual([]);
    expect(store.rows.get('gone-key')).toMatchObject({ rightCount: 5, status: 'RETIRED' });
  });

  it('a null or FAILED diagnosis changes nothing; one bad key does not stop the rest', async () => {
    const store = fakeStore([{ key: 'k-one', rightCount: 2 }]);
    const svc = new LessonsService(store as never, cfg(), now);
    expect(await svc.upsertFromDiagnosis('r', null)).toEqual({ created: [], updated: [], retired: [] });
    expect(await svc.upsertFromDiagnosis('r', { status: 'FAILED', misses: [], sent: 1, dropped: 0, promptVersion: 'd1' })).toEqual({ created: [], updated: [], retired: [] });
    store.agentLesson.findUnique.mockRejectedValueOnce(new Error('db'));
    const s = await svc.upsertFromDiagnosis('r', ok([
      { refIds: ['a'], cause: 'c', category: 'TIMING', lessonKey: 'aaa-first', lessonText: 'T.' },
      { refIds: ['b'], cause: 'c', category: 'TIMING', lessonKey: 'k-one' },
    ]));
    expect(s.updated).toEqual(['k-one']);
  });
});

describe('LessonsService.retire / activeFor', () => {
  it('retire is idempotent and null for an unknown id', async () => {
    const store = fakeStore([{ id: 'L1', key: 'some-key' }]);
    const svc = new LessonsService(store as never, cfg(), now);
    expect(await svc.retire('nope')).toBeNull();
    expect((await svc.retire('L1'))?.status).toBe('RETIRED');
    expect((await svc.retire('L1'))?.status).toBe('RETIRED');
    expect(store.agentLesson.update).toHaveBeenCalledTimes(1);
  });

  it('activeFor returns the scope plus ALL', async () => {
    const store = fakeStore([{ key: 'a-live', scope: 'SENTINEL_LIVE' }, { key: 'a-all', scope: 'ALL' }, { key: 'a-news', scope: 'NEWS_IDEAS' }]);
    const svc = new LessonsService(store as never, cfg(), now);
    expect((await svc.activeFor('SENTINEL_LIVE')).map((r) => r.key).sort()).toEqual(['a-all', 'a-live']);
    expect(await svc.activeFor('ALL')).toHaveLength(3);
  });
});

describe('LessonsService.inject (the hot-path reader)', () => {
  const seed = [{ key: 'proven-key', rightCount: 3, scope: 'SENTINEL_LIVE' }, { key: 'young-key', rightCount: 1 }];

  it('on: serves the selection from cache; refreshes at most every 5 min', async () => {
    const store = fakeStore(seed);
    const svc = new LessonsService(store as never, cfg('on'), now);
    expect(svc.inject('SENTINEL_LIVE')).toEqual([]); // cold: kicks a refresh, answers empty
    await svc.refresh();
    const calls = store.agentLesson.findMany.mock.calls.length;
    expect(svc.inject('SENTINEL_LIVE').map((l) => l.key)).toEqual(['proven-key']);
    t += LESSON_CACHE_TTL_MS - 1;
    svc.inject('SENTINEL_LIVE');
    expect(store.agentLesson.findMany.mock.calls.length).toBe(calls);
    t += 1;
    svc.inject('SENTINEL_LIVE');
    expect(store.agentLesson.findMany.mock.calls.length).toBe(calls + 1);
  });

  it('off: never reads the DB, injects nothing', async () => {
    const store = fakeStore(seed);
    const svc = new LessonsService(store as never, cfg('off'), now);
    svc.onModuleInit();
    expect(svc.inject('SENTINEL_LIVE')).toEqual([]);
    expect(store.agentLesson.findMany).not.toHaveBeenCalled();
  });

  it('observe: injects nothing, logs what it would (throttled per scope)', async () => {
    const store = fakeStore(seed);
    const svc = new LessonsService(store as never, cfg('observe'), now);
    await svc.refresh();
    expect(svc.inject('SENTINEL_LIVE')).toEqual([]);
    expect(svc.inject('SENTINEL_LIVE')).toEqual([]);
    const lines = logSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('would inject'));
    expect(lines).toEqual(['[lessons] observe: would inject 1 into SENTINEL_LIVE: proven-key']);
  });

  it('a failed refresh keeps the previous cache', async () => {
    const store = fakeStore(seed);
    const svc = new LessonsService(store as never, cfg('on'), now);
    await svc.refresh();
    store.agentLesson.findMany.mockRejectedValueOnce(new Error('db down'));
    t += LESSON_CACHE_TTL_MS;
    await svc.refresh();
    expect(svc.inject('SENTINEL_LIVE').map((l) => l.key)).toEqual(['proven-key']);
  });
});
