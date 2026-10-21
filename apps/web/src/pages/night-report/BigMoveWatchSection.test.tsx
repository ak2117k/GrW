import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { BigMoveWatchView, NightReport } from '@/types/nightReport.types';
import fixture from '../../../tests/fixtures/night-report.json';
import { NightReportView } from './NightReportView';
import { BigMoveWatchPanel } from './BigMoveWatchSection';
import { bookLine, outcomeText, resultsText, sourcesText } from './bigMoveWatchFormat';

const view: BigMoveWatchView = {
  asOf: '2026-10-21',
  modelId: 'stock-move-20261021',
  scored: 211,
  rows: [
    {
      symbol: 'RELIANCE',
      sources: ['HELD', 'TOP'],
      reading: {
        symbol: 'RELIANCE', asOf: '2026-10-21', horizonDays: 5, pBig: 0.714, rankPct: 0.98, bucket: 'TOP20',
        resultsDate: '2026-10-24', resultsInWindow: true, modelId: 'stock-move-20261021',
      },
      lastOutcome: { asOf: '2026-10-14', big: true, retBp: 352.4 },
    },
    { symbol: 'NEWCO', sources: ['NEWS_IDEA'], reading: null, lastOutcome: null },
  ],
};

function html(node: ReactElement) {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe('bigMoveWatchFormat', () => {
  it('formats the book line, results, outcome and sources', () => {
    expect(bookLine(view)).toBe('Book 2026-10-21 · 211 names scored · shadow (0 scorecard points)');
    expect(bookLine({ ...view, asOf: null, scored: 0 })).toContain('no stock-move score yet');
    expect(resultsText(view.rows[0].reading)).toBe('results 2026-10-24 · in window');
    expect(resultsText(null)).toBeNull();
    expect(outcomeText(view.rows[0].lastOutcome)).toBe('last: BIG 352 bp (as of 2026-10-14)');
    expect(outcomeText(null)).toBe('no resolved call yet');
    expect(sourcesText(['HELD', 'TOP'])).toBe('held · top of the day');
  });
});

describe('BigMoveWatchPanel', () => {
  it('lists each name with p, bucket, results date and last outcome; unscored names say so', () => {
    const out = html(<BigMoveWatchPanel view={view} />);
    expect(out).toContain('RELIANCE');
    expect(out).toContain('p 0.71');
    expect(out).toContain('TOP20');
    expect(out).toContain('results 2026-10-24 · in window');
    expect(out).toContain('last: BIG 352 bp (as of 2026-10-14)');
    expect(out).toContain('NEWCO');
    expect(out).toContain('no stock-move score yet');
  });
});

describe('NightReportView big-move section (fail-soft)', () => {
  const base = fixture as unknown as NightReport;
  it('absent → hidden; null → not in this build; error → section failed; present → panel', () => {
    expect(html(<NightReportView report={{ ...base, bigMoveWatch: undefined }} />)).not.toContain('aria-label="Big-move watch"');
    expect(html(<NightReportView report={{ ...base, bigMoveWatch: null }} />)).toContain('The stock big-move model is not in this API build yet.');
    const failed = html(<NightReportView report={{ ...base, bigMoveWatch: { error: 'boom' } }} />);
    expect(failed).toContain('aria-label="Big-move watch"');
    expect(failed).toContain('Couldn&#x27;t load this section');
    expect(html(<NightReportView report={{ ...base, bigMoveWatch: view }} />)).toContain('data-testid="big-move-watch"');
  });
});
