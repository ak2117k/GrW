/**
 * M0 (news-events v2 §4.1/§17): probe every RSS source + replacement candidate with the
 * production UA and timeout, and (with --nse) the NSE endpoints, saving trimmed fixtures.
 * Usage: cd apps/api && npx tsx scripts/news-source-check.ts [--nse]
 * Prints one row per URL; KEEP = HTTP 200 + XML + ≥1 <item> + newest pubDate within 7 days.
 * Read-only GETs, one request per URL (NSE: plus one homepage warm-up after a 401/403).
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { REMOVED_SOURCES, RSS_FETCH_TIMEOUT_MS, rssSources } from '../src/modules/news/services/news-aggregator.service';
import { NseClient, NSE_BROWSER_UA } from '../src/modules/news-events/nse-client';

/**
 * Replacement candidates. The 2026-10-16 run kept the four marked (now in RSS_SOURCES);
 * the rest stay here so a re-run on the VPS (Production Gate) re-checks them.
 */
const CANDIDATES = [
  { name: 'Business Standard Markets', url: 'https://www.business-standard.com/rss/markets-106.rss' },
  { name: 'Business Standard Companies', url: 'https://www.business-standard.com/rss/companies-101.rss' },
  { name: 'ET Markets Stocks', url: 'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms' },
  { name: 'Hindu BusinessLine Markets', url: 'https://www.thehindubusinessline.com/markets/feeder/default.rss' },
  { name: 'Hindu BusinessLine Commodities', url: 'https://www.thehindubusinessline.com/markets/commodities/feeder/default.rss' },
  { name: 'Investing.com Commodities', url: 'https://www.investing.com/rss/news_11.rss' },
];

/** The sources removed in M0, with their old URLs, so a re-run shows whether they came back. */
const REMOVED_URLS: Record<string, string> = {
  'Reuters Business': 'https://www.reutersagency.com/feed/?best-topics=business-finance',
  'ET Earnings': 'https://economictimes.indiatimes.com/markets/stocks/earnings/rssfeeds/12aborede_2.cms',
};

async function probe(name: string, url: string): Promise<void> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': NSE_BROWSER_UA, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(RSS_FETCH_TIMEOUT_MS),
    });
    const body = await res.text();
    const items = (body.match(/<item[\s>]/gi) ?? []).length;
    // LiveMint and BusinessLine wrap pubDate in CDATA; the aggregator's extractTag reads both forms.
    const dates = [...body.matchAll(/<pubDate>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/pubDate>/gi)]
      .map((m) => Date.parse(m[1]))
      .filter(Number.isFinite);
    const newest = dates.length ? new Date(Math.max(...dates)).toISOString() : '-';
    const xml = /xml/i.test(res.headers.get('content-type') ?? '') || /^\s*<\?xml|<rss/i.test(body);
    const fresh = dates.length > 0 && Date.now() - Math.max(...dates) < 7 * 86_400_000;
    const keep = res.status === 200 && xml && items > 0 && fresh;
    console.log([name, url, res.status, res.headers.get('content-type'), items, newest, `${Date.now() - t0}ms`, keep ? 'KEEP' : 'REMOVE'].join(' | '));
  } catch (err) {
    console.log([name, url, 'ERR', err instanceof Error ? err.message : String(err), 0, '-', `${Date.now() - t0}ms`, 'REMOVE'].join(' | '));
  }
}

async function nse(): Promise<void> {
  const dir = join(__dirname, '..', 'src', 'modules', 'news-events', '__fixtures__');
  mkdirSync(dir, { recursive: true });
  const c = new NseClient({ log: (l) => console.log(l) });
  const ddmmyyyy = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
  const now = new Date();
  const jobs: Array<[string, string, string]> = [
    ['nse-announcements.json', 'NSE corporate-announcements', 'https://www.nseindia.com/api/corporate-announcements?index=equities'],
    ['nse-event-calendar.json', 'NSE event-calendar', 'https://www.nseindia.com/api/event-calendar?index=equities'],
    ['nse-corporate-actions.json', 'NSE corporate-actions',
      `https://www.nseindia.com/api/corporates-corporateActions?index=equities&from_date=${ddmmyyyy(now)}&to_date=${ddmmyyyy(new Date(now.getTime() + 14 * 86_400_000))}`],
  ];
  for (const [file, label, url] of jobs) {
    try {
      const j = await c.getJson(label, url);
      const arr = Array.isArray(j) ? j : Array.isArray((j as { data?: unknown[] }).data) ? (j as { data: unknown[] }).data : [];
      writeFileSync(join(dir, file), JSON.stringify(arr.slice(0, 5), null, 2) + '\n');
      console.log(`${label}: ${arr.length} rows (5 saved to ${file})`);
    } catch (err) {
      console.log(`${label}: FAILED ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    const csv = await c.getText('NSE EQUITY_L', 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv');
    const lines = csv.split(/\r?\n/);
    writeFileSync(join(dir, 'equity-l.csv'), lines.slice(0, 6).join('\n') + '\n');
    console.log(`EQUITY_L: ${lines.length - 1} rows (header + 5 saved to equity-l.csv)`);
  } catch (err) {
    console.log(`EQUITY_L: FAILED ${err instanceof Error ? err.message : String(err)}`);
  }
}

(async () => {
  for (const s of rssSources()) await probe(s.name, s.url);
  for (const s of CANDIDATES) await probe(`candidate: ${s.name}`, s.url);
  for (const r of REMOVED_SOURCES) if (REMOVED_URLS[r]) await probe(`removed: ${r}`, REMOVED_URLS[r]);
  if (process.argv.includes('--nse')) await nse();
})();
