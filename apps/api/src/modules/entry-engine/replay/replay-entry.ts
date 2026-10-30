/**
 * Entry engine replay (stage 1 proof). Pure and deterministic: walks one underlying-day fixture
 * exported from prod (sql/export-entry-fixture.sql → fixtures/*.real.json, git-ignored) on the live
 * cron's cadence (IST :05 / :20 / :35 / :50 inside 09:20–23:00 and before the close) and runs the
 * SAME functions the service runs — newsReading, chooseBars + trendReading, readOi (signal-trader
 * oiCheck), entryDecision, entryGuards — with only the data the app had at each step (impacts the
 * model had READ by then, closed bars, OI snapshots ≤ the step). It does not simulate exits: an
 * entry counts as open for the rest of the day (the per-underlying cooldown).
 */
import type { ChainContractRef, OiCheckInput, OiRow } from '../../signal-trader/domain/oi-check';
import { entryDecision, entryGuards, newsReading, trendReading, type Bar1m, type EntryDecision, type GuardResult, type ImpactRow, type NewsReading, type OiReading, type TrendReading } from '../domain/entry-decision';
import { chooseBars, ENGINE_WINDOW, istMinutes, readOi, sessionStartOf, wantFor } from '../domain/engine-inputs';

export interface EntryFixtureV1 {
  v: 1;
  underlying: string;
  /** IST trading day YYYY-MM-DD. */
  date: string;
  line: { exchange: string; token: string };
  optionExchange: string;
  exportedAt?: string;
  impacts: Array<Omit<ImpactRow, 'analysedAt' | 'firstSeen'> & { analysedAt: string; firstSeen: string }>;
  hubBars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>;
  tableBars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>;
  chain: { expiry: string; contracts: ChainContractRef[]; rows: Array<{ i: string; oi: number; t: string }> } | null;
  futures: { instrumentId: string; symbol: string; rows: Array<{ oi: number; t: string }>; prices: Array<{ close: number; t: string }> | null } | null;
}

export interface ReplayStep {
  at: string;
  ist: string;
  decision: EntryDecision;
  guards: GuardResult;
  /** ENTER and every cooldown passed: paper mode would have opened a trade here. */
  wouldOpen: boolean;
  news: NewsReading;
  trend: TrendReading & { barSource: string };
  oi: OiReading;
}

const MIN = 60_000;
const zoned = (s: string) => (/(Z|[+-]\d\d:?\d\d)$/i.test(s) ? s : `${s}Z`);
const toDate = (s: string) => new Date(zoned(s));
const toBars = (xs: EntryFixtureV1['hubBars']): Bar1m[] => xs.map((b) => ({ ts: toDate(b.t).getTime(), open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v ?? 0) }));

/** The session's close (IST minutes): MCX 23:30 (US daylight time; 23:55 in winter), else 15:30. */
export function closeMinOf(optionExchange: string, date: string): number {
  if (String(optionExchange).toUpperCase() !== 'MCX') return 15 * 60 + 30;
  // MCX closes 23:55 while the US is on standard time (first Sunday of Nov → second Sunday of Mar).
  const d = new Date(`${date}T12:00:00Z`);
  const y = d.getUTCFullYear();
  const firstSunNov = 1 + ((7 - new Date(Date.UTC(y, 10, 1)).getUTCDay()) % 7);
  const secondSunMar = 8 + ((7 - new Date(Date.UTC(y, 2, 1)).getUTCDay()) % 7);
  const day = d.getTime();
  const winter = day >= Date.UTC(y, 10, firstSunNov) || day < Date.UTC(y, 2, secondSunMar);
  return winter ? 23 * 60 + 55 : 23 * 60 + 30;
}

/** The cron's step times for the fixture's day. */
export function stepTimes(fx: Pick<EntryFixtureV1, 'date' | 'optionExchange'>): Date[] {
  const close = closeMinOf(fx.optionExchange, fx.date);
  const out: Date[] = [];
  for (let m = 9 * 60 + 5; m <= 23 * 60 + 50; m += 15) {
    if (m < ENGINE_WINDOW.fromMin || m > ENGINE_WINDOW.toMin || m >= close) continue;
    out.push(new Date(new Date(`${fx.date}T00:00:00+05:30`).getTime() + m * MIN));
  }
  return out;
}

