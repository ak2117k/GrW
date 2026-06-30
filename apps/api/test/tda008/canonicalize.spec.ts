import { canonicalize, sha256 } from '../../src/common/audit/canonicalize';

describe('canonicalize', () => {
  it('is key-order independent', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });
  it('renders Date as ISO and bigint as decimal string', () => {
    const s = canonicalize({ at: new Date('2026-07-01T00:00:00.000Z'), n: 5n });
    expect(s).toContain('2026-07-01T00:00:00.000Z');
    expect(s).toContain('5');
  });
  it('sorts nested keys and preserves array order', () => {
    expect(canonicalize({ x: { d: 1, c: 2 }, arr: [3, 1] }))
      .toBe(canonicalize({ arr: [3, 1], x: { c: 2, d: 1 } }));
  });
  it('sha256 is stable hex', () => {
    expect(sha256('GENESIS')).toMatch(/^[0-9a-f]{64}$/);
  });
});
