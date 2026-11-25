import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MarketNotes, MarketNotesView } from './MarketNotes';
import { SetupCard } from './SetupCard';
import { entryLine, exitLabel, optionName, setupStatus, type AiSetupRow, type MarketNote, type ReaderHealth } from './signalsTelegram';

const NOW = Date.parse('2026-11-25T06:00:00Z'); // 11:30 IST

const health: ReaderHealth = { mode: 'shadow', agentsOn: true, lastReadAt: '2026-11-25T05:58:00Z', lastHour: { posts: 3, byStatus: { READ: 3 }, p50Ms: 4000, p95Ms: 8000 } };

const note: MarketNote = {
  messageId: 'm1',
  channelId: 'c1',
  channelTitle: 'Stock Gainers',
  postedAt: '2026-11-25T05:20:00Z',
  readAt: '2026-11-25T05:20:05Z',
  status: 'READ',
  kind: 'INFO',
  scope: 'INSTRUMENT',
  summary: 'DABUR breaking out.',
  latencyMs: 5000,
  error: null,
  claims: [],
};

const base: AiSetupRow = {
  id: 's1',
  readingId: 'm1',
  underlying: 'DABUR',
  channelId: 'c1',
  channelTitle: 'Stock Gainers',
  createdAt: '2026-11-25T05:21:00Z', // 10:51 IST
  decision: 'SETUP',
  status: 'PENDING',
  reason: 'Breakout is real but late; buy the pullback to 520 (day high 521.4).',
  claim: { text: 'DABUR breaking out above 520', subject: 'DABUR', bias: 'BULL', verdict: 'CONFIRMED' },
  failedCheck: null,
  setup: {
    instrument: { kind: 'OPT', symbol: 'DABUR', strike: 520, optionType: 'CE', expiry: '2026-11-27' },
    side: 'BUY',
    entry: { type: 'LIMIT_PULLBACK', low: 518, high: 520, trigger: null, level: 520 },
    sl: 514,
    targets: [528, 534],
    validUntil: '14:30',
    confidence: 64,
    evidence: [{ fact: 'day high', value: '521.4', source: 'quote' }],
  },
  validUntil: '2026-11-25T09:00:00Z',
  entryAt: null,
  exitAt: null,
  exitReason: null,
  pnl: null,
  grade: null,
};

const html = (s: AiSetupRow) => renderToStaticMarkup(<SetupCard s={s} />);

