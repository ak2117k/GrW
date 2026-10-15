import { describe, it, expect } from 'vitest';
import { aiExitRowView, recentAiExits } from './aiExitView';
import type { AiExitRow } from '@/hooks/useAiExits';

const NOW = Date.parse('2026-10-12T10:05:00.000Z');
function row(over: Partial<AiExitRow> = {}): AiExitRow {
  return {
    id: 'r1', verdictId: 'v1', trackerId: 't1', symbol: 'CRUDEOIL15OCT268950CE', exchange: 'MCX',
    side: 'SELL', quantity: 100, productType: 'CARRYFORWARD', orderType: 'MARKET', limitPrice: null,
    mode: 'live', status: 'FILLED', reason: null, sessionSource: 'user-feed', brokerOrderId: '2610120001',
    brokerMessage: 'SUCCESS', orderStatus: 'complete', marketOrderId: null, verdictReason: 'thesis broken',
    createdAt: '2026-10-12T10:00:00.000Z', updatedAt: '2026-10-12T10:00:10.000Z', ...over,
  };
}

describe('aiExitRowView', () => {
  it('filled live MARKET', () => {
    expect(aiExitRowView(row(), NOW)).toEqual({
      label: 'FILLED', tone: 'emerald',
      line: 'SELL 100 CRUDEOIL15OCT268950CE (CARRYFORWARD) at MARKET',
      detail: 'order 2610120001 · thesis broken', ago: '5 min ago', time: '15:30 IST',
      dryRun: false, unitUnverified: false, source: 'AI',
    });
  });
  it('live PLACED is amber and shows the broker order id', () => {
    const v = aiExitRowView(row({ status: 'PLACED', orderStatus: 'open' }), NOW);
    expect([v.label, v.tone, v.detail]).toEqual(['PLACED', 'amber', 'order 2610120001 · thesis broken']);
  });
  it('dry-run is labelled and muted, and carries the would-do reason', () => {
    const v = aiExitRowView(row({
      mode: 'dry-run', status: 'DRY_RUN', brokerOrderId: null, brokerMessage: null, orderStatus: null,
      reason: 'would SELL 100 CRUDEOIL15OCT268950CE (CARRYFORWARD) at MARKET',
    }), NOW);
    expect([v.label, v.tone, v.dryRun, v.unitUnverified]).toEqual(['DRY RUN', 'muted', true, false]);
    expect(v.detail).toBe('would SELL 100 CRUDEOIL15OCT268950CE (CARRYFORWARD) at MARKET · thesis broken');
  });
  it('dry-run with an unverified quantity unit is flagged', () => {
    const v = aiExitRowView(row({
      mode: 'dry-run', status: 'DRY_RUN', brokerOrderId: null,
      reason: 'UNIT_UNVERIFIED: would SELL 100 CRUDEOIL15OCT268950CE (CARRYFORWARD) at MARKET',
    }), NOW);
    expect(v.unitUnverified).toBe(true);
    expect(v.detail).toContain('UNIT_UNVERIFIED');
  });
  it('LIMIT fallback shows the price and the refused market order', () => {
    const v = aiExitRowView(row({ orderType: 'LIMIT', limitPrice: 49.2, marketOrderId: 'M1', status: 'PLACED' }), NOW);
    expect(v.line).toBe('SELL 100 CRUDEOIL15OCT268950CE (CARRYFORWARD) LIMIT 49.2');
    expect(v.detail).toContain('MARKET refused (M1)');
    expect(v.tone).toBe('amber');
  });
  it('skipped before planning has no order line, shows the reason', () => {
    const v = aiExitRowView(row({ status: 'SKIPPED', reason: 'EXCHANGE_CLOSED', side: null, quantity: null, orderType: null, brokerOrderId: null }), NOW);
    expect([v.label, v.tone, v.line]).toEqual(['SKIPPED', 'muted', 'CRUDEOIL15OCT268950CE — EXCHANGE_CLOSED']);
  });
  it('skipped because the feed session is not ready', () => {
    const v = aiExitRowView(row({
      status: 'SKIPPED', reason: 'FEED_SESSION_NOT_READY', side: null, quantity: null, orderType: null,
      productType: null, brokerOrderId: null, brokerMessage: 'feed session warming up',
    }), NOW);
    expect(v.line).toBe('CRUDEOIL15OCT268950CE — FEED_SESSION_NOT_READY');
    expect(v.tone).toBe('muted');
  });
  it('rejected / failed are red and carry the broker message', () => {
    const v = aiExitRowView(row({ status: 'REJECTED', reason: 'BROKER_REJECTED', brokerMessage: 'Insufficient margin', brokerOrderId: null }), NOW);
    expect([v.tone, v.detail]).toEqual(['red', 'BROKER_REJECTED: Insufficient margin · thesis broken']);
  });
  it('an uncertain order keeps its broker order id visible', () => {
    const v = aiExitRowView(row({ status: 'FAILED', reason: 'ORDER_UNCERTAIN', brokerMessage: null, brokerOrderId: 'X9' }), NOW);
    expect([v.label, v.tone, v.detail]).toEqual(['FAILED', 'red', 'ORDER_UNCERTAIN · order X9 · thesis broken']);
  });
  it('an unknown status falls back to muted', () => {
    const v = aiExitRowView(row({ status: 'WEIRD' as AiExitRow['status'] }), NOW);
    expect(v.tone).toBe('muted');
  });
  it('time is IST HH:mm (24h)', () => {
    expect(aiExitRowView(row({ createdAt: '2026-10-12T18:25:00.000Z' }), NOW).time).toBe('23:55 IST');
    expect(aiExitRowView(row({ createdAt: '2026-10-12T18:35:00.000Z' }), NOW).time).toBe('00:05 IST');
    expect(aiExitRowView(row({ createdAt: 'garbage' }), NOW).time).toBe('');
  });
});

