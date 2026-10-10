import { describe, it, expect } from 'vitest';
import { overnightPlanCard, parseOvernightReason } from './overnightPlanView';
import type { SentinelPosition } from '@/hooks/useSentinelPositions';

const NOW = Date.parse('2026-10-13T03:30:00.000Z'); // 09:00 IST

function position(over: Partial<SentinelPosition> = {}): SentinelPosition {
  return {
    trackerId: 't1',
    symbol: 'NIFTY13OCT2625000CE',
    exchange: 'NFO',
    token: '1',
    qty: 75,
    entryPrice: 140,
    lastLtp: 120,
    entryTime: '2026-10-12T04:00:00.000Z',
    verdict: null,
    thesis: null,
    overnight: {
      kind: 'PRE_OPEN_REVIEW',
      verdict: 'TIGHTEN_AT_OPEN',
      confidence: 'medium',
      thesisStatus: 'WEAKENING',
      reason: 'OVERNIGHT RISK: one session to expiry and ₹1,312 of theta\nOPEN PLAN: if it gaps below 24950, exit; above 25150, hold with a stop at 25020',
      invalidationPoint: 'an open above 25150',
      evidence: ['overnight.decay'],
      netPnl: -1590,
      at: '2026-10-13T03:20:00.000Z',
    },
    ...over,
  };
}

describe('parseOvernightReason', () => {
  it('splits the stored risk and open plan back apart', () => {
    expect(parseOvernightReason('OVERNIGHT RISK: theta\nOPEN PLAN: exit below 24950')).toEqual({
      risk: 'theta',
      plan: 'exit below 24950',
    });
  });

  it('reads an unlabelled reason as the risk, with no invented plan', () => {
    expect(parseOvernightReason('just prose')).toEqual({ risk: 'just prose', plan: null });
  });

  it('copes with CRLF and extra whitespace', () => {
    expect(parseOvernightReason('OVERNIGHT RISK:  a \r\nOPEN PLAN:  b ')).toEqual({ risk: 'a', plan: 'b' });
  });
});

describe('overnightPlanCard', () => {
  it('is null when the position has never had an overnight review', () => {
    expect(overnightPlanCard(position({ overnight: null }), NOW)).toBeNull();
  });

  it('labels the window, the verdict and its tone, and carries the plan, risk and change-of-mind level', () => {
    const card = overnightPlanCard(position(), NOW);
    expect(card).toEqual({
      title: 'Overnight plan',
      windowLabel: 'Pre-open review',
      verdictLabel: 'TIGHTEN AT OPEN',
      tone: 'amber',
      risk: 'one session to expiry and ₹1,312 of theta',
      plan: 'if it gaps below 24950, exit; above 25150, hold with a stop at 25020',
      changeMind: 'an open above 25150',
      confidence: 'medium',
      ago: '10 min ago',
      superseded: false,
      stale: false,
    });
  });

  it('colours HOLD_OVERNIGHT green and EXIT_AT_OPEN red, and names the after-close window', () => {
    const hold = overnightPlanCard(position({ overnight: { ...position().overnight!, verdict: 'HOLD_OVERNIGHT', kind: 'OVERNIGHT_REVIEW' } }), NOW);
    expect(hold).toEqual(expect.objectContaining({ tone: 'emerald', verdictLabel: 'HOLD OVERNIGHT', windowLabel: 'After-close review' }));
    const exit = overnightPlanCard(position({ overnight: { ...position().overnight!, verdict: 'EXIT_AT_OPEN' } }), NOW);
    expect(exit?.tone).toBe('red');
  });

  it('marks the plan superseded once a live verdict has been recorded after it', () => {
    const card = overnightPlanCard(
      position({
        verdict: {
          verdict: 'HOLD',
          confidence: 'high',
          thesisStatus: 'INTACT',
          reason: 'ok',
          invalidationPoint: null,
          evidence: [],
          netPnl: 0,
          greenFloor: null,
          triggeredBy: ['heartbeat'],
          at: '2026-10-13T03:50:00.000Z',
        },
      }),
      Date.parse('2026-10-13T04:00:00.000Z'),
    );
    expect(card?.superseded).toBe(true);
  });

  it('marks a plan older than a day as stale', () => {
    const card = overnightPlanCard(position(), Date.parse('2026-10-14T05:00:00.000Z'));
    expect(card?.stale).toBe(true);
  });
});
