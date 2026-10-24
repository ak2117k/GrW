import * as fs from 'fs';
import * as path from 'path';
import { ADVISOR_SUMMARY_MAX_CHARS, nightReportAdvisorSummary } from './night-report.advisor-summary';
import type { NightReport } from './night-report.types';

describe('nightReportAdvisorSummary (advisor read-only context)', () => {
  const report = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/sample.json'), 'utf8')) as NightReport;

  it('is a small digest of the top sections, not the payload', () => {
    const s = nightReportAdvisorSummary(report);
    expect(s).toContain('4 positions');
    expect(s.length).toBeLessThanOrEqual(ADVISOR_SUMMARY_MAX_CHARS);
    expect(s.length).toBeLessThan(JSON.stringify(report).length / 4);
  });

  it('skips errored sections and respects the char cap', () => {
    const r = { ...report, news: { error: 'x' }, mood: { error: 'down' }, newsIdeas: { error: 'y' } } as unknown as NightReport;
    const s = nightReportAdvisorSummary(r, 80);
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s).not.toContain('down');
  });

  it('lists at most 5 news ideas', () => {
    const idea = (i: number) => ({ symbol: `S${i}`, idea: 'CE_IDEA', headline: `h${i}` });
    const r = { ...report, newsIdeas: Array.from({ length: 9 }, (_, i) => idea(i)) } as unknown as NightReport;
    const s = nightReportAdvisorSummary(r);
    expect(s).toContain('S4 CE_IDEA');
    expect(s).not.toContain('S5 CE_IDEA');
  });
});
