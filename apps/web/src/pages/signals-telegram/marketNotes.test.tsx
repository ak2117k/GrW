import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { aiSetupsPollMs, MarketNotes, MarketNotesView, showAiSetupsError } from './MarketNotes';
import { istToday, readerNotReading, verdictChip, type MarketNote, type ReaderHealth } from './signalsTelegram';

const NOW = Date.parse('2026-11-25T06:00:00Z'); // 11:30 IST

const health = (over: Partial<ReaderHealth> = {}): ReaderHealth => ({
  mode: 'shadow',
  agentsOn: true,
  lastReadAt: '2026-11-25T05:58:00Z',
  lastHour: { posts: 12, byStatus: { READ: 11, NOISE: 1 }, p50Ms: 4200, p95Ms: 9800 },
  ...over,
});

const note: MarketNote = {
  messageId: 'm1',
  channelId: 'c1',
  channelTitle: 'Alpha Trades',
  postedAt: '2026-11-25T05:50:00Z', // 11:20 IST
  readAt: '2026-11-25T05:50:06Z',
  status: 'READ',
  kind: 'INFO',
  scope: 'MARKET',
  summary: 'Stocks weak while the index holds up.',
  latencyMs: 6100,
  error: null,
  claims: [
    {
      text: 'stocks weak, index strong',
      subject: 'MARKET',
      bias: 'CAUTION',
      horizon: 'INTRADAY',
      claimType: 'RELATIVE_BREADTH',
      verdict: 'CONFIRMED',
      evidence: [
        { fact: 'A/D ratio', value: '0.62', source: 'breadth' },
        { fact: 'NIFTY change', value: '+0.4%', source: 'quote' },
      ],
    },
    { text: 'banks to lead tomorrow', subject: 'BANKNIFTY', bias: 'BULL', horizon: 'DAYS', claimType: 'SECTOR', verdict: 'NOT_CHECKABLE', evidence: [] },
  ],
};

describe('market notes', () => {
  it('renders a CONFIRMED chip with evidence', () => {
    const html = renderToStaticMarkup(<MarketNotesView health={health()} notes={[note]} nowMs={NOW} />);
    expect(html.match(/data-testid="market-note"/g)).toHaveLength(1);
    expect(html).toContain('11:20');
    expect(html).toContain('Alpha Trades');
    expect(html).toContain('Stocks weak while the index holds up.');
    expect(html).toMatch(/data-testid="verdict-CONFIRMED"[^>]*><span[^>]*text-emerald-400[^>]*>CONFIRMED</);
    expect(html).toMatch(/data-testid="verdict-NOT_CHECKABLE"[^>]*><span[^>]*bg-transparent[^>]*>NOT CHECKABLE</);
    expect(html).toContain('<details');
    expect(html).toContain('A/D ratio');
    expect(html).toContain('0.62');
    expect(html).toContain('SHADOW');
    expect(html).toContain('p95 9.8s');
    expect(html).not.toContain('Reader not reading');
    expect(verdictChip('CONTRADICTED')).toMatchObject({ variant: 'danger' });
    expect(verdictChip('UNCLEAR')).toMatchObject({ variant: 'neutral' });
  });

  it('shows the red badge when nothing was read for 15 min', () => {
    const stale = health({ lastReadAt: '2026-11-25T05:40:00Z' }); // 20 min ago, posts in the last hour
    expect(readerNotReading(stale, NOW)).toBe(true);
    expect(readerNotReading(health({ lastReadAt: null }), NOW)).toBe(true);
    expect(readerNotReading(health(), NOW)).toBe(false);
    expect(readerNotReading(health({ lastReadAt: '2026-11-25T05:40:00Z', lastHour: { posts: 0, byStatus: {}, p50Ms: null, p95Ms: null } }), NOW)).toBe(false);
    // configured but the AI agents are off: it cannot run
    expect(readerNotReading(health({ agentsOn: false }), NOW)).toBe(true);
    const html = renderToStaticMarkup(<MarketNotesView health={stale} notes={[]} nowMs={NOW} />);
    expect(html).toMatch(/data-testid="reader-not-reading"[^>]*><span[^>]*text-red-400[^>]*>Reader not reading</);
  });

  it('renders nothing when mode is off', () => {
    expect(renderToStaticMarkup(<MarketNotesView health={health({ mode: 'off', agentsOn: false })} notes={[note]} nowMs={NOW} />)).toBe('');
    const qc = new QueryClient();
    qc.setQueryData(['message-reader', 'health'], health({ mode: 'off' }));
    qc.setQueryData(['message-reader', 'notes', '2026-11-25'], { date: '2026-11-25', notes: [note] });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MarketNotes date="2026-11-25" />
      </QueryClientProvider>,
    );
    expect(html).toBe('');
    qc.setQueryData(['message-reader', 'health'], health());
    const on = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MarketNotes date="2026-11-25" />
      </QueryClientProvider>,
    );
    expect(on).toContain('data-testid="market-notes"');
    expect(on).toContain('Alpha Trades');
  });
});

describe('AI setups query (feature off / API not deployed)', () => {
  const data = (mode: string) => ({ date: '2026-11-25', mode, setups: [] });

  it('polls every 30 s until the API says mode off, then stops', () => {
    expect(aiSetupsPollMs(undefined)).toBe(30_000);
    expect(aiSetupsPollMs(data('paper'))).toBe(30_000);
    expect(aiSetupsPollMs(data('off'))).toBe(false);
  });

  it('shows the error line only when the last known mode is on (unknown or off → hidden)', () => {
    expect(showAiSetupsError(false, data('paper'))).toBe(false);
    expect(showAiSetupsError(true, undefined)).toBe(false); // e.g. a 404 before the API deploys
    expect(showAiSetupsError(true, data('off'))).toBe(false);
    expect(showAiSetupsError(true, data('paper'))).toBe(true);
  });
});

describe('Telegram signals page placement', () => {
  it('mounts the market notes above the signal list only when given a date', async () => {
    const { SignalsTelegramView } = await import('./SignalsTelegramView');
    const data = { mode: 'shadow' as const, caps: { maxLots: 1, maxLossPerTrade: 2000, maxTradesPerDay: 5, dailyLossStop: 5000, entryTolerancePct: 3, product: 'INTRADAY' }, slEnforcement: { ok: true, detail: '' }, decisions: [], orders: [], channels: [] };
    const qc = new QueryClient();
    qc.setQueryData(['message-reader', 'health'], health());
    qc.setQueryData(['message-reader', 'notes', '2026-11-25'], { date: '2026-11-25', notes: [note] });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <SignalsTelegramView data={data} marketNotesDate="2026-11-25" />
      </QueryClientProvider>,
    );
    expect(html.indexOf('data-testid="market-notes"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="market-notes"')).toBeLessThan(html.indexOf("Today&#x27;s signals"));
    expect(renderToStaticMarkup(<SignalsTelegramView data={data} />)).not.toContain('market-notes');
    expect(istToday(Date.parse('2026-11-24T19:00:00Z'))).toBe('2026-11-25'); // 00:30 IST is the next session
  });
});
