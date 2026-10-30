import { instrumentHits } from '../../signal-intake/domain/prefilter';
import { normalise } from '../../signal-intake/domain/text';
import { buildVocabulary, LOOSE_STOPWORDS } from '../../signal-intake/domain/vocabulary';

/**
 * Advisor research mode (owner 2026-10-27: "research IDEA OI for next month" was refused — the advisor
 * had no market data). Pure: the intent, the expiry choice, the chain / build-up summaries and the
 * text block. The data is fetched server-side over the owner's own Angel session before ONE
 * subscription (CLI) call, so no API tool use is needed.
 */

const RESEARCH_RE =
  /\b(RESEARCH|ANALY[SZ]E|ANALYSIS|OI|OPEN INTEREST|OPTION CHAIN|CHAIN|PCR|MAX PAIN|BUILD ?UP|BUILDUP|OUTLOOK|ROLLOVER|STUDY|DEEP ?DIVE|CHARTS?|PATTERNS?|CANDLES?|CANDLESTICKS?|TREND|TRENDLINES?|TECHNICALS?|PRICE HISTORY|PRICE ACTION|SUPPORT|RESISTANCE)\b/;
const NEXT_RE = /\b(NEXT (MONTH|EXPIRY|SERIES)|MONTHLY|NOVEMBER|DECEMBER|FAR MONTH)\b/;

export interface ResearchIntent {
  symbol: string;
  /** 'next' = the expiry after the nearest one ("next month"). */
  expiry: 'current' | 'next';
}

/**
 * A research question about ONE F&O underlying, or null. `underlyings` = the derivative names the
 * contract master lists (IDEA, NIFTY, GOLD …); company names and nicknames resolve through the same
 * vocabulary the Telegram reader uses.
 */
export function researchIntent(question: string, underlyings: readonly string[]): ResearchIntent | null {
  const upper = ` ${String(question ?? '').toUpperCase()} `;
  if (!RESEARCH_RE.test(upper)) return null;
  const vocab = buildVocabulary(underlyings);
  const t = normalise(question, vocab).tokens;
  // Index / commodity aliases resolve to their canonical name (BANK NIFTY → BANKNIFTY), which the master lists too.
  // Inside a research question a word-like symbol counts on its own ("idea oi next month" is IDEA).
  const hit =
    instrumentHits(t, vocab).find((h) => underlyings.includes(h.name))?.name ??
    t.map((w) => vocab.names.get(w)).find((n): n is string => !!n && underlyings.includes(n) && !LOOSE_STOPWORDS.has(n));
  if (!hit) return null;
  return { symbol: hit, expiry: NEXT_RE.test(upper) ? 'next' : 'current' };
}

/** The live expiries (YYYY-MM-DD, ascending) → the one the question asks for. */
export function pickExpiry(expiries: readonly string[], want: 'current' | 'next'): string | null {
  const sorted = [...new Set(expiries)].sort();
  return (want === 'next' ? sorted[1] : sorted[0]) ?? sorted[0] ?? null;
}

export interface StrikeRow {
  strike: number;
  ceOi: number | null;
  peOi: number | null;
  ceLtp: number | null;
  peLtp: number | null;
}

