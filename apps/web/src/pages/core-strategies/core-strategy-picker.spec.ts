import { describe, expect, it } from 'vitest';
import type { CoreSelectionView, CoreStrategyVersionView, CoreStrategyView } from '@/services/coreStrategies';
import {
  apiErrorMessage,
  canSave,
  describeBlocks,
  parseCapital,
  pickerRow,
  selectableVersions,
  selectionPayload,
  staleSelectionWarning,
  versionLabel,
} from './core-strategy-picker';

const ISO = '2026-10-09T04:00:00.000Z';

function v(id: string, version: number, status: CoreStrategyVersionView['status'], over: Partial<CoreStrategyVersionView> = {}): CoreStrategyVersionView {
  return { id, strategyId: 's1', version, status, blocks: {}, createdBy: 'OWNER', approvedBy: null, approvedAt: null, sourceDocId: null, notes: null, createdAt: ISO, ...over };
}

function strategy(versions: CoreStrategyVersionView[]): CoreStrategyView {
  return { id: 's1', key: 'ungated', name: 'Ungated', description: 'd', allowedVehicles: ['CASH_INTRADAY'], createdAt: ISO, versions };
}

function sel(over: Partial<CoreSelectionView> = {}): CoreSelectionView {
  return { id: 'sel_1', strategyId: 's1', strategyVersionId: 'v1', enabled: true, capitalAllocation: 200000, updatedAt: ISO, ...over };
}

describe('versions', () => {
  it('labels a version with its number, status and AI origin', () => {
    expect(versionLabel(v('v1', 1, 'PAPER'))).toBe('v1 · paper');
    expect(versionLabel(v('v2', 2, 'DRAFT', { createdBy: 'AI' }))).toBe('v2 · draft · AI-drafted');
  });

  it('offers only PAPER versions, newest first', () => {
    const s = strategy([v('v1', 1, 'PAPER'), v('v3', 3, 'DRAFT'), v('v2', 2, 'PAPER'), v('v0', 4, 'RETIRED')]);
    expect(selectableVersions(s).map((x) => x.id)).toEqual(['v2', 'v1']);
  });
});

describe('pickerRow', () => {
  it('starts a strategy with no selection on its newest approved version, off, with no capital', () => {
    const row = pickerRow(strategy([v('v1', 1, 'PAPER'), v('v2', 2, 'PAPER')]), undefined);
    expect(row).toEqual({
      strategyId: 's1',
      options: [{ value: 'v2', label: 'v2 · paper' }, { value: 'v1', label: 'v1 · paper' }],
      versionId: 'v2', enabled: false, capitalText: '', staleSelection: false, savedVersionId: null,
    });
  });

  it('shows the saved selection', () => {
    const row = pickerRow(strategy([v('v1', 1, 'PAPER'), v('v2', 2, 'PAPER')]), sel({ strategyVersionId: 'v1' }));
    expect(row).toMatchObject({ versionId: 'v1', enabled: true, capitalText: '200000', staleSelection: false });
  });

  it('pickerRow flags a saved selection whose version is no longer selectable', () => {
    const retired = pickerRow(strategy([v('v1', 1, 'RETIRED'), v('v2', 2, 'PAPER')]), sel({ strategyVersionId: 'v1' }));
    expect(retired).toMatchObject({ versionId: 'v2', staleSelection: true, enabled: false, savedVersionId: 'v1' });
    const hidden = pickerRow(strategy([v('v2', 2, 'PAPER')]), sel({ strategyVersionId: 'v1' }));
    expect(hidden.staleSelection).toBe(true);
    expect(hidden.enabled).toBe(false);
  });

  it('words the stale warning for whether an approved version exists', () => {
    const withOptions = pickerRow(strategy([v('v1', 1, 'RETIRED'), v('v2', 2, 'PAPER')]), sel({ strategyVersionId: 'v1' }));
    expect(staleSelectionWarning(withOptions)).toBe(
      'Your saved version is no longer approved, so the core will not trade it. Save to switch it off, or pick an approved version, enable it and save.',
    );
    const noOptions = pickerRow(strategy([v('v1', 1, 'RETIRED')]), sel({ strategyVersionId: 'v1' }));
    expect(staleSelectionWarning(noOptions)).toBe(
      'Your saved version is no longer approved, so the core will not trade it. No other version is approved yet: save to switch it off.',
    );
    expect(staleSelectionWarning(pickerRow(strategy([v('v1', 1, 'PAPER')]), sel()))).toBeNull();
  });

  it('has no version to pick while nothing is approved', () => {
    expect(pickerRow(strategy([v('v1', 1, 'DRAFT')]), undefined)).toMatchObject({ options: [], versionId: null });
  });
});

