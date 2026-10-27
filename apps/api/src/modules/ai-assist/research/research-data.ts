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
  /\b(RESEARCH|ANALY[SZ]E|ANALYSIS|OI|OPEN INTEREST|OPTION CHAIN|CHAIN|PCR|MAX PAIN|BUILD ?UP|BUILDUP|OUTLOOK|ROLLOVER|STUDY|DEEP ?DIVE)\b/;
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

export interface ResearchData {
  symbol: string;
  expiry: string | null;
  spot: number | null;
  spotSource: string;
  lotSize: number | null;
  chain: ChainSummary | null;
  futures: { tradingsymbol: string; ltp: number | null; oi: number | null; days: BuildupDay[] } | null;
  levels: { support: number | null; resistance: number | null; trend: number | null } | null;
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
  if (d.levels) lines.push(`level book: support ${fmt(d.levels.support)}, resistance ${fmt(d.levels.resistance)}, higher-TF trend ${d.levels.trend === null ? 'n/a' : d.levels.trend > 0 ? 'up' : d.levels.trend < 0 ? 'down' : 'flat'}`);
  if (d.news.length) lines.push('recent news:', ...d.news.slice(0, 5).map((n) => `  - ${n}`));
  if (d.missing.length) lines.push(`NOT AVAILABLE (say so, do not guess): ${d.missing.join('; ')}`);
  return lines.join('\n');
}