export interface ChainSummary {
  strikes: number;
  ceOi: number;
  peOi: number;
  pcr: number | null;
  maxPain: number | null;
  /** Biggest call OI at / above spot (resistance) and put OI at / below it (support). */
  callWall: number | null;
  putWall: number | null;
  topCalls: Array<{ strike: number; oi: number }>;
  topPuts: Array<{ strike: number; oi: number }>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function chainSummary(rows: readonly StrikeRow[], spot: number | null): ChainSummary {
  const ok = rows.filter((r) => r.strike > 0);
  const ceOi = ok.reduce((a, r) => a + (r.ceOi ?? 0), 0);
  const peOi = ok.reduce((a, r) => a + (r.peOi ?? 0), 0);
  // Max pain: the expiry price at which option writers pay out the least.
  let maxPain: number | null = null;
  let least = Infinity;
  for (const p of ok) {
    const pay = ok.reduce((a, r) => a + (r.ceOi ?? 0) * Math.max(0, p.strike - r.strike) + (r.peOi ?? 0) * Math.max(0, r.strike - p.strike), 0);
    if (pay < least) {
      least = pay;
      maxPain = p.strike;
    }
  }
  const top = (k: 'ceOi' | 'peOi', keep: (s: number) => boolean) =>
    ok.filter((r) => (r[k] ?? 0) > 0 && keep(r.strike)).sort((a, b) => (b[k] ?? 0) - (a[k] ?? 0)).slice(0, 3).map((r) => ({ strike: r.strike, oi: r[k] as number }));
  const above = (s: number) => spot === null || s >= spot;
  const below = (s: number) => spot === null || s <= spot;
  const calls = top('ceOi', above);
  const puts = top('peOi', below);
  return {
    strikes: ok.length,
    ceOi,
    peOi,
    pcr: ceOi > 0 ? r2(peOi / ceOi) : null,
    maxPain: ok.length ? maxPain : null,
    callWall: calls[0]?.strike ?? null,
    putWall: puts[0]?.strike ?? null,
    topCalls: calls,
    topPuts: puts,
  };
}

export type Buildup = 'LONG_BUILDUP' | 'SHORT_BUILDUP' | 'SHORT_COVERING' | 'LONG_UNWINDING' | 'FLAT';

export interface BuildupDay {
  date: string;
  close: number;
  oi: number;
  pricePct: number;
  oiPct: number;
  kind: Buildup;
}

/** Price vs OI per session (futures): up+up long build-up, down+up short build-up, up+down covering, down+down unwinding. */
export function buildupSeries(days: ReadonlyArray<{ date: string; close: number; oi: number }>): BuildupDay[] {
  const s = [...days].filter((d) => d.close > 0 && d.oi > 0).sort((a, b) => a.date.localeCompare(b.date));
  const out: BuildupDay[] = [];
  for (let i = 1; i < s.length; i++) {
    const pricePct = r2(((s[i].close - s[i - 1].close) / s[i - 1].close) * 100);
    const oiPct = r2(((s[i].oi - s[i - 1].oi) / s[i - 1].oi) * 100);
    const flat = Math.abs(oiPct) < 0.5;
    const kind: Buildup = flat ? 'FLAT' : pricePct >= 0 ? (oiPct > 0 ? 'LONG_BUILDUP' : 'SHORT_COVERING') : oiPct > 0 ? 'SHORT_BUILDUP' : 'LONG_UNWINDING';
    out.push({ date: s[i].date, close: s[i].close, oi: s[i].oi, pricePct, oiPct, kind });
  }
  return out;
}

export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PriceHistory {
  /** Which line the bars are from (the cash stock, else the future). */
  source: string;
  sessions: number;
  last: number;
  ema20: number | null;
  ema50: number | null;
  /** Close vs EMA20 / EMA50 and the EMA20 slope over 5 sessions. */
  trend: 'UP' | 'DOWN' | 'SIDEWAYS';
  changePct: { d5: number | null; d20: number | null; d60: number | null };
  range20: { high: number; low: number } | null;
  range60: { high: number; low: number } | null;
  /** Recent swing pivots (a high / low beaten by the 2 sessions on each side), newest last. */
  swingHighs: Array<{ date: string; price: number }>;
  swingLows: Array<{ date: string; price: number }>;
  /** The last 15 daily candles, for pattern reading. */
  recent: Bar[];
  /** Today's 15-minute candles (empty off-session or when unavailable). */
  intraday: Bar[];
}

function ema(values: readonly number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}

const pct = (a: number | undefined, b: number | undefined) => (a && b ? r2(((b - a) / a) * 100) : null);

/**
 * Advisor price history (owner 2026-10-30: "it says it can't pull price history"): daily candles → trend,
 * ranges, swing pivots and the last 15 bars, so the advisor reads the chart instead of declining. Pure;
 * facts only — the advisor reads the pattern, this never forecasts.
 */
export function priceHistory(daily: readonly Bar[], intraday: readonly Bar[], source: string): PriceHistory | null {
  const d = [...daily].filter((b) => b.close > 0 && b.high >= b.low).sort((a, b) => a.date.localeCompare(b.date));
  if (d.length < 5) return null;
  const closes = d.map((b) => b.close);
  const e20 = d.length >= 20 ? ema(closes, 20) : null;
  const e50 = d.length >= 50 ? ema(closes, 50) : null;
  const last = closes[closes.length - 1];
  const lastE20 = e20 ? e20[e20.length - 1] : null;
  const lastE50 = e50 ? e50[e50.length - 1] : null;
  const slope = e20 && e20.length > 5 ? e20[e20.length - 1] - e20[e20.length - 6] : 0;
  const trend: PriceHistory['trend'] =
    lastE20 !== null && last > lastE20 && slope > 0 && (lastE50 === null || lastE20 > lastE50) ? 'UP'
      : lastE20 !== null && last < lastE20 && slope < 0 && (lastE50 === null || lastE20 < lastE50) ? 'DOWN'
        : 'SIDEWAYS';
  const range = (n: number) => {
    const s = d.slice(-n);
    return s.length >= n ? { high: Math.max(...s.map((b) => b.high)), low: Math.min(...s.map((b) => b.low)) } : null;
  };
  const swingHighs: PriceHistory['swingHighs'] = [];
  const swingLows: PriceHistory['swingLows'] = [];
  for (let i = 2; i < d.length - 2; i++) {
    const w = [d[i - 2], d[i - 1], d[i + 1], d[i + 2]];
    if (w.every((b) => b.high < d[i].high)) swingHighs.push({ date: d[i].date, price: d[i].high });
    if (w.every((b) => b.low > d[i].low)) swingLows.push({ date: d[i].date, price: d[i].low });
  }
  const at = (back: number) => closes[closes.length - 1 - back];
  return {
    source,
    sessions: d.length,
    last,
    ema20: lastE20 === null ? null : r2(lastE20),
    ema50: lastE50 === null ? null : r2(lastE50),
    trend,
    changePct: { d5: pct(at(5), last), d20: pct(at(20), last), d60: pct(at(60), last) },
    range20: range(20),
    range60: range(60),
    swingHighs: swingHighs.slice(-3),
    swingLows: swingLows.slice(-3),
    recent: d.slice(-15),
    intraday: [...intraday].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export interface ResearchData {
  symbol: string;
  expiry: string | null;
  spot: number | null;
  spotSource: string;
  lotSize: number | null;
  chain: ChainSummary | null;
  futures: { tradingsymbol: string; ltp: number | null; oi: number | null; days: BuildupDay[] } | null;
  levels: { support: number | null; resistance: number | null; trend: number | null } | null;
  price?: PriceHistory | null;
  news: string[];
  /** What could not be read (stated in the note, never guessed). */
  missing: string[];
  at: string;
}

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? 'n/a' : n.toLocaleString('en-IN'));

/** The <research> block of the advisor's user turn. */
export function renderResearch(d: ResearchData): string {
  const lines: string[] = [
    `symbol: ${d.symbol} | expiry: ${d.expiry ?? 'n/a'} | spot: ${fmt(d.spot)} (${d.spotSource || 'n/a'}) | lot: ${fmt(d.lotSize)} | as of ${d.at}`,
  ];
  if (d.chain) {
    const c = d.chain;
    lines.push(
      `option chain (${c.strikes} strikes around spot): call OI ${fmt(c.ceOi)}, put OI ${fmt(c.peOi)}, PCR ${c.pcr ?? 'n/a'}, max pain ${fmt(c.maxPain)}`,
      `call walls (resistance): ${c.topCalls.map((x) => `${x.strike} (${fmt(x.oi)})`).join(', ') || 'none'}`,
      `put walls (support): ${c.topPuts.map((x) => `${x.strike} (${fmt(x.oi)})`).join(', ') || 'none'}`,
    );
  }
  if (d.futures) {
    const f = d.futures;
    lines.push(`future ${f.tradingsymbol}: LTP ${fmt(f.ltp)}, OI ${fmt(f.oi)}`);
    const last = f.days.slice(-10);
    if (last.length) {
      lines.push('futures price vs OI, last sessions (date close price% OI% read):');
      for (const x of last) lines.push(`  ${x.date} ${x.close} ${x.pricePct}% ${x.oiPct}% ${x.kind.toLowerCase().replace('_', ' ')}`);
      const counts = last.reduce<Record<string, number>>((a, x) => ({ ...a, [x.kind]: (a[x.kind] ?? 0) + 1 }), {});
      lines.push(`  tally: ${Object.entries(counts).map(([k, n]) => `${k.toLowerCase().replace('_', ' ')} ${n}`).join(', ')}`);
    }
  }
  if (d.price) {
    const p = d.price;
    const bar = (b: Bar) => `  ${b.date} O ${b.open} H ${b.high} L ${b.low} C ${b.close}${b.volume ? ` V ${fmt(b.volume)}` : ''}`;
    const rg = (r: { high: number; low: number } | null) => (r ? `${r.low}–${r.high}` : 'n/a');
    lines.push(
      `price history (${p.source}, ${p.sessions} daily sessions): last ${p.last}, EMA20 ${p.ema20 ?? 'n/a'}, EMA50 ${p.ema50 ?? 'n/a'}, trend ${p.trend.toLowerCase()}`,
      `  change: 5d ${p.changePct.d5 ?? 'n/a'}%, 20d ${p.changePct.d20 ?? 'n/a'}%, 60d ${p.changePct.d60 ?? 'n/a'}% | 20-session range ${rg(p.range20)} | 60-session range ${rg(p.range60)}`,
      `  swing highs: ${p.swingHighs.map((s) => `${s.price} (${s.date})`).join(', ') || 'none'} | swing lows: ${p.swingLows.map((s) => `${s.price} (${s.date})`).join(', ') || 'none'}`,
      'last daily candles:',
      ...p.recent.map(bar),
    );
    if (p.intraday.length) lines.push("today's 15-minute candles:", ...p.intraday.map(bar));
  }
  if (d.levels) lines.push(`level book: support ${fmt(d.levels.support)}, resistance ${fmt(d.levels.resistance)}, higher-TF trend ${d.levels.trend === null ? 'n/a' : d.levels.trend > 0 ? 'up' : d.levels.trend < 0 ? 'down' : 'flat'}`);
  if (d.news.length) lines.push('recent news:', ...d.news.slice(0, 5).map((n) => `  - ${n}`));
  if (d.missing.length) lines.push(`NOT AVAILABLE (say so, do not guess): ${d.missing.join('; ')}`);
  return lines.join('\n');
}