describe('AI setup card', () => {
  it('SETUP waiting: option, entry zone, SL, targets, valid until, confidence, reason, waiting status', () => {
    const h = html(base);
    expect(h).toContain('AI SETUP');
    expect(h).toContain('Channel said:');
    expect(h).toContain('DABUR breaking out above 520');
    expect(h).toContain('checked: confirmed');
    expect(h).toContain('Buy DABUR 520 CE · 27 Nov expiry');
    expect(h).toContain('Buy when DABUR comes back into 518–520');
    expect(h).toContain('514');
    expect(h).toContain('528 · 534');
    expect(h).toContain('14:30 IST');
    expect(h).toContain('64/100');
    expect(h).toContain('buy the pullback to 520');
    expect(h).toContain('Numbers behind it (1)');
    expect(h).toMatch(/data-testid="setup-status"[^>]*>Waiting for entry \(paper\)</);
    expect(h).toContain('10:51');
    expect(h).not.toContain('setup-pnl');
    expect(h).not.toContain('setup-grade');
  });

  it('SETUP exited with P&L, the actual net and the plan-only result', () => {
    const h = html({
      ...base,
      status: 'EXITED',
      entryAt: '2026-11-25T05:45:00Z',
      exitAt: '2026-11-25T07:15:00Z',
      exitReason: 'AI_SETUP_TARGET',
      pnl: 1250,
      grade: {
        status: 'GRADED',
        kind: 'SETUP',
        actual: { filled: true, exitReason: 'AI_SETUP_TARGET', pnlGross: 1250, fees: 64, net: 1186 },
        plan: { status: 'GRADED', filled: true, outcome: 'T2', rupees: 1100 },
      },
    });
    expect(h).toMatch(/data-testid="setup-status"[^>]*>Exited \(paper\) — target hit</);
    expect(h).toContain('in 11:15');
    expect(h).toContain('out 12:45');
    expect(h).toMatch(/data-testid="setup-pnl"[^>]*>₹1,250</);
    expect(h).toContain('text-emerald-400');
    expect(h).toContain('₹1,186');
    expect(h).toContain('after charges');
    expect(h).toContain('₹64');
    expect(h).toContain('Plan&#x27;s levels only');
    expect(h).toContain('₹1,100');
    // a loss shows the minus sign in red
    expect(html({ ...base, status: 'EXITED', exitReason: 'AI_SETUP_SL', pnl: -420 })).toMatch(/data-testid="setup-pnl"[^>]*text-red-400[^>]*>−₹420</);
  });

  it('NO_TRADE shows the reason; a blocked setup shows the failed check in plain words', () => {
    const nt = html({ ...base, decision: 'NO_TRADE', status: 'NO_TRADE', setup: null, reason: 'Already ran 2 ATR from the level; chasing.' });
    expect(nt).toContain('NO TRADE');
    expect(nt).toMatch(/data-testid="setup-reason"[^>]*>Already ran 2 ATR from the level; chasing.</);
    expect(nt).not.toContain('Valid until');
    expect(nt).not.toContain('setup-status');

    const blocked = html({ ...base, status: 'NO_TRADE', failedCheck: { name: 'rr_below_min', detail: 'reward:risk 0.9 < 1.2' }, reason: 'code check rr_below_min: reward:risk 0.9 < 1.2' });
    expect(blocked).toContain('SETUP BLOCKED');
    expect(blocked).toContain('AI wanted');
    expect(blocked).toMatch(/data-testid="setup-failed-check"[^>]*>reward too small for the risk — reward:risk 0.9 &lt; 1.2</);

    const skipped = html({ ...base, decision: 'SKIPPED', status: 'SKIPPED', setup: null, reason: 'daily cap: 3 AI setups already today (max 3)' });
    expect(skipped).toContain('Why skipped');
    expect(skipped).toContain('daily cap');
  });

  it('the what-if result is labelled hypothetical, never a real trade', () => {
    const h = html({
      ...base,
      decision: 'NO_TRADE',
      status: 'NO_TRADE',
      setup: null,
      reason: 'No room to the next resistance.',
      grade: { status: 'GRADED', kind: 'NO_TRADE_REFERENCE', whatIf: { status: 'GRADED', hypothetical: true, filled: true, outcome: 'SL', rupees: -600, reference: 'neutral reference' } },
    });
    expect(h).toMatch(/What if \(hypothetical\)/);
    expect(h).toMatch(/data-testid="grade-what-if"[^>]*>−₹600 · sl — not a real trade, a simple reference trade the AI did not make</);
    expect(h).not.toContain('Paper result');
    const pending = html({ ...base, status: 'NO_TRADE', failedCheck: { name: 'anti_chase', detail: 'x' }, grade: { status: 'GRADED', whatIf: { status: 'PENDING', reason: 'bars', hypothetical: true } } });
    expect(pending).toContain('not graded yet — not a real trade, the blocked setup as written');
  });

  it('expired with why, breakout and market entries, formatting helpers', () => {
    expect(setupStatus({ status: 'EXPIRED', exitReason: 'VALID_UNTIL_PASSED: valid until 14:30 IST passed' })).toBe('Expired, no trade — entry price never came before the time limit');
    expect(setupStatus({ status: 'FILLED', exitReason: null })).toBe('In trade (paper)');
    expect(exitLabel('SOMETHING_ELSE')).toBe('something else');
    expect(optionName({ kind: 'OPT', symbol: 'NIFTY', strike: 24500, optionType: 'PE', expiry: '2026-12-02' })).toBe('NIFTY 24500 PE · 2 Dec expiry');
    const pe = { ...base.setup!, instrument: { ...base.setup!.instrument, optionType: 'PE' as const }, entry: { type: 'BREAKOUT_TRIGGER', low: 510, high: 510, trigger: 510, level: 511 } };
    expect(entryLine(pe)).toBe('Buy when a 15-min candle of DABUR closes below 510');
    expect(entryLine({ ...pe, entry: { type: 'MARKET_NOW', low: 522, high: 522, trigger: null, level: 521.4 } })).toBe('Buy now (DABUR near 522)');
  });
});

describe('setup cards on the Market notes screen', () => {
  it('sits under the reading it came from; other readings get none; orphans go after the list', () => {
    const other: MarketNote = { ...note, messageId: 'm0', postedAt: '2026-11-25T04:00:00Z', summary: 'Market flat.' };
    const orphan = { ...base, id: 's9', readingId: 'gone' };
    const h = renderToStaticMarkup(<MarketNotesView health={health} notes={[note, other]} nowMs={NOW} setups={[base, orphan]} />);
    const first = h.indexOf('DABUR breaking out.');
    const card = h.indexOf('data-testid="setup-card"');
    const second = h.indexOf('Market flat.');
    expect(first).toBeLessThan(card);
    expect(card).toBeLessThan(second);
    expect(h.match(/data-testid="setup-card"/g)).toHaveLength(2);
    expect(h.indexOf('data-testid="other-setups"')).toBeGreaterThan(second);
  });

  it('hidden when AI_SETUPS is off', () => {
    const qc = new QueryClient();
    qc.setQueryData(['message-reader', 'health'], health);
    qc.setQueryData(['message-reader', 'notes', '2026-11-25'], { date: '2026-11-25', notes: [note] });
    const page = () =>
      renderToStaticMarkup(
        <QueryClientProvider client={qc}>
          <MarketNotes date="2026-11-25" />
        </QueryClientProvider>,
      );
    qc.setQueryData(['ai-setups', '2026-11-25'], { date: '2026-11-25', mode: 'off', setups: [base] });
    const off = page();
    expect(off).toContain('DABUR breaking out.');
    expect(off).not.toContain('setup-card');
    qc.setQueryData(['ai-setups', '2026-11-25'], { date: '2026-11-25', mode: 'paper', setups: [base] });
    expect(page()).toContain('data-testid="setup-card"');
  });
});