describe('recentAiExits', () => {
  it('keeps the last 24 h, newest first, at most 10', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ id: `r${i}`, createdAt: new Date(NOW - i * 60_000).toISOString() }));
    rows.push(row({ id: 'old', createdAt: new Date(NOW - 25 * 3600_000).toISOString() }));
    const out = recentAiExits(rows.reverse(), NOW);
    expect(out).toHaveLength(10);
    expect(out[0].id).toBe('r0');
    expect(out.some((r) => r.id === 'old')).toBe(false);
  });
  it('tolerates a non-array payload', () => {
    expect(recentAiExits(null as unknown as AiExitRow[], NOW)).toEqual([]);
  });
});

describe('aiExitRowView — owner manual exits', () => {
  it('labels a MANUAL row so it is never read as an AI decision; AI rows are unchanged', () => {
    expect(aiExitRowView(row({ status: 'FILLED', trigger: 'MANUAL' })).label).toBe('MANUAL FILLED');
    expect(aiExitRowView(row({ status: 'FILLED', trigger: 'AI' })).label).toBe('FILLED');
    expect(aiExitRowView(row({ status: 'FILLED' })).label).toBe('FILLED');
  });
});

describe('aiExitRowView — sentinel price triggers', () => {
  it('a PRICE_TRIGGER row is labelled as such and carries the level and tick from verdictReason', () => {
    const v = aiExitRowView(row({ trigger: 'PRICE_TRIGGER', triggerId: 'trg1',
      verdictReason: 'PRICE_TRIGGER: CRUDEOIL19NOV26FUT < 8930 — fired at 8927.5 (2 ticks over 1200 ms); armed 22:33 IST by verdict v1' }));
    expect(v.source).toBe('PRICE_TRIGGER');
    expect(v.label).toBe('PRICE TRIGGER FILLED');
    expect(v.detail).toContain('< 8930 — fired at 8927.5');
  });

  it('rows without trigger (older API) are AI; MANUAL rows say MANUAL', () => {
    expect(aiExitRowView(row()).source).toBe('AI');
    expect(aiExitRowView(row({ trigger: 'MANUAL' })).source).toBe('MANUAL');
  });
});