describe('capital and payload', () => {
  it('parses rupee amounts with Indian grouping, ₹ and spaces', () => {
    expect(parseCapital('2,00,000')).toEqual({ ok: true, value: 200000 });
    expect(parseCapital(' ₹ 50000.50 ')).toEqual({ ok: true, value: 50000.5 });
    expect(parseCapital('0')).toEqual({ ok: true, value: 0 });
  });

  it('refuses empty, negative, non-numeric and over-precise amounts', () => {
    for (const bad of ['', '   ', '-100', 'abc', '1e5', '10.123']) expect(parseCapital(bad).ok).toBe(false);
  });

  it('builds the PUT body, and refuses enabling with ₹0 or without a version', () => {
    expect(selectionPayload({ versionId: 'v1', enabled: true, capitalText: '1,000' })).toEqual({
      ok: true, value: { strategyVersionId: 'v1', enabled: true, capitalAllocation: 1000 },
    });
    expect(selectionPayload({ versionId: 'v1', enabled: false, capitalText: '0' }).ok).toBe(true);
    expect(selectionPayload({ versionId: 'v1', enabled: true, capitalText: '0' })).toEqual({ ok: false, error: 'An enabled strategy needs capital above ₹0' });
    expect(selectionPayload({ versionId: null, enabled: false, capitalText: '10' })).toEqual({ ok: false, error: 'No approved version to select yet' });
  });

  it('stale selection with no approved version left: one Save switches the saved version off', () => {
    const row = pickerRow(strategy([v('v1', 1, 'RETIRED')]), sel({ strategyVersionId: 'v1', enabled: true, capitalAllocation: 200000 }));
    expect(row).toMatchObject({ versionId: null, enabled: false, staleSelection: true });
    expect(canSave(row, row)).toBe(true);
    expect(selectionPayload(row, row)).toEqual({ ok: true, value: { strategyVersionId: 'v1', enabled: false, capitalAllocation: 200000 } });
    // Turning it back on has nothing to point at.
    const on = { ...row, enabled: true };
    expect(canSave(on, row)).toBe(false);
    expect(selectionPayload(on, row)).toEqual({ ok: false, error: 'No approved version to select yet' });
  });

  it('stale selection with an approved version: the new version is saved OFF unless the user enables it', () => {
    const row = pickerRow(strategy([v('v1', 1, 'RETIRED'), v('v2', 2, 'PAPER')]), sel({ strategyVersionId: 'v1', enabled: true, capitalAllocation: 200000 }));
    expect(canSave(row, row)).toBe(true);
    expect(selectionPayload(row, row)).toEqual({ ok: true, value: { strategyVersionId: 'v2', enabled: false, capitalAllocation: 200000 } });
    expect(selectionPayload({ ...row, enabled: true }, row)).toEqual({ ok: true, value: { strategyVersionId: 'v2', enabled: true, capitalAllocation: 200000 } });
  });

  it('without a stale selection, Save needs a picked version', () => {
    expect(canSave({ versionId: null, enabled: false, capitalText: '0' })).toBe(false);
    const fresh = pickerRow(strategy([v('v1', 1, 'DRAFT')]), undefined);
    expect(canSave(fresh, fresh)).toBe(false);
    expect(canSave({ versionId: 'v1', enabled: true, capitalText: '' })).toBe(true);
  });
});

