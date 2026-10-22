import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { NightReport, TradeSetupView, TradeSetupsView } from '@/types/nightReport.types';
import fixture from '../../../tests/fixtures/night-report.json';
import { NightReportView } from './NightReportView';
import { TradeSetupsPanel } from './TradeSetupsSection';
import { levelsText, qtyText, riskText, sessionLine } from './tradeSetupsFormat';

const setup: TradeSetupView = {
  id: 's1', sessionDate: '2026-10-23', symbol: 'RELIANCE', exchange: 'NFO',
  instrument: 'RELIANCE27OCT26FUT (NFO futures, near month)', instrumentKind: 'FUTURES', expiry: '2026-10-27', lotSize: 500,
  side: 'LONG', entryRule: 'Wait for the first 15-min candle (09:15–09:30 IST) to close; enter LONG only on a break of its high (buy above it).',
  entryRef: 1400, stop: 1372, stopDistance: 28, target1: 1442, target2: 1470, atr: 28,
  qty: 500, lots: 1, riskRs: 14000, riskPct: 1.4, rewardT1Rs: 21000, rewardT2Rs: 35000, marginUsed: 140000,
  marginAvailable: 1000000, marginAsOf: '2026-10-22T09:30:00.000Z', marginSource: 'LAST_KNOWN', exceedsRisk: true,
  inputs: {
    trigger: 'news idea + big-move model TOP20',
    direction: 'Direction is from the news idea, not price.',
    priceAsOf: '2026-10-22',
    sizingBasis: 'margin ₹10,00,000 last known as of 2026-10-22T09:30:00.000Z',
    sizingNotes: ['exceeds 1% risk — 1 lot risks ₹14000 (1.4%)'],
    stopRule: 'Stop: 1× daily ATR (28) from entry.',
    targetsRule: 'Targets from your fill: T1 = 1.5R, T2 = 2.5R.',
    timeExit: 'Intraday plan: exit by 15:10 IST if neither target nor stop is hit.',
    levelsNote: 'Levels are on the RELIANCE cash chart.',
    context: [
      { label: 'Options OI / PCR', text: 'PCR 1.30 (5d med 1.10)', available: true },
      { label: 'Futures OI build-up', text: 'unavailable (futures OI is not captured yet)', available: false },
    ],
    skipIf: ['RELIANCE opens more than 1.5× ATR (42) below 1400, against the side'],
    headlines: ['Reliance wins a big order'],
    advisory: 'Advisory only — you place the order.',
  },
  outcome: null,
  updatedAt: '2026-10-22T18:20:00.000Z',
};
const view: TradeSetupsView = { sessionDate: '2026-10-23', setups: [setup], advisory: 'Advisory only — you place the order. Nothing here is sent to the broker.' };

const html = (node: ReactElement) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

describe('tradeSetupsFormat', () => {
  it('formats qty, risk, levels and the session line', () => {
    expect(qtyText(setup)).toBe('1 lot (500 units, lot 500)');
    expect(qtyText({ ...setup, lots: null, qty: 35 })).toBe('35 shares');
    expect(riskText(setup)).toBe('Risk ₹14,000 (1.4%) · T1 +₹21,000 · T2 +₹35,000 · margin ~₹1,40,000');
    expect(levelsText(setup)).toBe('Entry ref 1400.00 · stop 1372.00 (28.00) · T1 1442.00 · T2 1470.00 · ATR 28.00');
    expect(sessionLine(view)).toContain('2026-10-23 session · 1 setup');
  });
});

describe('TradeSetupsPanel', () => {
  it('shows the card: symbol, instrument, side, entry rule, stop, targets, qty and risk, context, skip-if, advisory note', () => {
    const out = html(<TradeSetupsPanel view={view} />);
    expect(out).toContain('RELIANCE27OCT26FUT');
    expect(out).toContain('BUY / long');
    expect(out).toContain('break of its high');
    expect(out).toContain('stop 1372.00');
    expect(out).toContain('1 lot (500 units, lot 500)');
    expect(out).toContain('exceeds 1% risk');
    expect(out).toContain('Futures OI build-up');
    expect(out).toContain('unavailable (futures OI is not captured yet)');
    expect(out).toContain('Skip if');
    expect(out).toContain('Reliance wins a big order');
    expect(out).toContain('Advisory only — you place the order.');
  });
  it('empty list says why', () => {
    expect(html(<TradeSetupsPanel view={{ ...view, setups: [] }} />)).toContain('No setups');
  });
});

describe('NightReportView trade-setups section (fail-soft)', () => {
  const base = fixture as unknown as NightReport;
  it('absent → hidden; null → not in this build; error → section failed; present → panel', () => {
    expect(html(<NightReportView report={{ ...base, tradeSetups: undefined }} />)).not.toContain('aria-label="Trade setups"');
    expect(html(<NightReportView report={{ ...base, tradeSetups: null }} />)).toContain('Trade setups are not in this API build yet.');
    const failed = html(<NightReportView report={{ ...base, tradeSetups: { error: 'boom' } }} />);
    expect(failed).toContain('aria-label="Trade setups"');
    expect(failed).toContain('Couldn&#x27;t load this section');
    expect(html(<NightReportView report={{ ...base, tradeSetups: view }} />)).toContain('data-testid="trade-setups"');
  });
});
