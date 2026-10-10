import { resolveAppendOnly, type AppendOnlyRow } from './append-only';

const T = (iso: string) => new Date(iso);
const row = (id: string, createdAt: string, effectiveFrom: string = createdAt): AppendOnlyRow => ({
  id,
  createdAt: T(createdAt),
  effectiveFrom: T(effectiveFrom),
});

// Mon 2026-10-12 10:30 IST; the next session open is Tue 2026-10-13 09:15 IST (03:45Z).
const NOW = T('2026-10-12T05:00:00.000Z');
const NEXT_OPEN = '2026-10-13T03:45:00.000Z';

describe('resolveAppendOnly (spec §5.2: the latest row whose effectiveFrom ≤ now)', () => {
  it('no rows: nothing in force, nothing pending', () => {
    expect(resolveAppendOnly([], NOW)).toEqual({ inForce: null, pending: null, newest: null });
  });

  it('a row effective exactly now is in force', () => {
    const r = row('a', '2026-10-12T05:00:00.000Z');
    expect(resolveAppendOnly([r], NOW)).toEqual({ inForce: r, pending: null, newest: r });
  });

  it('a loosening waits: the old row stays in force and the new one is pending until its time', () => {
    const old = row('a', '2026-10-09T03:00:00.000Z');
    const loosen = row('b', '2026-10-12T04:00:00.000Z', NEXT_OPEN);
    expect(resolveAppendOnly([old, loosen], NOW)).toEqual({ inForce: old, pending: loosen, newest: loosen });
    expect(resolveAppendOnly([old, loosen], T(NEXT_OPEN))).toEqual({ inForce: loosen, pending: null, newest: loosen });
  });

  it('a tightening made after a pending loosening supersedes it for good', () => {
    const old = row('a', '2026-10-09T03:00:00.000Z');
    const loosen = row('b', '2026-10-12T04:00:00.000Z', NEXT_OPEN);
    const tighten = row('c', '2026-10-12T04:30:00.000Z');
    const at = (iso: string) => resolveAppendOnly([old, loosen, tighten], T(iso));
    expect(at('2026-10-12T05:00:00.000Z')).toEqual({ inForce: tighten, pending: null, newest: tighten });
    expect(at(NEXT_OPEN).inForce).toBe(tighten);
    expect(at('2026-10-20T05:00:00.000Z').inForce).toBe(tighten);
  });

  it('two loosenings before the open: the newer one is pending and is the one that takes effect', () => {
    const old = row('a', '2026-10-09T03:00:00.000Z');
    const first = row('b', '2026-10-12T04:00:00.000Z', NEXT_OPEN);
    const second = row('c', '2026-10-12T04:10:00.000Z', NEXT_OPEN);
    expect(resolveAppendOnly([second, old, first], NOW)).toEqual({ inForce: old, pending: second, newest: second });
    expect(resolveAppendOnly([second, old, first], T(NEXT_OPEN)).inForce).toBe(second);
  });

  it('does not depend on input order', () => {
    const a = row('a', '2026-10-09T03:00:00.000Z');
    const b = row('b', '2026-10-10T03:00:00.000Z');
    expect(resolveAppendOnly([b, a], NOW).inForce).toBe(b);
    expect(resolveAppendOnly([a, b], NOW).inForce).toBe(b);
  });
});
