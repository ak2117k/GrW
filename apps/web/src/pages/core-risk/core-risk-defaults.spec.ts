import { describe, expect, it } from 'vitest';
import type { CoreRiskLimitView } from '@/services/coreRisk';
import type { CoreRiskDefaultView } from '@/services/coreRiskDefaults';
import { limitRows } from './core-risk';
import { defaultChangePayload, defaultRows, defaultSavedMessage } from './core-risk-defaults';

const KEYS: Array<[string, CoreRiskLimitView['scope'], CoreRiskLimitView['kind']]> = [
  ['maxDailyLoss', 'ALL', 'rupees'], ['maxDailyLossPerStrategy', 'ALL', 'rupees'], ['maxTradesPerDay', 'ALL', 'count'],
  ['maxOpenPositions', 'ALL', 'count'], ['maxOpenPositions', 'CASH_INTRADAY', 'count'], ['maxOpenPositions', 'MTF', 'count'], ['maxOpenPositions', 'OPTIONS_BUY', 'count'],
  ['maxRiskPerTrade', 'ALL', 'rupees'],
  ['maxCapitalDeployed', 'CASH_INTRADAY', 'rupees'], ['maxCapitalDeployed', 'MTF', 'rupees'], ['maxCapitalDeployed', 'OPTIONS_BUY', 'rupees'],
  ['mtfMaxLeverage', 'MTF', 'ratio'], ['mtfMaxHoldDays', 'MTF', 'count'], ['optionsMaxPremiumPerTrade', 'OPTIONS_BUY', 'rupees'],
  ['lastEntryTime', 'CASH_INTRADAY', 'hhmm'], ['lastEntryTime', 'MTF', 'hhmm'], ['lastEntryTime', 'OPTIONS_BUY', 'hhmm'],
  ['squareOffTime', 'CASH_INTRADAY', 'hhmm'], ['squareOffTime', 'MTF', 'hhmm'], ['squareOffTime', 'OPTIONS_BUY', 'hhmm'],
  ['dailyLossAction', 'ALL', 'enum'],
];

function dv(over: Partial<CoreRiskDefaultView> = {}): CoreRiskDefaultView {
  return { key: 'maxTradesPerDay', scope: 'ALL', kind: 'count', tighter: 'lower', value: 20, note: 'no existing equivalent', updatedBy: null, updatedAt: '2026-10-10T06:30:00.000Z', ...over };
}

describe('every limit is editable (owner answer 1)', () => {
  it('the Limits table gets one row per (key, scope): all 21, each with its own id', () => {
    const views: CoreRiskLimitView[] = KEYS.map(([key, scope, kind]) => ({
      key, scope, kind, tighter: kind === 'hhmm' ? 'earlier' : kind === 'enum' ? 'stricter' : 'lower', value: null, source: null,
      needsReview: false, effectiveFrom: null, setAt: null, setBy: null, reason: null, pending: null,
    }));
    const rows = limitRows(views);
    expect(rows).toHaveLength(21);
    expect(new Set(rows.map((r) => r.id)).size).toBe(21);
  });
});

describe('seed defaults', () => {
  it('shows each default with its basis and who last edited it', () => {
    const rows = defaultRows([
      dv(),
      dv({ key: 'squareOffTime', scope: 'CASH_INTRADAY', kind: 'hhmm', tighter: 'earlier', value: '15:25', note: 'Ungated exit', updatedBy: 'usr_owner', updatedAt: '2026-10-13T03:45:00.000Z' }),
      dv({ key: 'mtfMaxLeverage', scope: 'MTF', kind: 'ratio', value: null, note: null, updatedAt: null }),
    ]);
    expect(rows.map((r) => [r.id, r.label, r.scopeLabel, r.valueText, r.note, r.updatedText])).toEqual([
      ['maxTradesPerDay@ALL', 'Max entries per day', 'All vehicles', '20', 'no existing equivalent', 'seeded by the M2 migration'],
      ['squareOffTime@CASH_INTRADAY', 'Square-off time', 'Cash intraday', '15:25 IST', 'Ungated exit', 'edited Tue 13 Oct, 09:15 IST by usr_owner'],
      ['mtfMaxLeverage@MTF', 'MTF max leverage', 'MTF', 'not set', 'no default: new users start without this limit', 'seeded by the M2 migration'],
    ]);
  });

  it('needs a valid value and a reason (the reason becomes the default’s note)', () => {
    expect(defaultChangePayload('count', '12', ' fewer trades ')).toEqual({ ok: true, value: { value: 12, reason: 'fewer trades' } });
    expect(defaultChangePayload('hhmm', '3:25', 'later').ok).toBe(false);
    expect(defaultChangePayload('count', '12', 'no').ok).toBe(false);
  });

  it('says the change applies to future seeds only', () => {
    expect(defaultSavedMessage(dv({ value: 12 }))).toBe(
      'Default for Max entries per day (All vehicles) is now 12. It applies to limits seeded from now on; nobody’s current limits change.',
    );
  });
});
