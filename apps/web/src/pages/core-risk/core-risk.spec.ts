import { describe, expect, it } from 'vitest';
import type { CoreKillSwitchView, CoreLimitChangeResult, CoreRiskLimitView } from '@/services/coreRisk';
import {
  cascadeLines,
  changeHint,
  changeResultMessage,
  editText,
  formatIst,
  formatLimitValue,
  killSwitchPayload,
  killSwitchSummary,
  limitChangePayload,
  limitRows,
  parseLimitInput,
  previewDirection,
  validReason,
} from './core-risk';

const NEXT_OPEN = '2026-10-13T03:45:00.000Z';

function view(over: Partial<CoreRiskLimitView> = {}): CoreRiskLimitView {
  return {
    key: 'maxDailyLoss', scope: 'ALL', kind: 'rupees', tighter: 'lower', value: 5000, source: 'USER', needsReview: false,
    effectiveFrom: '2026-10-09T03:45:00.000Z', setAt: '2026-10-09T03:45:00.000Z', setBy: 'user_A', reason: 'mine', pending: null, ...over,
  };
}

function ks(over: Partial<CoreKillSwitchView> = {}): CoreKillSwitchView {
  return { active: false, since: null, reason: null, setBy: null, pendingRelease: null, ...over };
}

describe('formatting', () => {
  it('shows times in IST and values by kind', () => {
    expect(formatIst(NEXT_OPEN)).toBe('Tue 13 Oct, 09:15 IST');
    expect(formatLimitValue('rupees', 1000000)).toBe('₹10,00,000');
    expect(formatLimitValue('rupees', 2500.5)).toBe('₹2,500.5');
    expect(formatLimitValue('count', 5)).toBe('5');
    expect(formatLimitValue('ratio', 2)).toBe('2×');
    expect(formatLimitValue('hhmm', '15:00')).toBe('15:00 IST');
    expect(formatLimitValue('enum', 'BLOCK_AND_SQUARE_OFF')).toBe('Block entries and square off');
    expect(formatLimitValue('rupees', null)).toBe('not set');
  });
});

describe('limitRows', () => {
  it('badges a pending loosening with its effective time, a default for review, and a missing limit', () => {
    const rows = limitRows([
      view({ pending: { value: 8000, effectiveFrom: NEXT_OPEN, setAt: NEXT_OPEN, reason: 'more room' } }),
      view({ key: 'maxTradesPerDay', kind: 'count', value: 20, source: 'DEFAULT', needsReview: true, reason: 'default — please review (x)' }),
      view({ key: 'maxOpenPositions', scope: 'MTF', kind: 'count', value: null, source: null }),
      view({ key: 'maxOpenPositions', scope: 'ALL', kind: 'count', value: 8, source: 'USER_SETTINGS' }),
    ]);
    expect(rows.map((r) => [r.id, r.label, r.scopeLabel, r.valueText, r.badge])).toEqual([
      ['maxDailyLoss@ALL', 'Max daily loss (realised + open)', 'All vehicles', '₹5,000', 'pending'],
      ['maxTradesPerDay@ALL', 'Max entries per day', 'All vehicles', '20', 'review'],
      ['maxOpenPositions@MTF', 'Max open positions', 'MTF', 'not set', 'missing'],
      ['maxOpenPositions@ALL', 'Max open positions', 'All vehicles', '8', null],
    ]);
    expect(rows[0].pendingText).toBe('→ ₹8,000 from Tue 13 Oct, 09:15 IST');
    expect(rows[1].note).toBe('Default — please review');
    expect(rows[2].note).toBe('Not set: entries that need it are rejected');
    expect(rows[3].note).toBe('Copied from settings');
  });

  it('a default that is also pending shows the pending badge', () => {
    const [row] = limitRows([view({ source: 'DEFAULT', needsReview: true, pending: { value: 6000, effectiveFrom: NEXT_OPEN, setAt: NEXT_OPEN, reason: 'r' } })]);
    expect(row.badge).toBe('pending');
  });
});