describe('describeBlocks', () => {
  it('describes the Adaptive-Stop v1 shape in words', () => {
    const lines = describeBlocks({
      entry: {
        kind: 'chartink', scanName: null, match: 'ANY', side: 'BUY',
        minScore: { base: 47, windows: [{ fromHhmm: '11:45', toHhmm: '14:00', score: 75 }] },
      },
      filters: {
        staleEntry: { maxMovePct: 1 }, cooldown: { minutes: 45 }, lastLoss: { window: 'SAME_IST_DAY' },
        gates: [{ kind: 'evaluator', evaluatorKey: 'adaptive-stop-decision-gate', params: {} }],
      },
      stop: { kind: 'atr', period: 14, timeframe: '5m', multiple: 1.2, minPct: 0.8, maxPct: 2.5 },
      target: { kind: 'fixedPct', pct: 2 },
      trail: { kind: 'atr', multiple: 1, minPct: 0.6, maxPct: 1.5, startsAfter: 'PARTIAL' },
      timeExit: { kind: 'clock', hhmm: '15:15' },
      partial: { kind: 'atTarget1', fraction: 0.5, atPct: 1 },
      sizing: { kind: 'riskRupees', amount: 800 },
      vehicle: { kind: 'CASH_INTRADAY' },
    });
    expect(lines).toEqual([
      { label: 'Entry', value: 'Chartink · any scan · BUY · score ≥ 47 (≥ 75 11:45–14:00 IST)' },
      {
        label: 'Filters',
        value: 'skip if price ran > 1% from the alert · 45-min cooldown per symbol · skip after a same-day loss on the symbol · gate adaptive-stop-decision-gate',
      },
      { label: 'Stop', value: 'ATR(14, 5m) × 1.2, clamped 0.8%–2.5%' },
      { label: 'Target', value: '+2% from entry' },
      { label: 'Trail', value: 'ATR at entry × 1, clamped 0.6%–1.5%, after the partial exit' },
      { label: 'Time exit', value: 'Exit at 15:15 IST' },
      { label: 'Partial', value: 'Sell 50% at +1%' },
      { label: 'Sizing', value: 'Risk ₹800 per trade' },
      { label: 'Vehicle', value: 'Cash intraday' },
    ]);
  });

  it('describes the Ungated v1 shape, and never throws on unknown or broken blocks', () => {
    const lines = describeBlocks({
      entry: { kind: 'chartink', scanName: 'hull', match: 'CONTAINS', side: 'BUY', minScore: null },
      filters: { staleEntry: null, cooldown: null, lastLoss: null, gates: [] },
      stop: { kind: 'fixedPct', pct: 1.5 },
      sizing: { kind: 'notionalRupees', amount: 200000 },
      vehicle: { kind: 'SPACESHIP' },
    });
    expect(lines.find((l) => l.label === 'Entry')?.value).toBe('Chartink · scan contains "hull" · BUY');
    expect(lines.find((l) => l.label === 'Filters')?.value).toBe('None');
    expect(lines.find((l) => l.label === 'Stop')?.value).toBe('Fixed 1.5% from entry');
    expect(lines.find((l) => l.label === 'Sizing')?.value).toBe('₹2,00,000 notional per trade');
    expect(lines.find((l) => l.label === 'Vehicle')?.value).toBe('{"kind":"SPACESHIP"}');
    expect(lines.find((l) => l.label === 'Target')?.value).toBe('—');
    expect(describeBlocks(null)).toEqual([{ label: 'Blocks', value: 'not readable' }]);
  });
});

describe('apiErrorMessage', () => {
  it('prefers the server message, then the error message, then the fallback', () => {
    expect(apiErrorMessage({ response: { data: { message: 'v1 is RETIRED' } } }, 'x')).toBe('v1 is RETIRED');
    expect(apiErrorMessage({ response: { data: { message: ['a', 'b'] } } }, 'x')).toBe('a; b');
    expect(apiErrorMessage(new Error('Network Error'), 'x')).toBe('Network Error');
    expect(apiErrorMessage(undefined, 'Could not save')).toBe('Could not save');
  });
});
