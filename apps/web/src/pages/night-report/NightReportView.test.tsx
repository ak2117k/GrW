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
    expect(html).toContain('2 positions · 2 Exit at open · 1 held · 3 headlines on your positions · 2 events today');
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

  it('shows each position scorecard and flags the verdict that disagrees with it', () => {
    const html = render(report);
    expect(html.match(/data-testid="scorecard"/g)?.length).toBe(3); // 2 positions + 1 news idea
    expect(html).toContain('Option chain (OI)');
    expect(html).toContain('Indicators (EMA 9/20, MACD, RSI)');
    expect(html).toContain('PCR 2.1 (5d med 1.3), put build +18% @2860');
    expect(html).toContain('Strongly supports +4');
    expect(html).toContain('Against −3');
    // RELIANCE: EXIT_AT_OPEN against a STRONG_SUPPORTS band. NIFTY CE: exit with an AGAINST band agrees.
    expect(html.match(/data-testid="scorecard-disagrees"/g)?.length).toBe(1);
    const reliance = html.slice(html.indexOf('Open RELIANCE chart'));
    expect(reliance).toContain('Disagrees with scorecard');
    // NIFTY's missing fii_dii and absent mood factor render greyed.
    expect(html).toContain('Missing: FII/DII data for 19 Oct not published');
    expect(html).toContain('Missing: Not computed');
  });

  it('renders news ideas newest first with badge, plan, outcome and safe links', () => {
    const html = render(report);
    expect(html.match(/data-testid="night-news-idea"/g)?.length).toBe(2);
    expect(html.indexOf('Paytm gets RBI observation')).toBeLessThan(html.indexOf('Tata Motors JLR wholesales'));
    expect(html).toContain('CE idea');
    expect(html).toContain('No trade');
    expect(html).toContain('Opens below 705 or gives up the gap in the first 30 minutes');
    expect(html).toContain('consider the 720 CE only above 715');
    expect(html).toContain('Next session +2.14%');
    expect(html).toMatch(/href="https:\/\/example.com\/jlr-q2" target="_blank" rel="noopener noreferrer"/);
    expect(html).not.toContain('javascript:');
    // No token on an idea: the chip resolves it on click.
    expect(html).toMatch(/<button type="button" title="Open TATAMOTORS chart"/);
  });

  it('treats a report without newsIdeas as empty and a failed one as failed', () => {
    const { newsIdeas: _omit, ...old } = report;
    expect(render(old as NightReport)).toContain('No news ideas tonight');
    const failed = render({ ...report, newsIdeas: { error: 'x' } });
    expect(failed.match(/Couldn&#x27;t load this section/g)?.length).toBe(2);
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