describe('editing a limit', () => {
  it('starts from the value in force', () => {
    expect(editText(view())).toBe('5000');
    expect(editText(view({ kind: 'hhmm', value: '15:00' }))).toBe('15:00');
    expect(editText(view({ value: null }))).toBe('');
  });

  it('parses input per kind', () => {
    expect(parseLimitInput('rupees', '₹ 5,000.50')).toEqual({ ok: true, value: 5000.5 });
    expect(parseLimitInput('rupees', '10,00,000')).toEqual({ ok: true, value: 1000000 });
    expect(parseLimitInput('rupees', '5000.123').ok).toBe(false);
    expect(parseLimitInput('rupees', '').ok).toBe(false);
    expect(parseLimitInput('count', '12')).toEqual({ ok: true, value: 12 });
    expect(parseLimitInput('count', '1.5').ok).toBe(false);
    expect(parseLimitInput('ratio', '2.5')).toEqual({ ok: true, value: 2.5 });
    expect(parseLimitInput('ratio', '0.5').ok).toBe(false);
    expect(parseLimitInput('hhmm', '14:45')).toEqual({ ok: true, value: '14:45' });
    expect(parseLimitInput('hhmm', '2:45pm').ok).toBe(false);
    expect(parseLimitInput('enum', 'BLOCK_AND_SQUARE_OFF')).toEqual({ ok: true, value: 'BLOCK_AND_SQUARE_OFF' });
    expect(parseLimitInput('enum', 'PANIC').ok).toBe(false);
  });

  it('previews the direction the server will apply (D5)', () => {
    expect(previewDirection(view(), 4000)).toBe('TIGHTER');
    expect(previewDirection(view(), 5000)).toBe('SAME');
    expect(previewDirection(view(), 6000)).toBe('LOOSER');
    expect(previewDirection(view({ kind: 'hhmm', tighter: 'earlier', value: '15:00' }), '14:30')).toBe('TIGHTER');
    expect(previewDirection(view({ kind: 'enum', tighter: 'stricter', value: 'BLOCK_ENTRIES' }), 'BLOCK_AND_SQUARE_OFF')).toBe('TIGHTER');
    expect(previewDirection(view({ value: null }), 1)).toBe('LOOSER');
    expect(changeHint(view(), 4000)).toBe('Tighter: takes effect immediately.');
    expect(changeHint(view(), 5000)).toBe('Same as now: takes effect immediately and cancels any pending change.');
    expect(changeHint(view(), 6000)).toBe('Looser: takes effect at the next session open.');
  });

  it('needs a valid value and a 3–500 character reason before sending', () => {
    expect(validReason('  ok  ')).toEqual({ ok: false, error: 'Give a reason (3 to 500 characters)' });
    expect(validReason(' fine ')).toEqual({ ok: true, value: 'fine' });
    expect(limitChangePayload(view(), '4,000', ' bad week ')).toEqual({ ok: true, value: { value: 4000, reason: 'bad week' } });
    expect(limitChangePayload(view(), 'four', 'bad week').ok).toBe(false);
    expect(limitChangePayload(view(), '4000', 'no').ok).toBe(false);
  });

  it('words the result: now for tighter or same, the effective time for looser', () => {
    const tighter: CoreLimitChangeResult = { limit: view({ value: 4000 }), direction: 'TIGHTER', effectiveFrom: '2026-10-12T05:00:00.000Z' };
    expect(changeResultMessage(tighter)).toBe('Max daily loss (realised + open) (All vehicles) is now ₹4,000');
    const looser: CoreLimitChangeResult = {
      limit: view({ pending: { value: 8000, effectiveFrom: NEXT_OPEN, setAt: NEXT_OPEN, reason: 'r' } }), direction: 'LOOSER', effectiveFrom: NEXT_OPEN,
    };
    expect(changeResultMessage(looser)).toBe('Max daily loss (realised + open) (All vehicles) becomes ₹8,000 at Tue 13 Oct, 09:15 IST');
  });
});

describe('kill switch', () => {
  it('summarises on, off and a scheduled release', () => {
    expect(killSwitchSummary(ks())).toEqual({ headline: 'Kill switch off', tone: 'ok', detail: null, releaseText: null });
    expect(killSwitchSummary(ks({ active: true, since: '2026-10-12T05:00:00.000Z', reason: 'crash' }))).toEqual({
      headline: 'Kill switch ON: every core entry is blocked', tone: 'danger', detail: 'since Mon 12 Oct, 10:30 IST · crash', releaseText: null,
    });
    expect(killSwitchSummary(ks({ active: true, since: '2026-10-12T05:00:00.000Z', reason: 'crash', pendingRelease: { effectiveFrom: NEXT_OPEN, reason: 'calm', setAt: NEXT_OPEN } })).releaseText).toBe(
      'Release scheduled for Tue 13 Oct, 09:15 IST (calm)',
    );
  });

  it('turning on needs a reason and the typed confirmation; turning off needs only a reason', () => {
    expect(killSwitchPayload(true, 'market crash', 'kill')).toEqual({ ok: true, value: { active: true, reason: 'market crash' } });
    expect(killSwitchPayload(true, 'market crash', 'yes')).toEqual({ ok: false, error: 'Type KILL to confirm' });
    expect(killSwitchPayload(true, 'no', 'KILL').ok).toBe(false);
    expect(killSwitchPayload(false, 'calm again', '')).toEqual({ ok: true, value: { active: false, reason: 'calm again' } });
  });

  it('lists each cascade step with a tone that never hides a failure', () => {
    expect(cascadeLines(null)).toEqual([]);
    expect(
      cascadeLines({
        core: { status: 'OK', detail: 'no core orders or positions exist yet' },
        silos: [
          { target: 'auto-execution', status: 'OK', detail: 'set' },
          { target: 'watch-monitor', status: 'FAILED', detail: '1 errors' },
          { target: 'sell-futures-track', status: 'UNAVAILABLE', detail: 'not loaded' },
          { target: 'trade-engine', status: 'SKIPPED', detail: 'owner only' },
        ],
      }),
    ).toEqual([
      { text: 'Core: no core orders or positions exist yet', tone: 'ok' },
      { text: 'Auto-execution: OK · set', tone: 'ok' },
      { text: 'Watch monitor: FAILED · 1 errors', tone: 'danger' },
      { text: 'Sell-futures silo: UNAVAILABLE · not loaded', tone: 'warn' },
      { text: 'Trade engine: SKIPPED · owner only', tone: 'muted' },
    ]);
  });
});
