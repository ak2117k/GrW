/**
 * Resolve `p` if it settles within `ms`; otherwise resolve to `fallback`.
 *
 * The underlying promise is NOT cancelled — it keeps running and its late
 * result (or rejection) is ignored. Use this to bound a slow or hanging
 * dependency on a request path so the response can't block past the budget.
 *
 * A rejection within the budget also resolves to `fallback` (never throws),
 * so callers get graceful degradation rather than a 500.
 */
export function withBudget<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), ms);
    p.then(
      (v) => finish(v),
      () => finish(fallback),
    );
  });
}
