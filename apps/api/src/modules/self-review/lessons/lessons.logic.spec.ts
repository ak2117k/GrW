import { clampText, isLessonKey, lessonDeltas, lessonsModeFrom, scopeForKind, selectForInjection, shouldRetire } from './lessons.logic';
import type { LessonRecord } from './types';
import type { DiagnosisResult } from '../diagnose/types';

const row = (over: Partial<LessonRecord>): LessonRecord => ({
  id: over.key ?? 'id',
  key: 'k',
  text: 'Do the thing.',
  scope: 'ALL',
  rightCount: 2,
  wrongCount: 0,
  status: 'ACTIVE',
  firstSeen: new Date(0),
  lastSeen: new Date(0),
  sourceRun: null,
  ...over,
});

describe('lessonsModeFrom', () => {
  it.each([
    [undefined, 'on'], ['', 'on'], [' on ', 'on'], ['TRUE', 'on'], ['1', 'on'],
    ['off', 'off'], ['false', 'off'], ['0', 'off'],
    ['observe', 'observe'], ['ture', 'observe'],
  ])('%p → %s', (raw, mode) => expect(lessonsModeFrom(raw as string | undefined)).toBe(mode));
});

describe('selectForInjection', () => {
  it('only ACTIVE, rightCount ≥ 2, own scope or ALL', () => {
    const rows = [
      row({ key: 'live', scope: 'SENTINEL_LIVE' }),
      row({ key: 'all', scope: 'ALL' }),
      row({ key: 'news', scope: 'NEWS_IDEAS' }),
      row({ key: 'retired', status: 'RETIRED', rightCount: 9 }),
      row({ key: 'young', rightCount: 1 }),
      row({ key: 'blank', text: '   ' }),
    ];
    expect(selectForInjection(rows, 'SENTINEL_LIVE').map((l) => l.key)).toEqual(['all', 'live']);
    expect(selectForInjection(rows, 'NEWS_IDEAS').map((l) => l.key)).toEqual(['all', 'news']);
    expect(selectForInjection(rows, 'SENTINEL_OVERNIGHT').map((l) => l.key)).toEqual(['all']);
  });

  it('sorts by right − wrong, then right, then key; caps at 8', () => {
    const rows = [
      row({ key: 'b', rightCount: 5, wrongCount: 4 }), // net 1
      row({ key: 'a', rightCount: 3, wrongCount: 0 }), // net 3
      row({ key: 'c', rightCount: 6, wrongCount: 3 }), // net 3, more right
      ...Array.from({ length: 10 }, (_, i) => row({ key: `z${i}`, rightCount: 2, wrongCount: 2 })),
    ];
    const out = selectForInjection(rows, 'SENTINEL_LIVE');
    expect(out).toHaveLength(8);
    expect(out.slice(0, 3).map((l) => l.key)).toEqual(['c', 'a', 'b']);
    expect(out[0]).toEqual({ key: 'c', text: 'Do the thing.', right: 6, wrong: 3 });
  });

  it('cuts text to 400 chars', () => {
    const [l] = selectForInjection([row({ text: 'word '.repeat(200) })], 'NEWS_IDEAS');
    expect(l.text.length).toBeLessThanOrEqual(400);
    expect(l.text.endsWith('…')).toBe(true);
  });
});

describe('clampText / isLessonKey / scopeForKind', () => {
  it('collapses whitespace and leaves short text alone', () => expect(clampText('  a\n b  ')).toBe('a b'));
  it.each([['theta-exit-on-put', true], ['ab', false], ['Bad_Key', false], ['-x-', false], ['a'.repeat(61), false]])(
    'key %p → %p',
    (k, ok) => expect(isLessonKey(k)).toBe(ok),
  );
  it('maps kinds to scopes', () => {
    expect(scopeForKind('OVERNIGHT_VERDICT')).toBe('SENTINEL_OVERNIGHT');
    expect(scopeForKind('LIVE_EXIT')).toBe('SENTINEL_LIVE');
    expect(scopeForKind('NEWS_IDEA')).toBe('NEWS_IDEAS');
    expect(scopeForKind('SCORECARD_FACTOR')).toBe('ALL');
  });
});

describe('shouldRetire', () => {
  it.each([
    [1, 3, false], // 4 cases: too few
    [2, 3, true], // 5 cases, wrong > right
    [3, 3, false], // tie
    [0, 5, true],
    [5, 4, false],
  ])('right %i wrong %i → %p', (r, w, out) => expect(shouldRetire(r, w)).toBe(out));
});

describe('lessonDeltas', () => {
  const result = (misses: DiagnosisResult['misses']): DiagnosisResult => ({ status: 'OK', misses, sent: 3, dropped: 0, promptVersion: 'd1' });

  it('counts distinct refIds per key; contradicts count wrong; a refId both ways counts neither', () => {
    const out = lessonDeltas(
      result([
        { refIds: ['r1', 'r2'], cause: 'c', category: 'THESIS_WRONG', lessonKey: 'new-one', lessonText: 'Text.', scope: 'SENTINEL_OVERNIGHT', contradicts: ['old-one'] },
        { refIds: ['r2', 'r3'], cause: 'c', category: 'TIMING', lessonKey: 'new-one' },
        { refIds: ['r3'], cause: 'c', category: 'TIMING', lessonKey: 'old-one', contradicts: ['new-one'] },
      ]),
    );
    expect(out).toEqual([
      { key: 'new-one', right: 2, wrong: 0, text: 'Text.', scope: 'SENTINEL_OVERNIGHT' }, // r3 both ways
      { key: 'old-one', right: 1, wrong: 2, text: null, scope: 'ALL' },
    ]);
  });

  it('infers scope from the first refId kind when the diagnosis gave none', () => {
    const out = lessonDeltas(result([{ refIds: ['v1'], cause: 'c', category: 'TIMING', lessonKey: 'abc', lessonText: 'T.' }]), () => 'NEWS_IDEA');
    expect(out[0].scope).toBe('NEWS_IDEAS');
  });

  it('nothing from a FAILED or SKIPPED diagnosis', () => {
    expect(lessonDeltas({ status: 'FAILED', misses: [], sent: 1, dropped: 0, promptVersion: 'd1' })).toEqual([]);
  });
});
