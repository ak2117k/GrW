import { describe, expect, it } from 'vitest';
import type { CoreJournalRowView, CoreJournalStatusView } from '@/services/coreJournal';
import { ackPayload, eventLine, istTime, pnlTone, pollsDay, rupees, skipRows, statusBanner } from './core-journal';

const row = (type: string, payload: Record<string, unknown>, over: Partial<CoreJournalRowView> = {}): CoreJournalRowView => ({
  id: 'jr', type, positionId: null, strategyId: null, intentId: null, symbol: 'RELIANCE-EQ', payload, priceUsed: null, priceAgeMs: null, createdAt: '2026-10-13T05:00:05.000Z', ...over,
});

const status = (over: Partial<CoreJournalStatusView> = {}): CoreJournalStatusView => ({
  entries: { mode: 'paper', users: 1, pending: 0, dropped: 0 },
  journal: { pending: 0, written: 5, dropped: 0, failures: 0, lastError: null },
  positions: { active: 1, blind: 0, exiting: 0 },
  mismatches: [],
  ...over,
});

describe('Core Journal page logic', () => {
  it('formats IST time, rupees and the P&L tone', () => {
    expect(istTime('2026-10-13T05:00:05.000Z')).toBe('10:30:05');
    expect(rupees('1207.5')).toBe('₹1,207.50');
    expect(rupees(null)).toBe('—');
    expect(pnlTone('12.00')).toBe('ok');
    expect(pnlTone('-0.01')).toBe('danger');
    expect(pnlTone('0.00')).toBe('muted');
  });

  it('words each journal event for the timeline', () => {
    expect(eventLine(row('POSITION_STATE', { from: 'OPEN', to: 'EXITING' })).title).toBe('OPEN → EXITING');
    expect(eventLine(row('EXIT_DECIDED', { reason: 'TRAIL', detail: 'stop 504.95 crossed' })).title).toBe('Exit: TRAIL');
    expect(eventLine(row('FILL', { qty: 100, price: '500.0000' })).title).toBe('Fill 100 @ 500.0000');
    expect(eventLine(row('RISK_VERDICT', { verdict: 'RESIZE', qty: 133, reasons: [{ code: 'CAP_RISK_PER_TRADE' }] })).detail).toBe('CAP_RISK_PER_TRADE');
    expect(eventLine(row('INTENT_SKIPPED', { reason: 'GATE', detail: 'not at support' }))).toMatchObject({ title: 'Skipped: GATE', detail: 'not at support' });
    expect(eventLine(row('BLIND', { blind: true, noPriceForMs: 31000 })).title).toBe('No fresh price (blind)');
    expect(eventLine(row('UNKNOWN_TYPE', {})).title).toBe('UNKNOWN_TYPE');
  });

  it('the status banner is danger on findings or drops, warn on blind positions or a dry run, else ok', () => {
    expect(statusBanner(status()).tone).toBe('ok');
    expect(statusBanner(status({ entries: { mode: 'journal', users: 1, pending: 0, dropped: 0 } })).tone).toBe('warn');
    expect(statusBanner(status({ positions: { active: 2, blind: 1, exiting: 0 } })).tone).toBe('warn');
    expect(statusBanner(status({ journal: { pending: 3, written: 5, dropped: 2, failures: 1, lastError: 'db down' } })).tone).toBe('danger');
    expect(statusBanner(status({ mismatches: [row('RECON_MISMATCH', { check: 'STUCK_ORDER' })] })).lines).toContain('1 reconciliation finding(s) block entries until acknowledged');
  });

  it('skip reasons sorted by count with labels; an ack needs a reason', () => {
    expect(skipRows({ GATE: 2, MIN_SCORE: 5, NEW_REASON: 1 })).toEqual([
      { reason: 'MIN_SCORE', count: 5, label: 'Score below the strategy minimum' },
      { reason: 'GATE', count: 2, label: 'Decision gate said no' },
      { reason: 'NEW_REASON', count: 1, label: 'NEW_REASON' },
    ]);
    expect(ackPayload('  ')).toEqual({ ok: false, error: 'Say why you are acknowledging it' });
    expect(ackPayload(' checked ')).toEqual({ ok: true, value: { reason: 'checked' } });
  });
});

describe('Core Journal polling', () => {
  it("polls the day only while it is today's IST date", () => {
    expect(pollsDay('2026-10-13', '2026-10-13')).toBe(true);
    expect(pollsDay('2026-10-12', '2026-10-13')).toBe(false);
  });
});
