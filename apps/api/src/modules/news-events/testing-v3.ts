/**
 * Jest helpers for position news context v3 (imported only by specs, like `testing.ts`): stubs for the
 * cross-stream interfaces so every stream can build before the real implementations land (bound in I1).
 */
import type { IndexedArticle, NewsPosition } from './types';
import { positionKeyOf } from './context-types';
import type {
  ContextVerdict, EntityProfile, NewsLlm, NewsLlmRequest, NewsLlmResult, NightBudgetSnapshot, PositionMatch, PositionMatchesPeek, WordPolicy,
} from './context-types';

/** A WordPolicy from explicit lists — for streams that build before R2 lands. */
export function stubWordPolicy(o: { needsContext?: string[]; person?: string[]; company?: string[] } = {}): WordPolicy {
  const lc = (xs: string[]) => new Set(xs.map((w) => w.toLowerCase()));
  const nc = lc(o.needsContext ?? ['Shah', 'Trent', 'Bailey', 'Apollo']);
  const person = lc(o.person ?? ['says', 'said', 'analyst', 'analysts', 'CEO', 'Mr', 'Ms']);
  const company = lc(o.company ?? ['Ltd', 'Limited', 'shares', 'stock', 'results', 'profit', 'IPO']);
  return {
    needsContext: (w) => nc.has(w.toLowerCase()),
    verdictAt(tokens, start, end): ContextVerdict {
      const win = [...tokens.slice(Math.max(0, start - 6), start), ...tokens.slice(end, end + 6)].map((t) => t.toLowerCase());
      if (win.some((t) => person.has(t))) return 'person';
      return win.some((t) => company.has(t)) ? 'company' : 'none';
    },
  };
}

export function profile(over: Partial<EntityProfile> & Pick<EntityProfile, 'symbol' | 'kind'>): EntityProfile {
  return { names: [], parent: [], subsidiaries: [], related: [], people: [], products: [], drivers: [], sector: null, indices: [], exclusions: [], ...over };
}

export function match(over: Partial<PositionMatch> & { articleId: string }): PositionMatch {
  return { layer: 'own', via: 'name', why: 'name: X', strength: 'strong', wakes: true, publishedAt: Date.UTC(2026, 9, 16, 4, 30), ...over };
}

/** Scripted NewsLlm: replies consumed in order; every request recorded. */
export function fakeNewsLlm(replies: NewsLlmResult[] = []) {
  const calls: NewsLlmRequest[] = [];
  let open: Date | null = null;
  const zero: NightBudgetSnapshot = { calls: 0, tokensIn: 0, tokensOut: 0, costInr: 0 };
  const llm: NewsLlm = {
    async call(req) {
      calls.push(req);
      if (open) return { ok: false, reason: 'breaker-open', detail: `stub breaker until ${open.toISOString()}` };
      return replies.shift() ?? { ok: false, reason: 'error', detail: 'fakeNewsLlm: no scripted reply' };
    },
    breakerOpenUntil: () => open,
    usage: () => ({ ...zero, calls: calls.length }),
  };
  return Object.assign(llm, { calls, openBreakerUntil: (d: Date | null) => { open = d; } });
}

export function fakePositionNews(peeks: Record<string, PositionMatchesPeek> = {}, wake: (a: IndexedArticle) => string[] = () => []) {
  return {
    setWatched: jest.fn((_: readonly NewsPosition[]) => undefined),
    peek: jest.fn((p: NewsPosition, _now?: Date): PositionMatchesPeek => peeks[positionKeyOf(p)] ?? { status: 'unavailable', reason: 'no stub peek' }),
    wakeHits: jest.fn(wake),
  };
}

export function fakeFeedbackSink() {
  return { recordJudge: jest.fn() };
}
