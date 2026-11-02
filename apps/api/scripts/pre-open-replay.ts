/**
 * Pre-open outlook replay. Offline only; never runs in the API and never touches a database, a
 * broker or the network.
 *
 *   npx tsx apps/api/scripts/pre-open-replay.ts <entry-fixture.real.json> --at <ISO> \
 *     [--chart <yahoo-chart.json>]... [--clusters <clusters.json>] [--out <bias.json>]
 *
 * The entry fixture (entry-engine/replay/sql/export-entry-fixture.sql, 72 h of impacts) gives the
 * line's 1-minute bars (→ the last close before the day's open) and the impacts (→ the news theme,
 * only those READ by --at). --chart: Yahoo v8 chart JSON (interval=1h, range=5d / 1mo) of the global
 * symbols in the underlying's order (CL=F, BZ=F for crude); only bars that had ENDED by --at count.
 * --clusters: [{ id, headline, firstSeen, createdAt }] for the headline-move fallback (clusters that
 * existed by --at). Prints the outlook; --out writes the bias the entry engine would read
 * (for scripts/entry-replay.ts --pre-open).
 */
import { readFileSync, writeFileSync } from 'fs';
import { istDayAt } from '../src/modules/entry-engine/domain/engine-inputs';
import type { ImpactRow } from '../src/modules/entry-engine/domain/entry-decision';
import { headlineAbout, NEWS_THEME, newsTheme } from '../src/modules/entry-engine/domain/news-theme';
import type { EntryFixtureV1 } from '../src/modules/entry-engine/replay/replay-entry';
import { chartMove, parseYahooChart, type GlobalChart } from '../src/modules/pre-open-outlook/domain/global-chart';
import { inSession, OUTLOOK_UNIVERSE, outlookOf, parseHeadlineMove, preOpenWindowMin, type HeadlineMove } from '../src/modules/pre-open-outlook/domain/outlook';

/* eslint-disable no-console */
const zoned = (s: string) => (/(Z|[+-]\d\d:?\d\d)$/i.test(s) ? s : `${s}Z`);
const MIN = 60_000;

function args(argv: string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === name && argv[i + 1]) out.push(argv[i + 1]);
  });
  return out;
}

function main(argv: string[]): number {
  const file = argv.find((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')));
  const atArg = args(argv, '--at')[0];
  if (!file || !atArg) {
    console.error('Usage: npx tsx apps/api/scripts/pre-open-replay.ts <entry-fixture.real.json> --at <ISO> [--chart <json>]... [--clusters <json>] [--out <json>]');
    return 1;
  }
  const at = new Date(atArg);
  const fx = JSON.parse(readFileSync(file, 'utf8')) as EntryFixtureV1;
  const u = fx.underlying.toUpperCase();
  const entry = OUTLOOK_UNIVERSE[u];
  if (!entry) {
    console.error(`no outlook universe entry for ${u}`);
    return 1;
  }
  const open = istDayAt(at, entry.openMin).getTime();
  const bars = [...fx.hubBars, ...fx.tableBars].map((b) => ({ t: new Date(zoned(b.t)).getTime(), c: Number(b.c) })).filter((b) => b.t < open && b.c > 0 && inSession(b.t, entry.openMin, entry.closeMin)).sort((a, b) => a.t - b.t);
  const last = bars[bars.length - 1];
  const lastClose = last ? { price: last.c, at: new Date(last.t + MIN).toISOString() } : null;
  const closeT = lastClose ? new Date(lastClose.at) : null;

  const charts: GlobalChart[] = args(argv, '--chart').map((f) => {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return parseYahooChart(j, String(j?.chart?.result?.[0]?.meta?.symbol ?? f));
  });
  let move = null as ReturnType<typeof chartMove> & { beta: number } | null;
  for (const sym of entry.globals) {
    const c = charts.find((x) => x.symbol === sym);
    if (!c || !closeT) continue;
    // Replay: the meta "last price" is the fetch-time quote (look-ahead) — bars only.
    const m = chartMove({ ...c, price: null, priceAt: null }, closeT.getTime(), at.getTime(), `Yahoo chart ${sym} (bars, replay)`);
    move = { ...m, beta: entry.beta[sym] ?? 1 };
    if (m.status !== 'NO_DATA') break;
  }

  const windowMin = preOpenWindowMin(at, closeT, NEWS_THEME.preOpen.windowMin, NEWS_THEME.preOpen.maxWindowMin);
  const impacts: ImpactRow[] = fx.impacts.map((r) => ({ ...r, analysedAt: new Date(zoned(r.analysedAt)), firstSeen: new Date(zoned(r.firstSeen)), symbols: r.symbols ?? [], sectors: r.sectors ?? [] }));
  const theme = newsTheme(impacts, u, at, { windowMin, halfLifeMin: NEWS_THEME.preOpen.halfLifeMin });

  const clustersFile = args(argv, '--clusters')[0];
  const clusters: Array<{ id: string; headline: string; firstSeen: string; createdAt?: string }> = clustersFile ? JSON.parse(readFileSync(clustersFile, 'utf8')) : [];
  const from = closeT?.getTime() ?? at.getTime() - 24 * 60 * MIN;
  const headlineMoves = clusters
    .filter((c) => new Date(zoned(c.firstSeen)).getTime() > from && new Date(zoned(c.createdAt ?? c.firstSeen)).getTime() <= at.getTime())
    .filter((c) => headlineAbout(u, c.headline))
    .map((c) => parseHeadlineMove(u, c.id, c.headline))
    .filter((x): x is HeadlineMove => x !== null);

  const o = outlookOf({ underlying: u, sessionDate: new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10), at, lastClose, move, theme, headlineMoves });
  console.log(o.summary);
  console.log(JSON.stringify({ bias: o.bias, confidence: o.confidence, score: o.score, components: o.components, gap: o.gap, lastClose: o.lastClose, global: o.global, theme: o.theme, headlineMoves: o.headlineMoves, headlines: o.headlines }, null, 2));
  const out = args(argv, '--out')[0];
  if (out) writeFileSync(out, JSON.stringify({ underlying: o.underlying, sessionDate: o.sessionDate, bias: o.bias, confidence: o.confidence, at: o.at, summary: o.summary }, null, 2));
  return 0;
}

process.exitCode = main(process.argv.slice(2));
