import { describe, expect, it } from 'vitest';
import {
  safeExternalUrl,
  bpPct,
  isSectionError,
  istDate,
  istDateTime,
  istTime,
  sentimentTone,
  setupActionLabel,
  setupLabel,
  summaryLine,
  toneVariant,
  verdictLabel,
  verdictTone,
} from './nightReportFormat';

describe('verdict tone', () => {
  it('maps exit to bad, tighten to warn, hold to ok', () => {
    expect(verdictTone('EXIT_AT_OPEN')).toBe('bad');
    expect(verdictTone('TIGHTEN_AT_OPEN')).toBe('warn');
    expect(verdictTone('HOLD_OVERNIGHT')).toBe('ok');
    expect(verdictTone('HOLD')).toBe('ok');
  });
  it('never guesses an unknown or missing verdict', () => {
    expect(verdictTone('SOMETHING_NEW')).toBe('muted');
    expect(verdictTone(null)).toBe('muted');
  });
  it('labels and badge variants', () => {
    expect(verdictLabel('EXIT_AT_OPEN')).toBe('Exit at open');
    expect(verdictLabel('HOLD_OVERNIGHT')).toBe('Hold');
    expect(verdictLabel(null)).toBe('Not judged');
    expect(verdictLabel('BRAND_NEW')).toBe('Brand new');
    expect(toneVariant('bad')).toBe('danger');
    expect(toneVariant('warn')).toBe('warning');
    expect(toneVariant('ok')).toBe('success');
    expect(toneVariant('muted')).toBe('neutral');
  });
});

describe('setup labels', () => {
  it('puts known codes in plain words', () => {
    expect(setupLabel('BB_LOWER_TOUCH_UPTREND')).toBe('Bollinger lower-band touch in an uptrend');
    expect(setupLabel('RIBBON_UP_MACD_GREEN_10_30')).toBe('EMA 10/30 cross up with MACD positive');
    expect(setupLabel('RIBBON_DOWN_MACD_RED_12_26')).toBe('EMA 12/26 cross down with MACD negative');
    expect(setupLabel('RIBBON_UP_TREND_10_30')).toBe('EMA 10/30 cross up above the 200-day EMA');
  });
  it('falls back to sentence case for an unknown code', () => {
    expect(setupLabel('NEW_FANCY_SETUP')).toBe('New fancy setup');
  });
  it('labels actions', () => {
    expect(setupActionLabel('LONG_SETUP')).toEqual({ label: 'Long setup', variant: 'success' });
    expect(setupActionLabel('EXIT_OR_TIGHTEN_LONGS')).toEqual({ label: 'Exit or tighten longs', variant: 'warning' });
  });
  it('formats basis points as percent', () => {
    expect(bpPct(125)).toBe('+1.25%');
    expect(bpPct(-45)).toBe('−0.45%');
    expect(bpPct(0)).toBe('0.00%');
    expect(bpPct(null)).toBe('—');
  });
});

describe('IST formatting', () => {
  it('shows UTC instants in IST', () => {
    expect(istTime('2026-10-20T03:45:00.000Z')).toBe('09:15');
    expect(istTime('2026-10-19T18:30:00.000Z')).toBe('00:00');
    expect(istDateTime('2026-10-20T03:45:00.000Z')).toBe('Tue 20 Oct, 09:15');
    // 20:00 UTC on the 19th is already the 20th in IST.
    expect(istDate('2026-10-19T20:00:00.000Z')).toBe('Tue 20 Oct');
  });
  it('dashes a missing or bad time', () => {
    expect(istTime(null)).toBe('—');
    expect(istDateTime('not a date')).toBe('—');
  });
});

describe('summary line', () => {
  it('matches the morning strip', () => {
    expect(summaryLine({ positions: 4, exitAtOpen: 3, tighten: 0, held: 1, newsOnPositions: 12, eventsToday: 2 })).toBe(
      '4 positions · 3 Exit at open · 1 held · 12 headlines on your positions · 2 events today',
    );
  });
  it('pluralises and handles a flat book', () => {
    expect(summaryLine({ positions: 1, exitAtOpen: 0, tighten: 1, held: 0, newsOnPositions: 1, eventsToday: 1 })).toBe(
      '1 position · 1 Tighten · 1 headline on your positions · 1 event today',
    );
    expect(summaryLine({ positions: 0, exitAtOpen: 0, tighten: 0, held: 0, newsOnPositions: 0, eventsToday: 0 })).toBe(
      'No open positions · 0 events today',
    );
  });
});

describe('section errors and sentiment', () => {
  it('recognises the error shape only', () => {
    expect(isSectionError({ error: 'boom' })).toBe(true);
    expect(isSectionError([])).toBe(false);
    expect(isSectionError({ status: 'ok', asOf: null, horizons: {} })).toBe(false);
  });
  it('reads sentiment words, then the score', () => {
    expect(sentimentTone('Positive', null)).toBe('positive');
    expect(sentimentTone('bearish', null)).toBe('negative');
    expect(sentimentTone(null, 0.5)).toBe('positive');
    expect(sentimentTone(null, -0.5)).toBe('negative');
    expect(sentimentTone(null, null)).toBe('neutral');
  });
});

describe('safeExternalUrl (feed URLs are external input)', () => {
  it('keeps absolute http(s) links', () => {
    expect(safeExternalUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeExternalUrl('http://example.com/')).toBe('http://example.com/');
  });
  it('drops script, data, relative and garbage URLs', () => {
    for (const u of ['javascript:alert(1)', ' JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', '/charts', 'not a url', '', null, undefined]) {
      expect(safeExternalUrl(u as string | null | undefined)).toBeNull();
    }
  });
});