export function replayEntry(fx: EntryFixtureV1): ReplayStep[] {
  const impacts: ImpactRow[] = fx.impacts.map((r) => ({ ...r, analysedAt: toDate(r.analysedAt), firstSeen: toDate(r.firstSeen), symbols: r.symbols ?? [], sectors: r.sectors ?? [] }));
  const hub = toBars(fx.hubBars);
  const table = toBars(fx.tableBars);
  const chainRows: OiRow[] = (fx.chain?.rows ?? []).map((r) => ({ instrumentId: r.i, oi: Number(r.oi), at: toDate(r.t) }));
  const futRows: OiRow[] = (fx.futures?.rows ?? []).map((r) => ({ instrumentId: fx.futures!.instrumentId, oi: Number(r.oi), at: toDate(r.t) }));
  const futPrices = (fx.futures?.prices ?? []).map((p) => ({ at: toDate(p.t), close: Number(p.close) }));
  const close = closeMinOf(fx.optionExchange, fx.date);
  const steps: ReplayStep[] = [];
  let opened = 0;
  for (const at of stepTimes(fx)) {
    const t = at.getTime();
    const sessionStart = sessionStartOf(fx.optionExchange, at);
    const news = newsReading(impacts, fx.underlying, at);
    const chosen = chooseBars(hub, table, sessionStart, at);
    const trend = trendReading(chosen.bars, at, sessionStart);
    const want = wantFor(news, trend);
    const input: OiCheckInput = {
      at,
      want,
      sessionStart,
      chain: fx.chain
        ? { expiry: fx.chain.expiry, contracts: fx.chain.contracts.map((c) => ({ ...c, strike: Number(c.strike) })), rows: chainRows.filter((r) => r.at.getTime() <= t), center: trend.price, centerSource: `trend price (${chosen.source})` }
        : null,
      futures: fx.futures
        ? { instrumentId: fx.futures.instrumentId, symbol: fx.futures.symbol, rows: futRows.filter((r) => r.at.getTime() <= t), prices: futPrices.filter((p) => p.at.getTime() <= t), priceSource: `oi_snapshots.ltp ${fx.futures.symbol}` }
        : null,
    };
    const oi = readOi(input);
    const decision = entryDecision({ underlying: fx.underlying, at, news, trend, oi });
    const guards = entryGuards({ openForUnderlying: opened, tradesToday: opened, minutesToClose: close - istMinutes(at) });
    const wouldOpen = decision.action !== 'NO_TRADE' && guards.ok;
    if (wouldOpen) opened++;
    const ist = new Date(t + 5.5 * 3_600_000).toISOString().slice(11, 16);
    steps.push({ at: at.toISOString(), ist, decision, guards, wouldOpen, news, trend: { ...trend, barSource: chosen.source }, oi });
  }
  return steps;
}

const pct = (x: number | null) => (x === null ? '   n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`);
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/** One line per step for the console. */
export function formatStep(s: ReplayStep): string {
  const d = s.decision.scores;
  const news = `${d.newsLean}${d.newsMaterial ? '*' : ''} ${d.news >= 0 ? '+' : ''}${d.news.toFixed(2)}`;
  const trend = `${d.trendLean} vwap ${pct(d.vwapPct)} 15m ${pct(d.ema15Slope)} 1h ${pct(d.ema1hSlope)}`;
  const oi = `${d.oiVerdict}→${s.oi.want.slice(0, 4)} (${d.oiLean}) 30m ${pct(d.chainLeanAgo)} open ${pct(d.chainLeanOpen)} fut ${d.futuresVerdict}`;
  return `${s.ist}  ${pad(s.decision.action, 8)}${s.wouldOpen ? ' OPEN' : '     '}  news ${pad(news, 16)} | trend ${pad(trend, 52)} | oi ${oi}`;
}
