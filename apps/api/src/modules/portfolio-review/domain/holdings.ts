import { DAY_MS, istDay } from './symbols';
import type { Episode, HoldingCheck, HoldingTag, HoldingTrend } from './types';

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

export const HOLDING_RULES = {
  /** DEAD-MONEY: down at least this much (%) … */
  deadLossPct: -20,
  /** … and held at least this many days. */
  deadMinDays: 60,
  /** CONCENTRATED: this share (%) of the holdings book at cost or more. */
  concentratedSharePct: 15,
  /** Sessions in ~6 months. */
  sixMonthBars: 126,
} as const;

export interface DailyBar {
  close: number;
  high: number;
  low: number;
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** 50/200-DMA, 52-week range and ~6-month return from daily bars (oldest first). Pure. */
export function trendFromBars(bars: DailyBar[]): HoldingTrend {
  const clean = bars.filter((b) => Number.isFinite(b.close) && b.close > 0);
  if (clean.length < 20) {
    return { status: 'NO_DATA', reason: `only ${clean.length} daily candles`, bars: clean.length, dma50: null, dma200: null, high52w: null, low52w: null, ret6m: null };
  }
  const closes = clean.map((b) => b.close);
  const last = closes[closes.length - 1];
  const year = clean.slice(-250);
  const back = closes[Math.max(0, closes.length - 1 - HOLDING_RULES.sixMonthBars)];
  return {
    status: 'OK',
    bars: clean.length,
    dma50: closes.length >= 50 ? round2(mean(closes.slice(-50))) : null,
    dma200: closes.length >= 200 ? round2(mean(closes.slice(-200))) : null,
    high52w: round2(Math.max(...year.map((b) => b.high || b.close))),
    low52w: round2(Math.min(...year.map((b) => b.low || b.close))),
    ret6m: round1(((last - back) / back) * 100),
  };
}

export const NO_TREND = (reason: string): HoldingTrend => ({
  status: 'NO_DATA',
  reason,
  bars: 0,
  dma50: null,
  dma200: null,
  high52w: null,
  low52w: null,
  ret6m: null,
});

const TAG_PRIORITY: HoldingTag[] = ['DEAD-MONEY', 'WEAK-TREND', 'CONCENTRATED', 'STRONG'];

/**
 * Deterministic tags:
 *  - DEAD-MONEY:   P&L ≤ −20% AND held ≥ 60 days
 *  - WEAK-TREND:   LTP < 50-DMA AND (LTP < 200-DMA, or 6-month return < 0 when < 200 candles)
 *  - CONCENTRATED: ≥ 15% of the holdings book at cost
 *  - STRONG:       LTP > 50-DMA AND (50-DMA > 200-DMA, or 6-month return > 0) AND P&L ≥ 0
 * Primary tag = first of DEAD-MONEY, WEAK-TREND, CONCENTRATED, STRONG present, else NEUTRAL.
 */
export function holdingTags(h: Pick<HoldingCheck, 'pnlPct' | 'daysHeld' | 'sharePct' | 'ltp' | 'trend'>): HoldingTag[] {
  const tags: HoldingTag[] = [];
  const t = h.trend;
  if (h.pnlPct <= HOLDING_RULES.deadLossPct && h.daysHeld >= HOLDING_RULES.deadMinDays) tags.push('DEAD-MONEY');
  if (t.status === 'OK' && h.ltp !== null && t.dma50 !== null) {
    const longWeak = t.dma200 !== null ? h.ltp < t.dma200 : (t.ret6m ?? 0) < 0;
    if (h.ltp < t.dma50 && longWeak) tags.push('WEAK-TREND');
    const longStrong = t.dma200 !== null ? t.dma50 > t.dma200 : (t.ret6m ?? 0) > 0;
    if (h.ltp > t.dma50 && longStrong && h.pnlPct >= 0) tags.push('STRONG');
  }
  if (h.sharePct >= HOLDING_RULES.concentratedSharePct) tags.push('CONCENTRATED');
  return TAG_PRIORITY.filter((x) => tags.includes(x));
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

function noteFor(h: HoldingCheck): string {
  const parts: string[] = [];
  const t = h.trend;
  if (h.tag === 'DEAD-MONEY') parts.push(`${h.pnlPct}% after ≥${h.daysHeld} days — decide: exit, or set a stop and a review date`);
  if (h.tags.includes('WEAK-TREND')) parts.push(`below its 50-DMA (${t.dma50})${t.dma200 !== null ? ` and 200-DMA (${t.dma200})` : ''}`);
  if (h.tags.includes('CONCENTRATED')) parts.push(`${h.sharePct}% of the holdings book — one bad move here moves the whole portfolio`);
  if (h.tags.includes('STRONG')) parts.push('in profit and above its averages — a trailing stop protects the gain');
  if (t.status === 'NO_DATA') parts.push(`trend unavailable (${t.reason ?? 'no candles'})`);
  if (h.averagedDown) parts.push('averaged down while in loss');
  if (parts.length === 0) parts.push(`${h.pnlPct >= 0 ? '+' : ''}${h.pnlPct}% (${inr(h.pnl)}); no rule fired`);
  return parts.join('; ');
}

/** One check per open HOLDING episode. `trends` is keyed by token. Pure. */
export function holdingChecks(episodes: Episode[], trends: Map<string, HoldingTrend>, now: Date): HoldingCheck[] {
  const open = episodes.filter((e) => e.kind === 'HOLDING' && e.status === 'OPEN' && e.role === 'TRADE');
  const book = open.reduce((s, e) => s + e.entryPrice * e.qty, 0);
  return open
    .map((e) => {
      const cost = e.entryPrice * e.qty;
      const value = e.ltp !== null ? e.ltp * e.qty : null;
      const pnl = e.unrealised;
      const base = {
        symbol: e.symbol,
        exchange: e.exchange,
        token: e.token,
        qty: e.qty,
        avgCost: e.entryPrice,
        cost: round2(cost),
        ltp: e.ltp,
        value: value !== null ? round2(value) : null,
        pnl: round2(pnl),
        pnlPct: cost > 0 ? round1((pnl / cost) * 100) : 0,
        daysHeld: Math.floor((now.getTime() - Date.parse(e.firstEntry)) / DAY_MS),
        firstTracked: istDay(new Date(e.firstEntry)),
        sharePct: book > 0 ? round1((cost / book) * 100) : 0,
        averagedDown: e.averagedDown,
        trend: trends.get(e.token) ?? NO_TREND('not fetched'),
      };
      const tags = holdingTags(base);
      const check: HoldingCheck = { ...base, tags, tag: tags[0] ?? 'NEUTRAL', note: '' };
      check.note = noteFor(check);
      return check;
    })
    .sort((a, b) => a.pnl - b.pnl);
}
