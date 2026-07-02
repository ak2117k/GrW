/**
 * TDA-009 Task 1 — content-hash pinning (pure, no DB).
 *
 * `ConsentService.computeContentHash` is the ONLY content-hash implementation
 * (spec §3): `'sha256:' + sha256(canonicalize({ kind, version, body }))`. It is
 * deterministic and binds all three of kind / version / body, so a recorded
 * acceptance can never be silently re-pointed at different words. This spec
 * exercises only that pure method, so the prisma / tenant / audit deps are
 * irrelevant and passed as `null as any`.
 *
 * Run from apps/api:
 *   npx jest --config test/tda009/jest.config.js content-hash --verbose
 */

import { ConsentService } from '../../src/modules/consent/consent.service';

describe('TDA-009 Task 1 — computeContentHash', () => {
  const svc = new ConsentService(null as any, null as any, null as any);

  it('returns a self-describing sha256:<64hex> digest', () => {
    const h = svc.computeContentHash('risk-disclosure', '2026-07-02.1', 'BODY');
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is stable for identical (kind, version, body)', () => {
    const h = svc.computeContentHash('risk-disclosure', '2026-07-02.1', 'BODY');
    expect(svc.computeContentHash('risk-disclosure', '2026-07-02.1', 'BODY')).toBe(h);
  });

  it('is bound to the version string', () => {
    const h = svc.computeContentHash('risk-disclosure', '2026-07-02.1', 'BODY');
    expect(svc.computeContentHash('risk-disclosure', '2026-07-02.2', 'BODY')).not.toBe(h);
  });

  it('is bound to the body bytes', () => {
    const h = svc.computeContentHash('risk-disclosure', '2026-07-02.1', 'BODY');
    expect(svc.computeContentHash('risk-disclosure', '2026-07-02.1', 'OTHER')).not.toBe(h);
  });

  it('is bound to the kind', () => {
    const h = svc.computeContentHash('risk-disclosure', '2026-07-02.1', 'BODY');
    expect(svc.computeContentHash('other-kind', '2026-07-02.1', 'BODY')).not.toBe(h);
  });
});
