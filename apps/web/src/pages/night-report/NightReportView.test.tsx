import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { NightReport } from '@/types/nightReport.types';
import fixture from '../../../tests/fixtures/night-report.json';
import { NightReportView } from './NightReportView';

const report = fixture as unknown as NightReport;

function render(r: NightReport): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <NightReportView report={r} onRefresh={() => {}} />
    </MemoryRouter>,
  );
}

describe('NightReportView', () => {
  it('renders every section from the contract-shaped fixture', () => {
    const html = render(report);
    expect(html).toContain('2 positions · 1 Exit at open · 1 held · 3 headlines on your positions · 2 events today');
    expect(html).toContain('NIFTY28OCT2625000CE');
    expect(html).toContain('Exit at open');
    expect(html).toContain('Held');
    expect(html).toContain('Exit at the open if NIFTY opens below 24,950.');
    expect(html).toContain('Reliance Jio raises tariffs by 10%');
    expect(html).toContain('US stocks slide as yields jump');
    expect(html).toContain('Infosys Q2 results');
    expect(html).toContain('16:00'); // 10:30 UTC event in IST
    expect(html).toContain('overnight-review');
    expect(html).toContain('Stale');
    expect(html).toContain('P(big move) 42%');
  });

  it('links symbols to their chart and news out in a new tab', () => {
    const html = render(report);
    expect(html).toContain('href="/charts?symbol=RELIANCE&amp;token=2885&amp;exchange=NSE"');
    expect(html).toContain('href="/charts?symbol=NIFTY&amp;token=99926000&amp;exchange=NSE"');
    expect(html).toMatch(/href="https:\/\/example.com\/reliance-jio-tariffs" target="_blank" rel="noopener noreferrer"/);
    // A symbol without a token resolves on click (button), not a dead link.
    expect(html).toMatch(/<button type="button" title="Open CRUDEOIL chart"/);
  });

  it('shows a failed section as one muted line and keeps the rest', () => {
    const html = render(report); // dailySetups is { error } in the fixture
    expect(html.match(/Couldn&#x27;t load this section/g)?.length).toBe(1);
    expect(html).toContain('Infosys Q2 results');
  });

  it('shows empty states per section', () => {
    const html = render({
      ...report,
      positions: [],
      news: { onPositions: [], market: [] },
      events: [],
      dailySetups: [],
      mood: { status: 'absent', asOf: null, horizons: {} },
      jobs: [],
    });
    expect(html).toContain('No open positions overnight');
    expect(html).toContain('No headlines on your positions overnight');
    expect(html).toContain('No market headlines overnight');
    expect(html).toContain('No events today');
    expect(html).toContain('No daily setups fired');
    expect(html).toContain('Market mood is absent');
    expect(html).not.toContain('load this section');
  });
});
