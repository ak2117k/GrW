/**
 * Pure lesson rules: the flag, injection selection, counter deltas from a diagnosis and
 * the auto-retire rule. No I/O — `LessonsService` applies these to the database.
 */
import type { DiagnosisResult } from '../diagnose/types';
import {
  LESSON_SCOPES,
  LESSON_TEXT_MAX,
  MAX_INJECTED_LESSONS,
  MIN_RIGHT_TO_INJECT,
  RETIRE_MIN_CASES,
  type InjectedLesson,
  type InjectionScope,
  type LessonRecord,
  type LessonScope,
  type LessonsMode,
} from './types';

/**
 * `SELF_REVIEW_LESSONS`. Unset/blank → `on` (the contract default); `off|false|0` → off;
 * `on|true|1` → on; `observe` → observe. Anything else is a typo and lands on `observe`:
 * it changes no prompt, and the log says what would have been injected.
 */
export function lessonsModeFrom(raw: string | undefined | null): LessonsMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'on' || v === 'true' || v === '1') return 'on';
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  return 'observe';
}

export function isLessonScope(v: unknown): v is LessonScope {
  return typeof v === 'string' && (LESSON_SCOPES as readonly string[]).includes(v);
}

/** A lesson key: lowercase slug, 3–60 chars. */
export const LESSON_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function isLessonKey(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 3 && v.length <= 60 && LESSON_KEY_RE.test(v);
}

/** `text` cut to `max` chars on a word boundary where one is near, with an ellipsis. */
export function clampText(text: string, max = LESSON_TEXT_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The lessons an agent in `scope` is shown: ACTIVE, `rightCount >= 2`, scope matching (or
 * `ALL`), highest `right − wrong` first (then more right cases, then key, so the order —
 * and the prompt-cache prefix — is stable), at most 8, each ≤ 400 chars.
 */
export function selectForInjection(rows: readonly LessonRecord[], scope: InjectionScope): InjectedLesson[] {
  return rows
    .filter(
      (r) =>
        r.status === 'ACTIVE' &&
        r.rightCount >= MIN_RIGHT_TO_INJECT &&
        (r.scope === scope || r.scope === 'ALL') &&
        r.text.trim() !== '',
    )
    .sort(
      (a, b) =>
        b.rightCount - b.wrongCount - (a.rightCount - a.wrongCount) ||
        b.rightCount - a.rightCount ||
        a.key.localeCompare(b.key),
    )
    .slice(0, MAX_INJECTED_LESSONS)
    .map((r) => ({ key: r.key, text: clampText(r.text), right: r.rightCount, wrong: r.wrongCount }));
}

/** Auto-retire: wrong > right once at least 5 cases have been counted. */
export function shouldRetire(rightCount: number, wrongCount: number): boolean {
  return rightCount + wrongCount >= RETIRE_MIN_CASES && wrongCount > rightCount;
}

/** Per lesson key, what one diagnosis adds. */
export interface LessonDelta {
  key: string;
  right: number;
  wrong: number;
  /** From the first miss that named the key with text (used only when the key is new). */
  text: string | null;
  scope: LessonScope;
}

/** Which scope a miss of `kind` belongs to when the diagnosis did not say. */
export function scopeForKind(kind: string | undefined): LessonScope {
  switch (kind) {
    case 'OVERNIGHT_VERDICT':
      return 'SENTINEL_OVERNIGHT';
    case 'LIVE_EXIT':
      return 'SENTINEL_LIVE';
    case 'NEWS_IDEA':
      return 'NEWS_IDEAS';
    default:
      return 'ALL';
  }
}

/**
 * Counter deltas from one diagnosis. A miss naming `lessonKey` adds its distinct refIds to
 * that lesson's `right` (following the lesson would have avoided the miss); a miss listing a
 * key in `contradicts` adds its refIds to that lesson's `wrong`. A refId counts at most once
 * per key per run, and a key both named and contradicted by the same refId counts neither.
 */
export function lessonDeltas(result: DiagnosisResult, kindOf: (refId: string) => string | undefined = () => undefined): LessonDelta[] {
  if (result.status !== 'OK') return [];
  const right = new Map<string, Set<string>>();
  const wrong = new Map<string, Set<string>>();
  const meta = new Map<string, { text: string | null; scope: LessonScope }>();
  const add = (m: Map<string, Set<string>>, key: string, ids: readonly string[]) => {
    const s = m.get(key) ?? new Set<string>();
    ids.forEach((id) => s.add(id));
    m.set(key, s);
  };
  for (const miss of result.misses) {
    if (miss.lessonKey) {
      add(right, miss.lessonKey, miss.refIds);
      const prev = meta.get(miss.lessonKey);
      if (!prev || (!prev.text && miss.lessonText)) {
        meta.set(miss.lessonKey, {
          text: miss.lessonText ? clampText(miss.lessonText) : null,
          scope: miss.scope ?? scopeForKind(kindOf(miss.refIds[0])),
        });
      }
    }
    for (const key of miss.contradicts ?? []) add(wrong, key, miss.refIds);
  }
  const keys = [...new Set([...right.keys(), ...wrong.keys()])].sort();
  return keys
    .map((key) => {
      const r = right.get(key) ?? new Set<string>();
      const w = wrong.get(key) ?? new Set<string>();
      const both = [...r].filter((id) => w.has(id)).length;
      return {
        key,
        right: r.size - both,
        wrong: w.size - both,
        text: meta.get(key)?.text ?? null,
        scope: meta.get(key)?.scope ?? 'ALL',
      };
    })
    .filter((d) => d.right > 0 || d.wrong > 0);
}
