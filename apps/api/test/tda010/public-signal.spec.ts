import { toPublicSignal, idempotencyKeyFor } from '../../src/modules/signal-fanout/dto/public-signal.dto';
import { ANAND_PROVENANCE_KEYS } from '../../src/modules/anand-dual-track/dto/public-entry.dto';

const rawRow = {
  id: 'e1', symbol: 'TCS', token: '11536', entryPrice: 100,
  enteredAt: '2026-07-02T04:00:00.000Z', targetPct: 5, stopPct: 5, status: 'OPEN',
  scannerName: '__LEAK_scanner__', scoreBreakdown: [{ name: '__LEAK__', points: 3 }],
  leadCount: 4, leadDates: ['2026-06-01'], trailing: true, exitReason: 'TRAIL_ST', alertId: 'al_1',
};

it('builds a PublicSignal with no provenance key/sentinel', () => {
  const sig = toPublicSignal(rawRow as any, 'INTRADAY');
  const json = JSON.stringify(sig);
  for (const k of [...ANAND_PROVENANCE_KEYS, 'alertId']) expect(json).not.toContain(k);
  expect(json).not.toContain('__LEAK_scanner__');
  expect(json).not.toContain('TRAIL_ST');
  expect(sig).toMatchObject({ entryId: 'e1', symbol: 'TCS', segment: 'INTRADAY', side: 'BUY', entryPrice: 100, targetPct: 5, stopPct: 5, token: '11536' });
});

it('idempotency key is stable per (entryId,userId) and distinct across users', () => {
  expect(idempotencyKeyFor('e1', 'u1')).toBe(idempotencyKeyFor('e1', 'u1'));
  expect(idempotencyKeyFor('e1', 'u1')).not.toBe(idempotencyKeyFor('e1', 'u2'));
  expect(idempotencyKeyFor('e1', 'u1')).toMatch(/^[0-9a-f]{64}$/);
});
