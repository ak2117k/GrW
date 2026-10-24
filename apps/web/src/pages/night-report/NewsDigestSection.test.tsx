import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { NewsDigestItem, NewsDigestView, NightReport } from '@/types/nightReport.types';
import fixture from '../../../tests/fixtures/night-report.json';
import { NightReportView } from './NightReportView';
import { affectedText, NewsDigestPanel, reactionText } from './NewsDigestSection';

const item: NewsDigestItem = {
  clusterId: 'c1',
  headline: 'Reliance wins ₹5,000 cr green hydrogen order',
  direction: 'BULL',
  magnitude: 'HIGH',
  horizon: 'DAYS',
  pricedIn: false,
  confidence: 0.8,
  oneLine: 'Large order vs revenue; positive for RIL and energy names.',
  affected: { symbols: ['RELIANCE'], sectors: ['Energy'], index: 'NIFTY' },
  sources: ['Economic Times', 'LiveMint', 'NSE Announcements'],
  sourceCount: 3,
  materialType: 'ORDER_WIN',
  firstSeen: '2026-10-23T05:00:00.000Z',
  analysedAt: '2026-10-23T05:15:00.000Z',
  reaction: [
    { symbol: 'RELIANCE', movePct: 1.2, at: 'p60' },
    { symbol: 'NIFTY', movePct: -0.3, at: 'close' },
  ],
};
const view: NewsDigestView = { since: '2026-10-22T10:00:00.000Z', note: 'Context only — never a trade trigger.', items: [item] };
const html = (el: ReactElement) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);

describe('News digest', () => {
  it('formats affected and the reaction so far', () => {
    expect(affectedText(item)).toBe('NIFTY, RELIANCE · Energy');
    expect(reactionText(item)).toBe('RELIANCE +1.20% (+60m) · NIFTY −0.30% (close)');
    expect(reactionText({ ...item, reaction: [{ symbol: 'X', movePct: null, at: null }] })).toBe('no reaction yet');
    expect(affectedText({ ...item, affected: { symbols: [], sectors: [], index: null } })).toBe('market-wide');
  });

  it('renders headline, direction, magnitude, sources and reaction', () => {
    const out = html(<NewsDigestPanel view={view} />);
    expect(out).toContain('Reliance wins');
    expect(out).toContain('BULL');
    expect(out).toContain('HIGH');
    expect(out).toContain('3 sources');
    expect(out).toContain('order_win');
    expect(out).toContain('RELIANCE +1.20% (+60m)');
  });

  it('empty window says so', () => {
    expect(html(<NewsDigestPanel view={{ ...view, items: [] }} />)).toContain('No analysed news in this window.');
  });

  it('the report shows the section when present, an error when it failed, nothing when absent', () => {
    const base = fixture as unknown as NightReport;
    expect(html(<NightReportView report={{ ...base, newsDigest: view }} />)).toContain('News digest');
    const failed = html(<NightReportView report={{ ...base, newsDigest: { error: 'boom' } }} />);
    expect(failed).toContain('News digest');
    expect(failed).not.toContain('Reliance wins');
    expect(html(<NightReportView report={{ ...base, newsDigest: null }} />)).not.toContain('News digest');
  });
});
