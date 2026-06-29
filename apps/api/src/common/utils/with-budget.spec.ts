import { withBudget } from './with-budget';

const delay = <T>(ms: number, value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

describe('withBudget', () => {
  it('resolves with the real value when the promise settles within the budget', async () => {
    const result = await withBudget(delay(10, 'real'), 100, 'fallback');
    expect(result).toBe('real');
  });

  it('resolves with the fallback when the promise exceeds the budget', async () => {
    // Simulates a hanging/slow dependency (e.g. a dead-feed getLtpsBatch) — the
    // request path must not block past the budget.
    const result = await withBudget(delay(200, 'too-late'), 30, 'fallback');
    expect(result).toBe('fallback');
  });

  it('resolves with the fallback when the underlying promise rejects', async () => {
    const result = await withBudget(Promise.reject(new Error('boom')), 100, 'fallback');
    expect(result).toBe('fallback');
  });
});
