import type { GlobalChart } from './global-chart';
import { outlookAlertText, type PreOpenOutlook } from './outlook';
import { US_OVERNIGHT, usOvernightOf } from './us-overnight';

const H = 3_600_000;
// Wed 4 Nov 2026 08:30 IST = 03:00 UTC; the NSE close Tue 15:30 IST = 10:00 UTC.
const NOW = new Date('2026-11-04T03:00:00Z');
const CLOSE = new Date('2026-11-03T10:00:00Z');

/** Hourly bars from Tue 08:00 UTC to Wed 02:00 UTC; ES 7580 at the NSE close, 7504.2 (−1 %) by 02:00 UTC. */
function chart(symbol: string, atClose: number, now: number, previousClose: number | null = null): GlobalChart {
  const bars: GlobalChart['bars'] = [];
  for (let t = Date.parse('2026-11-03T08:00:00Z'); t <= Date.parse('2026-11-04T02:00:00Z'); t += H) {
    bars.push({ t, close: t + H <= CLOSE.getTime() ? atClose : now });
  }
  return { symbol, price: null, priceAt: null, intervalMs: H, bars, previousClose };
}

const base = {
  at: NOW,
  indianClose: { price: 25_000, at: CLOSE },
  es: { chart: chart('ES=F', 7580, 7504.2, 7550), source: 'Yahoo chart ES=F' },
  crude: { chart: chart('CL=F', 100, 102), source: 'Yahoo chart CL=F' },
  vix: { close: 15.87, at: new Date('2026-11-03T09:59:00Z') },
  events: [],
};

describe('US overnight section (volatility / gap size — no direction)', () => {
  it('ES since the Indian close and since its own previous close, crude, VIX 1σ day, gap SIZE = |ES| × 0.5', () => {
    const u = usOvernightOf(base);
    expect(US_OVERNIGHT.esNiftyBeta).toBe(0.5);
    expect(u.es.sinceIndianClose).toMatchObject({ status: 'OK', movePct: -1, from: { price: 7580 }, to: { price: 7504.2 } });
    expect(u.es.sinceOwnClose).toEqual({ pct: -0.61, from: 7550, to: 7504.2 });
    expect(u.crude).toMatchObject({ status: 'OK', movePct: 2 });
    expect(u.vix).toEqual({ close: 15.87, at: '2026-11-03T09:59:00.000Z', typicalDayMovePct: 1 });
    expect(u.gapEstimate).toMatchObject({ sizePct: 0.5, sizePoints: 125 });
    expect(u.lines.join('\n')).toContain('S&P 500 futures (ES=F): -1.00% since the Indian close, -0.61% since its own previous close');
    expect(u.lines.join('\n')).toContain('≈ 0.50% (~125 pts) — ESTIMATE');
    expect(u.lines.join('\n')).not.toMatch(/BULLISH|BEARISH|gap up|gap down/i);
    expect(u.events).toEqual([]);
  });

  it('an active event adds the plain "bigger-than-usual, direction not predicted" line', () => {
    const u = usOvernightOf({ ...base, events: [{ date: '2026-11-04', name: 'US_MIDTERM_RESULTS' }] });
    expect(u.events).toEqual([{ date: '2026-11-04', name: 'US_MIDTERM_RESULTS', label: 'US midterm results overnight' }]);
    expect(u.lines).toContain('Event: US midterm results overnight — expect a bigger-than-usual opening move; direction not predicted');
  });

  it('missing data → n/a lines, no gap estimate, never a throw', () => {
    const u = usOvernightOf({ at: NOW, indianClose: null, es: { chart: null, source: 'n/a', why: 'HTTP 503' }, crude: { chart: null, source: 'n/a' }, vix: null, events: [] });
    expect(u.es).toEqual({ sinceIndianClose: null, sinceOwnClose: null });
    expect(u.gapEstimate).toBeNull();
    expect(u.lines[0]).toContain('n/a since the Indian close (no Indian close)');
    expect(u.lines).toContain('India VIX: n/a');
  });

  it('the Telegram alert appends the US overnight block once', () => {
    const u = usOvernightOf({ ...base, events: [{ date: '2026-11-04', name: 'US_MIDTERM_RESULTS' }] });
    const o = (x: string) => ({ underlying: x, sessionDate: '2026-11-04', bias: 'NEUTRAL', confidence: 0, gap: null, lastClose: null, global: null, theme: { summary: '' }, headlines: [], usOvernight: u }) as unknown as PreOpenOutlook;
    const text = outlookAlertText([o('NIFTY'), o('BANKNIFTY')]);
    expect(text.match(/US overnight \(volatility/g)).toHaveLength(1);
    expect(text).toContain('  Event: US midterm results overnight');
  });
});
